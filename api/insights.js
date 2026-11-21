// /api/insights – viết phần "Phân tích & đề xuất" bằng Claude từ số liệu đang lưu, rồi ghi tài liệu `insights`.
//   GET  – Vercel Cron (Authorization: Bearer <CRON_SECRET>), chạy sau đồng bộ buổi sáng
//   POST – quản trị bấm "Viết lại phân tích" (Bearer <Firebase ID token>, email trong FBADS_ADMINS)
//   ?dry=1 – viết nhưng KHÔNG ghi (xem thử)
// Cần ANTHROPIC_API_KEY. Mặt bằng ngành lấy từ benchmarks.js (nguồn và ngày ghi trong tệp).
import { authorize } from '../server/auth.js';
import { send, safeError } from '../server/http.js';

const TIMEOUT_MS = 240000; // vercel.json cho hàm này tối đa 300 giây; nếu bước cập nhật đối chiếu phụ huynh tốn thời gian thì Claude được ít hơn, để cả hàm vẫn xong trước giây 285

export default async function handler(req, res) {
  try {
    const { verifyIdToken } = await import('../server/firebase.js');
    const who = await authorize({ authorization: req.headers.authorization, verifyIdToken, allowSecrets: ['cron'] });
    if (!who.ok) return send(res, who.status, who);
    if (who.kind === 'cron' && req.method !== 'GET') return send(res, 405, { ok: false, error: 'Cron dùng GET.' });
    if (who.kind === 'user' && (req.method !== 'POST' || who.role !== 'admin')) return send(res, 403, { ok: false, error: 'Chỉ quản trị (FBADS_ADMINS) được yêu cầu viết lại phân tích.' });
    if (!String(process.env.ANTHROPIC_API_KEY || '').trim()) return send(res, 501, { ok: false, error: 'Chưa cấu hình ANTHROPIC_API_KEY trên Vercel nên máy chủ chưa tự viết được phân tích.' });

    await import('../fbads-core.js');
    await import('../benchmarks.js');
    const C = globalThis.FBCore, B = globalThis.FBBench;
    const { buildPack } = await import('../server/pack.js');
    const { writeInsights, validate, MODEL } = await import('../server/insights-ai.js');
    const { readAll, writeDocs } = await import('../server/store.js');
    const dry = /^(1|true)$/.test(String((req.query || {}).dry || ''));
    const started = Date.now(), today = C.dates.todayVN();

    // đối chiếu phụ huynh Facebook → đóng phí chưa được cập nhật gần đây (ví dụ lần đồng bộ sáng không còn thời gian): làm trước để bài phân tích dùng số mới
    try { const { withDeadline, setDeadline } = await import('../server/meta.js'); const { maybeLeadSync } = await import('../server/leadsync.js'); await withDeadline(async () => { setDeadline(Date.now() + 80000); await maybeLeadSync({ by: who.kind === 'cron' ? 'cron' : 'admin' }); }); }
    catch (e) { console.error('[insights] bỏ qua cập nhật đối chiếu:', e && e.expose ? e.message : 'lỗi'); }
    let docs = await readAll();
    // đang có lần đồng bộ chạy (khoá syncstate.runningUntil): chờ tối đa khoảng 50 giây để không phân tích số liệu cũ
    for (let i = 0; i < 5 && docs.syncstate && docs.syncstate.runningUntil && Date.parse(docs.syncstate.runningUntil) > Date.now(); i++) { await new Promise(r => setTimeout(r, 10000)); docs = await readAll(); }
    if (docs.syncstate && docs.syncstate.runningUntil && Date.parse(docs.syncstate.runningUntil) > Date.now()) return send(res, 409, { ok: false, error: 'Đang đồng bộ số liệu. Thử viết phân tích lại sau ít phút.' });
    const { scopeDocs } = await import('../server/scope.js');
    docs = scopeDocs(C, docs, process.env); // chỉ hai tài khoản đang kết nối
    if (!Object.keys(docs).some(k => k.indexOf('acct-') === 0)) return send(res, 409, { ok: false, error: 'Chưa có số liệu quảng cáo để phân tích. Hãy đồng bộ trước.' });
    const pack = buildPack(C, docs, today);
    pack.benchmark_comparison = B.compare(C, C.model(docs), today, { accts: pack.accounts.filter(a => a.role !== 'recruit').map(a => a.id) });
    pack.benchmark_sources = B.sources();
    // chuyển đổi tuyển sinh (số tổng hợp từ file DATA TUYỂN SINH), nếu quản trị đã tải lên
    try {
      await import('../admissions.js');
      const adm = docs.admissions && globalThis.FBAdm.validate(docs.admissions);
      if (adm && adm.ok) pack.admissions = globalThis.FBAdm.packOf(C, C.model(docs), pack.accounts.filter(a => a.role !== 'recruit').map(a => a.id), Object.assign(adm.summary, { uploadedAt: docs.admissions.uploadedAt }), today);
    } catch (e) { console.error('[insights] bỏ qua phần tuyển sinh:', e && e.message); } // số tuyển sinh hỏng không được làm hỏng cả bài phân tích
    // đối chiếu từng phụ huynh (lead Facebook → đóng phí): chỉ số tổng hợp theo kỳ, kèm độ trưởng thành và độ phủ để Claude nêu giới hạn
    try {
      await import('../admissions.js'); await import('../leadmatch.js');
      const M = globalThis.FBMatch, A = globalThis.FBAdm, mv = docs.fbmatch && M.validate(docs.fbmatch);
      if (mv && mv.ok) {
        const accts = pack.accounts.filter(a => a.role !== 'recruit').map(a => a.id), mdl = C.model(docs);
        pack.fb_parent_match = M.packOf(mv.match, today, (since, until) => {
          const fb = A.fbByProgram(C, mdl, accts, since, until), byProgram = {}, byCampaign = {};
          for (const q of A.PROGRAMS) byProgram[q.k] = fb[q.k] ? fb[q.k].spend : 0;
          for (const x of C.campaignsIn(mdl, accts, since, until)) byCampaign[x.c.id] = (byCampaign[x.c.id] || 0) + (x.period.spend || 0);
          return { byProgram, byCampaign };
        });
      }
    } catch (e) { console.error('[insights] bỏ qua phần đối chiếu phụ huynh:', e && e.message); }

    const { insights, usage, model } = await writeInsights(pack, { timeoutMs: Math.max(60000, Math.min(TIMEOUT_MS, 285000 - (Date.now() - started))) });
    const problems = validate(insights);
    if (pack.data_until !== today) problems.push('Số liệu chưa được đồng bộ hôm nay (đến ' + pack.data_until + ').');
    const now = new Date();
    const label = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' }) + ' ' + now.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' });
    const doc = Object.assign({ v: 1, updatedAt: now.toISOString(), updatedLabel: label, dataUntil: pack.data_until }, insights,
      { author: 'claude-api', model, by: who.kind === 'cron' ? 'vercel-cron' : 'vercel:' + who.email, warnings: problems });
    let written = 0;
    if (!dry) written = await writeDocs({ insights: doc }, { by: doc.by });
    send(res, 200, { ok: true, dry, written, model, problems, usage: usage && { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens }, ms: Date.now() - started, headline: doc.headline });
  } catch (e) {
    console.error('[insights]', e);
    const status = e && e.status && e.status < 600 ? e.status : 500;
    const msg = e && e.status === 401 ? 'ANTHROPIC_API_KEY không hợp lệ.' : e && e.status === 429 ? 'Claude đang quá tải hoặc hết hạn mức. Thử lại sau ít phút.' : safeError(e);
    send(res, status, { ok: false, error: msg });
  }
}
