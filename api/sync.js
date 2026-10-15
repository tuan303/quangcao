// /api/sync – lấy số liệu mới nhất trực tiếp từ Meta Marketing API rồi ghi vào Firestore.
//   GET  – Vercel Cron (Authorization: Bearer <CRON_SECRET>), lịch 05:30 giờ Hà Nội (gói Hobby: chạy trong khoảng 05:00–06:00, xong trước khi viết phân tích lúc 07:00–08:00)
//   POST – quản trị bấm "Đồng bộ ngay" (Bearer <Firebase ID token>, email trong FBADS_ADMINS)
//   ?groups=base,ads,bd  chọn nhóm số liệu (mặc định: base mỗi ngày; ads thứ 2 và thứ 5; bd thứ 3 và thứ 6;
//                        cộng nhóm ads/bd lần trước chưa lấy xong – lưu ở syncstate.pending)
//   ?dry=1               chạy thử: lấy và kiểm tra số liệu nhưng KHÔNG ghi (dùng để kiểm tra token lần đầu)
// Chỉ hoạt động khi có META_ACCESS_TOKEN. Không có token thì số liệu do tác vụ Claude hằng ngày đẩy lên qua /api/ingest.
// Tiến độ lấy lịch sử của từng tài khoản lưu ở tài liệu `syncstate` (tác vụ Claude không ghi đè tài liệu này).
import { authorize } from '../server/auth.js';
import { send, safeError } from '../server/http.js';

// vercel.json cho hàm này 300 giây (Fluid compute): không bắt đầu lời gọi mới sau 230 giây (nhóm nặng: 210 giây),
// và mọi yêu cầu đang chạy dở bị cắt ở giây 270 (server/meta.js setDeadline) để luôn còn thời gian ghi.
const DEADLINE_MS = 230000;
const HEAVY_DEADLINE_MS = 210000;
const HARD_DEADLINE_MS = 270000;
const HEAVY_GROUPS = ['ads', 'bd'];
const groupOfCall = name => /^(ads|adm|creatives)/.test(name) ? 'ads' : /^bd_/.test(name) ? 'bd' : null;

/** Bảo vệ số liệu đã có ở các ngày cũ (trước hôm kia): chi tiêu lệch ở nhiều ngày → không ghi (409). */
function compareStored(stored, merged, today, C) {
  const cutoff = C.dates.addDays(today, -2), out = { checkedDays: 0, mismatches: [] };
  for (const id of Object.keys(merged)) {
    if (id.indexOf('acct-') !== 0 || !stored[id]) continue;
    const a = stored[id].daily || {}, b = merged[id].daily || {};
    for (const d of Object.keys(a)) {
      if (d >= cutoff || !b[d] || a[d] === b[d]) continue;
      out.checkedDays++;
      const x = a[d][0], y = b[d][0];
      if (Math.abs(x - y) > Math.max(1000, Math.abs(x) * 0.01)) out.mismatches.push({ account: id.slice(5), day: d, stored: x, fresh: y });
    }
  }
  out.blocked = out.mismatches.length > 3;
  return out;
}

/** Meta bỗng không trả loại lead nào cho một tài khoản (đổi phiên bản API, mất quyền…) trong khi số đang lưu cho cùng những ngày đó có lead:
 *  đó là mất dữ liệu chứ không phải lead thật về 0. Khi đó giữ lead đang lưu ở số theo ngày và không ghi đè các bảng chiến dịch/mẫu quảng cáo/khán giả
 *  của tài khoản đó. Một ngày lẻ về 0 trong khi các ngày khác vẫn có lead thì là số thật và được ghi bình thường. */
function leadLossAccounts(stored, fresh, perAccount, C) {
  const L = C.MI.lead, ML = C.MI.mlead, out = [];
  for (const id of Object.keys(fresh)) {
    if (id.indexOf('acct-') !== 0 || !stored[id]) continue;
    const acct = id.slice(5), A = perAccount[acct];
    if (!A || !A.dailyRows || Object.keys(A.leadTypes).length) continue; // có dòng theo ngày và không thấy loại lead nào
    const a = stored[id].daily || {}, b = fresh[id].daily || {};
    let had = 0;
    for (const d of Object.keys(b)) if (a[d]) had += Math.max(a[d][L] || 0, a[d][ML] || 0);
    if (had > 0) out.push(acct);
  }
  return out;
}

export default async function handler(req, res) {
  const { withDeadline } = await import('../server/meta.js');
  return withDeadline(() => run(req, res)); // hạn chót riêng cho lần gọi này
}

async function run(req, res) {
  let releaseLock = null;
  try {
    const { verifyIdToken } = await import('../server/firebase.js');
    const who = await authorize({ authorization: req.headers.authorization, verifyIdToken, allowSecrets: ['cron'] });
    if (!who.ok) return send(res, who.status, who);
    if (who.kind === 'cron' && req.method !== 'GET') return send(res, 405, { ok: false, error: 'Cron dùng GET.' });
    if (who.kind === 'user' && (req.method !== 'POST' || who.role !== 'admin')) return send(res, 403, { ok: false, error: 'Chỉ quản trị (FBADS_ADMINS) được bấm đồng bộ.' });
    const token = String(process.env.META_ACCESS_TOKEN || '').trim();
    if (!token) return send(res, 501, { ok: false, error: 'Chưa cấu hình META_ACCESS_TOKEN nên máy chủ không tự lấy số liệu từ Meta. Số liệu đang được tác vụ Claude cập nhật mỗi sáng.' });

    await import('../fbads-core.js');
    const C = globalThis.FBCore;
    const { runCall, runCreatives, setDeadline } = await import('../server/meta.js');
    const { readAll, writeDocs } = await import('../server/store.js');
    const q = req.query || {}, started = Date.now();
    setDeadline(started + HARD_DEADLINE_MS);
    const dry = /^(1|true)$/.test(String(q.dry || ''));
    const today = C.dates.todayVN(), dow = C.dates.parseISO(today).getUTCDay();
    let groups = String(q.groups || '').split(',').map(s => s.trim()).filter(Boolean);
    const askedGroups = groups.length > 0;
    const accounts = [...new Set(String(process.env.META_AD_ACCOUNTS || '').split(/[\s,;]+/).map(s => s.replace(/^act_/i, '')).filter(Boolean))];
    const accts = accounts.length ? accounts : C.ACCOUNTS.map(a => a.id);

    const stored = await readAll();
    const prevMeta = stored.meta || {};
    // hist[acct] = ngày đã lấy đủ lịch sử; win[acct] = các khung ngày cũ (since|until) đã lấy xong, để lần sau lấy tiếp phần còn thiếu
    const state = Object.assign({ hist: {}, win: {} }, stored.syncstate);
    const by = who.kind === 'cron' ? 'vercel-cron' : 'vercel:' + who.email;
    // khoá: không chạy hai lần đồng bộ cùng lúc (cron và nút "Đồng bộ ngay"); khoá tự hết hạn sau 300 giây nếu lần trước bị cắt
    const busyUntil = state.runningUntil ? Date.parse(state.runningUntil) : 0;
    if (!dry && busyUntil > Date.now()) return send(res, 409, { ok: false, busy: true, error: 'Đang có một lần đồng bộ khác chạy. Đợi vài phút, trang sẽ tự cập nhật.' });
    if (!dry) {
      await writeDocs({ syncstate: Object.assign({}, stored.syncstate || {}, { runningUntil: new Date(started + 300000).toISOString() }) }, { by });
      releaseLock = () => writeDocs({ syncstate: Object.assign({}, stored.syncstate || {}, { runningUntil: null }) }, { by });
    }
    // nhóm nặng lần trước chưa lấy xong: { g: 'ads' | 'bd', n: số lần đã thử } (bản cũ lưu mảng tên nhóm)
    const prevPending = (state.pending || []).map(x => typeof x === 'string' ? { g: x, n: 1 } : x).filter(x => x && HEAVY_GROUPS.includes(x.g));
    // mặc định theo thứ trong tuần, cộng các nhóm nặng lần trước chưa lấy xong (để không phải chờ tới tuần sau)
    if (!askedGroups) groups = [...new Set(['base'].concat(dow === 1 || dow === 4 ? ['ads'] : [], dow === 2 || dow === 5 ? ['bd'] : [], prevPending.map(x => x.g)))];
    const hist = Object.assign({}, state.hist), win = Object.assign({}, state.win);
    const recentFrom = C.dates.addDays(today, -45);
    const rangeOf = c => { const tr = JSON.parse(c.args.time_range); return tr.since + '|' + tr.until; };
    const isOldDaily = c => /^daily_w/.test(c.name) && JSON.parse(c.args.time_range).until < recentFrom;

    const quick = C.plan(today, { mode: 'quick', accounts: accts }), full = C.plan(today, { mode: 'full', accounts: accts });
    let calls = [];
    const fullAccts = {};
    const oldRowsOf = doc => Object.keys((doc && doc.daily) || {}).filter(d => d < recentFrom).length;
    const covered = state.covered || {};
    if (groups.includes('base')) for (const acct of accts) {
      const doc = stored['acct-' + acct], hasDoc = !!doc;
      // số đang lưu không còn như lúc đánh dấu đủ lịch sử (bị ghi đè ngắn hơn, hoặc lâu không đồng bộ nên hở quá 45 ngày) → lấy lại
      const days = hasDoc ? Object.keys(doc.daily || {}).sort() : [];
      if (hasDoc && hist[acct] && (oldRowsOf(doc) < (covered[acct] || 0) || (days.length && days[days.length - 1] < recentFrom))) { delete hist[acct]; delete win[acct]; }
      if (hasDoc && hist[acct]) { calls = calls.concat(quick.filter(c => c.acct === acct && !/^(ads|adm|bd_)/.test(c.name))); continue; }
      // chưa đủ lịch sử: lấy từ đầu, bỏ qua các khung ngày cũ đã lấy xong ở lần trước
      const done = new Set(hasDoc ? win[acct] || [] : []);
      const mine = full.filter(c => c.acct === acct && !/^(ads|adm|bd_)/.test(c.name));
      fullAccts[acct] = { oldWins: mine.filter(isOldDaily).map(rangeOf), done };
      calls = calls.concat(mine.filter(c => !(isOldDaily(c) && done.has(rangeOf(c)))));
    }
    if (groups.includes('ads')) calls = calls.concat(full.filter(c => c.name === 'ads' || c.name === 'adm'));
    if (groups.includes('bd')) calls = calls.concat(full.filter(c => c.name.indexOf('bd_') === 0));
    // số liệu gần đây của MỌI tài khoản trước; rồi lịch sử còn thiếu; rồi các khung tiếp cận; nhóm nặng sau cùng
    const prio = c => {
      if (/^daily_w/.test(c.name)) return isOldDaily(c) ? 1 : 0;
      if (c.name === 'camps' || c.name.indexOf('campd') === 0) return 0;
      if (c.name === 'campm') return 1;
      if (c.name.indexOf('reach_') === 0) return 2;
      return 3;
    };
    calls = calls.map((c, i) => [prio(c), i, c]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(x => x[2]);

    const raw = {}, failed = [], skipped = [], cache = {};
    // failed/skipped: số liệu chính (chi tiêu, lead, chiến dịch); heavy: mẫu quảng cáo, nội dung, khán giả
    const blank = () => ({ calls: 0, ok: 0, failed: 0, skipped: 0, heavy: 0, rows: 0, dailyRows: 0, noActions: 0, leadTypes: {} });
    const perAccount = Object.fromEntries(accts.map(a => [a, blank()]));
    const pa = a => perAccount[a] ||= blank();
    const isHeavy = name => /^(ads|adm|bd_|creatives)/.test(name);
    const fail = (acct, name, e) => { const msg = String(e.message || e).slice(0, 200); failed.push({ call: acct + '|' + name, error: msg }); const A = pa(acct); if (isHeavy(name)) A.heavy++; else { A.failed++; A.error ||= msg; } };
    const skip = (acct, name) => { skipped.push(acct + '|' + name); const A = pa(acct); if (isHeavy(name)) A.heavy++; else A.skipped++; };
    for (const c of calls) pa(c.acct).calls++;
    const queue = calls.slice();
    async function worker() {
      while (queue.length) {
        const c = queue.shift();
        if (c.creatives) { // nội dung bài của mẫu quảng cáo: chạy ngay sau lời gọi ads của tài khoản đó, trong cùng nhóm worker
          const ids = [...new Set((raw[c.acct].ads || []).flatMap(p => C.rowsOf(p)).map(r => String(r.creative_id || '')).filter(Boolean))];
          if (!ids.length) continue;
          pa(c.acct).calls++;
          if (Date.now() - started > HEAVY_DEADLINE_MS) { skip(c.acct, 'creatives'); continue; }
          try { raw[c.acct].creatives_c1 = [await runCreatives(ids, token)]; pa(c.acct).ok++; }
          catch (e) { if (e && e.meta && e.meta.code === 190) throw e; fail(c.acct, 'creatives', e); }
          continue;
        }
        if (Date.now() - started > (prio(c) >= 3 ? HEAVY_DEADLINE_MS : DEADLINE_MS)) { skip(c.acct, c.name); continue; }
        try {
          const p = await runCall(c, token, cache), A = pa(c.acct);
          if (c.name === 'ads') queue.unshift({ acct: c.acct, name: 'creatives', creatives: true });
          ((raw[c.acct] ||= {})[c.name] = []).push(p);
          A.ok++; A.rows += p.diag.rows; A.noActions += p.diag.noActions;
          // chỉ cộng từ các dòng theo ngày (không chồng nhau), để số chẩn đoán so được với Trình quản lý quảng cáo
          if (/^daily_w/.test(c.name)) { A.dailyRows += p.diag.rows; for (const [k, v] of Object.entries(p.diag.leadTypes)) A.leadTypes[k] = (A.leadTypes[k] || 0) + v; }
        } catch (e) {
          if (e && e.meta && e.meta.code === 190) throw e; // token hỏng: dừng ngay
          fail(c.acct, c.name, e);
        }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);
    // bỏ cả nhóm số liệu nếu một phần của nó lỗi/bỏ dở, để bản đang lưu được giữ nguyên
    const groupKey = k => { const [a, n] = k.split('|'); return a + '|' + n.replace(/__.*$/, ''); };
    const bad = new Set(failed.map(f => f.call).concat(skipped).map(groupKey));
    for (const acct of Object.keys(raw)) for (const n of Object.keys(raw[acct])) if (bad.has(acct + '|' + n.replace(/__.*$/, ''))) delete raw[acct][n];

    const fresh = C.normalize(raw, { windows: C.windowsOf(calls) });
    const leadLoss = leadLossAccounts(stored, fresh, perAccount, C);
    for (const acct of leadLoss) {
      // giữ lead đang lưu cho các ngày đã có; không ghi đè bảng chiến dịch/mẫu quảng cáo/khán giả của tài khoản này
      const a = stored['acct-' + acct].daily || {}, b = fresh['acct-' + acct].daily || {};
      for (const d of Object.keys(b)) if (a[d]) { b[d] = b[d].slice(); b[d][C.MI.lead] = a[d][C.MI.lead] || 0; b[d][C.MI.mlead] = a[d][C.MI.mlead] || 0; }
      for (const id of Object.keys(fresh)) if (id !== 'acct-' + acct && id.split('-')[1] === acct) delete fresh[id];
    }
    // tài khoản đang lấy lại lịch sử: số chiến dịch theo ngày cũ (ngoài 62 ngày vừa lấy) được tính theo cách cũ → bỏ, để kỳ cũ dùng số theo tháng vừa lấy lại
    const base = Object.assign({}, stored);
    for (const acct of Object.keys(fullAccts)) if (fresh['campd-' + acct]) delete base['campd-' + acct];
    const merged = C.mergeDocs(base, fresh);
    const checks = compareStored(stored, merged, today, C);

    // ghi nhận các khung ngày cũ đã lấy xong; đủ hết thì từ lần sau chỉ lấy 45 ngày gần nhất
    for (const [acct, f] of Object.entries(fullAccts)) {
      const got = new Set(f.done);
      for (const c of calls) if (c.acct === acct && isOldDaily(c) && raw[acct] && raw[acct][c.name]) got.add(rangeOf(c));
      win[acct] = [...got].filter(r => f.oldWins.includes(r));
      const recentOk = calls.filter(c => c.acct === acct && /^daily_w/.test(c.name) && !isOldDaily(c)).every(c => raw[acct] && raw[acct][c.name]);
      if (recentOk && f.oldWins.every(r => got.has(r))) hist[acct] = today;
    }
    for (const acct of Object.keys(hist)) { const d = merged['acct-' + acct] || stored['acct-' + acct]; if (d) covered[acct] = oldRowsOf(d); }
    for (const acct of Object.keys(covered)) if (!hist[acct]) delete covered[acct];
    // nhóm nặng còn dở (có phần lỗi hoặc chưa kịp lấy) → lần đồng bộ sau lấy tiếp; nhóm không chạy lần này thì giữ nguyên trạng thái cũ
    // tài khoản mất lead: số mẫu quảng cáo/khán giả vừa lấy bị bỏ, nên cũng tính là chưa lấy xong
    const incomplete = new Set(failed.map(f => f.call).concat(skipped).map(k => groupOfCall(k.split('|')[1])).filter(Boolean).concat(leadLoss.length ? groups.filter(g => HEAVY_GROUPS.includes(g)) : []));
    // thử lại tối đa 3 lần liên tiếp rồi quay về lịch hằng tuần (lỗi kéo dài thì quản trị thấy ở thông báo)
    const pending = prevPending.filter(x => !groups.includes(x.g))
      .concat(groups.filter(g => HEAVY_GROUPS.includes(g) && incomplete.has(g)).map(g => ({ g, n: ((prevPending.find(x => x.g === g) || {}).n || 0) + 1 })).filter(x => x.n < 3));
    const syncstate = { hist, win, covered, pending, at: new Date().toISOString() };
    const gotFresh = Object.keys(fresh).length > 0;
    const meta = Object.assign({}, prevMeta, gotFresh ? {
      v: C.VERSION, syncedAt: new Date().toISOString(), syncedBy: by, dataUntil: today, start: C.START,
      accounts: prevMeta.accounts && prevMeta.accounts.length ? prevMeta.accounts : C.ACCOUNTS, source: 'meta-api',
      fullAt: groups.includes('ads') && groups.includes('bd') && !failed.length && !skipped.length && !leadLoss.length ? new Date().toISOString() : (prevMeta.fullAt || null)
    } : {}, {
      // không lấy được gì: giữ nguyên ngày đồng bộ và ngày số liệu, chỉ ghi lại lần thử và tài khoản nào đang lỗi
      lastAttemptAt: new Date().toISOString(),
      failed: failed.map(f => f.call).concat(skipped),
      leadLoss,
      pending: pending.map(x => x.g), // nhóm nặng sẽ được lấy tiếp ở lần đồng bộ sau (đã thử dưới 3 lần)
      perAccount: Object.fromEntries(Object.entries(perAccount).map(([a, x]) => [a, { ok: x.ok, failed: x.failed, skipped: x.skipped, heavy: x.heavy, error: x.error || null, history: hist[a] ? 'done' : 'partial' }]))
    });
    const mdl = C.model(Object.assign({}, stored, merged, { meta }));
    const t30 = C.totals(mdl, accts.filter(a => (C.ACCOUNTS.find(x => x.id === a) || {}).role !== 'recruit'), C.dates.addDays(today, -30), C.dates.addDays(today, -1));
    const summary = { last30d: { spend: Math.round(t30.spend), leads: t30.leads, cpl: t30.cpl && Math.round(t30.cpl) } };
    const checkOut = { checkedDays: checks.checkedDays, mismatches: checks.mismatches.slice(0, 5), leadLoss };
    if (checks.blocked) { if (releaseLock) await releaseLock(); return send(res, 409, { ok: false, error: 'Số liệu mới lệch với số liệu đang lưu ở nhiều ngày cũ nên không ghi. Kiểm tra token/tài khoản rồi chạy lại với ?dry=1.', checks: checkOut, failed, skipped, summary, perAccount }); }
    let written = 0;
    // luôn lưu kết quả đồng bộ (kể cả khi không lấy được gì) để trang báo đúng tài khoản nào đang thiếu số liệu
    if (!dry) written = await writeDocs(gotFresh ? Object.assign({}, merged, { meta, syncstate }) : { meta, syncstate }, { by });
    releaseLock = null; // syncstate vừa ghi không còn runningUntil
    send(res, 200, { ok: true, dry, groups, pending: pending.map(x => x.g), calls: calls.length, written, fresh: Object.keys(fresh).length, failed, skipped, checks: checkOut, summary, perAccount, ms: Date.now() - started });
  } catch (e) {
    console.error('[sync]', e);
    if (releaseLock) await releaseLock().catch(() => {});
    send(res, e.status && e.status < 600 ? (e.status === 400 && e.meta ? 502 : e.status) : 500, { ok: false, error: safeError(e) });
  }
}
