// /api/insights – viết phần "Phân tích & đề xuất" bằng Claude từ số liệu đang lưu, rồi ghi tài liệu `insights`.
//   GET  – Vercel Cron (Authorization: Bearer <CRON_SECRET>), chạy sau đồng bộ buổi sáng
//   POST – quản trị bấm "Viết lại phân tích" (Bearer <Firebase ID token>, email trong FBADS_ADMINS)
//   ?dry=1 – viết nhưng KHÔNG ghi (xem thử)
// Cần ANTHROPIC_API_KEY. Mặt bằng ngành lấy từ benchmarks.js (nguồn và ngày ghi trong tệp).
import { authorize } from '../server/auth.js';
import { send, safeError } from '../server/http.js';

const TIMEOUT_MS = 240000; // vercel.json cho hàm này tối đa 300 giây

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

    let docs = await readAll();
    // đang có lần đồng bộ chạy (khoá syncstate.runningUntil): chờ tối đa khoảng 50 giây để không phân tích số liệu cũ
    for (let i = 0; i < 5 && docs.syncstate && docs.syncstate.runningUntil && Date.parse(docs.syncstate.runningUntil) > Date.now(); i++) { await new Promise(r => setTimeout(r, 10000)); docs = await readAll(); }
    if (docs.syncstate && docs.syncstate.runningUntil && Date.parse(docs.syncstate.runningUntil) > Date.now()) return send(res, 409, { ok: false, error: 'Đang đồng bộ số liệu. Thử viết phân tích lại sau ít phút.' });
    const { scopeDocs } = await import('../server/scope.js');
    docs = scopeDocs(C, docs, process.env); // chỉ hai tài khoản đang kết nối
    if (!Object.keys(docs).some(k => k.indexOf('acct-') === 0)) return send(res, 409, { ok: false, error: 'Chưa có số liệu quảng cáo để phân tích. Hãy đồng bộ trước.' });
    const pack = buildPack(C, docs, today);
    pack.benchmark_comparison = B.compare(C, C.model(docs), today);
    pack.benchmark_sources = B.sources();

    const { insights, usage, model } = await writeInsights(pack, { timeoutMs: TIMEOUT_MS });
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
