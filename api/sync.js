// /api/sync – lấy số liệu mới nhất trực tiếp từ Meta Marketing API rồi ghi vào Firestore.
//   GET  – Vercel Cron (Authorization: Bearer <CRON_SECRET>), lịch 06:30 giờ Hà Nội (gói Hobby: chạy trong khoảng 06:00–07:00)
//   POST – quản trị bấm "Đồng bộ ngay" (Bearer <Firebase ID token>, email trong FBADS_ADMINS)
//   ?groups=base,ads,bd  chọn nhóm số liệu (mặc định: base mỗi ngày; ads thứ 2 và thứ 5; bd thứ 3 và thứ 6)
//   ?dry=1               chạy thử: lấy và kiểm tra số liệu nhưng KHÔNG ghi (dùng để kiểm tra token lần đầu)
// Chỉ hoạt động khi có META_ACCESS_TOKEN. Không có token thì số liệu do tác vụ Claude hằng ngày đẩy lên qua /api/ingest.
import { authorize } from '../server/auth.js';
import { send, safeError } from '../server/http.js';

const DEADLINE_MS = 45000; // Vercel Hobby cho tối đa 60 giây mỗi lần gọi

function compareStored(stored, merged, today, C) {
  // Bảo vệ số liệu đã có: ngày cũ (trước hôm kia) phải khớp với số liệu đang lưu – cả chi tiêu lẫn lead.
  const cutoff = C.dates.addDays(today, -2), out = { checkedDays: 0, mismatches: [], leadDrops: [] };
  const L = C.MI.lead, ML = C.MI.mlead;
  for (const id of Object.keys(merged)) {
    if (id.indexOf('acct-') !== 0 || !stored[id]) continue;
    const a = stored[id].daily || {}, b = merged[id].daily || {};
    for (const d of Object.keys(a)) {
      if (d >= cutoff || !b[d]) continue;
      out.checkedDays++;
      const x = a[d][0], y = b[d][0];
      if (Math.abs(x - y) > Math.max(1000, Math.abs(x) * 0.01)) out.mismatches.push({ account: id.slice(5), day: d, stored: x, fresh: y });
      const sl = Math.max(a[d][L] || 0, a[d][ML] || 0), fl = Math.max(b[d][L] || 0, b[d][ML] || 0);
      if (sl > 0 && fl === 0) out.leadDrops.push({ account: id.slice(5), day: d, stored: sl, fresh: fl });
    }
  }
  out.blocked = out.mismatches.length > 3 || out.leadDrops.length > 3;
  return out;
}

export default async function handler(req, res) {
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
    const { runCall, runCreatives } = await import('../server/meta.js');
    const { readAll, writeDocs } = await import('../server/store.js');
    const q = req.query || {}, started = Date.now();
    const dry = /^(1|true)$/.test(String(q.dry || ''));
    const today = C.dates.todayVN(), dow = C.dates.parseISO(today).getUTCDay();
    let groups = String(q.groups || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!groups.length) groups = ['base'].concat(dow === 1 || dow === 4 ? ['ads'] : [], dow === 2 || dow === 5 ? ['bd'] : []);
    const accounts = String(process.env.META_AD_ACCOUNTS || '').split(/[\s,;]+/).map(s => s.replace(/^act_/i, '')).filter(Boolean);
    const accts = accounts.length ? accounts : C.ACCOUNTS.map(a => a.id);

    const stored = await readAll();
    const prevMeta = stored.meta || {}, hist = Object.assign({}, prevMeta.hist);
    const quick = C.plan(today, { mode: 'quick', accounts: accts }), full = C.plan(today, { mode: 'full', accounts: accts });
    let calls = [];
    const fullAccts = [];
    if (groups.includes('base')) for (const acct of accts) {
      // lấy lịch sử từ đầu cho tới khi đã có MỘT lần lấy đủ (lần đầu có thể hết giờ giữa chừng; lần sau lấy tiếp)
      const needFull = !stored['acct-' + acct] || !hist[acct];
      if (needFull) fullAccts.push(acct);
      calls = calls.concat((needFull ? full : quick).filter(c => c.acct === acct && !/^(ads|adm|bd_)/.test(c.name)));
    }
    if (groups.includes('ads')) calls = calls.concat(full.filter(c => c.name === 'ads' || c.name === 'adm'));
    if (groups.includes('bd')) calls = calls.concat(full.filter(c => c.name.indexOf('bd_') === 0));
    // số liệu gần đây của MỌI tài khoản trước, lịch sử cũ sau: nếu hết giờ thì phần bỏ dở là phần cũ, lần sau lấy tiếp
    const recentFrom = C.dates.addDays(today, -45);
    const prio = c => {
      if (/^daily_w/.test(c.name)) { const tr = JSON.parse(c.args.time_range); return tr.until >= recentFrom ? 0 : 2; }
      if (c.name === 'camps' || c.name.indexOf('campd') === 0) return 0;
      if (c.name.indexOf('reach_') === 0) return 1;
      return c.name === 'campm' ? 2 : 3;
    };
    calls = calls.map((c, i) => [prio(c), i, c]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(x => x[2]);

    const raw = {}, failed = [], skipped = [], cache = {};
    const perAccount = Object.fromEntries(accts.map(a => [a, { calls: 0, ok: 0, failed: 0, skipped: 0, rows: 0, noActions: 0, leadTypes: {} }]));
    const pa = a => perAccount[a] ||= { calls: 0, ok: 0, failed: 0, skipped: 0, rows: 0, noActions: 0, leadTypes: {} };
    for (const c of calls) pa(c.acct).calls++;
    const queue = calls.slice();
    async function worker() {
      while (queue.length) {
        const c = queue.shift();
        if (Date.now() - started > DEADLINE_MS) { skipped.push(c.acct + '|' + c.name); pa(c.acct).skipped++; continue; }
        try {
          const p = await runCall(c, token, cache), A = pa(c.acct);
          ((raw[c.acct] ||= {})[c.name] = []).push(p);
          A.ok++; A.rows += p.diag.rows; A.noActions += p.diag.noActions;
          for (const [k, v] of Object.entries(p.diag.leadTypes)) A.leadTypes[k] = (A.leadTypes[k] || 0) + v;
        }
        catch (e) {
          if (e && e.meta && e.meta.code === 190) throw e; // token hỏng: dừng ngay
          failed.push({ call: c.acct + '|' + c.name, error: String(e.message || e).slice(0, 200) });
          const A = pa(c.acct); A.failed++; A.error ||= String(e.message || e).slice(0, 200);
        }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (groups.includes('ads')) for (const acct of Object.keys(raw)) {
      const ids = [...new Set((raw[acct].ads || []).flatMap(p => C.rowsOf(p)).map(r => String(r.creative_id || '')).filter(Boolean))];
      if (!ids.length) continue;
      if (Date.now() - started > DEADLINE_MS) { skipped.push(acct + '|creatives'); continue; }
      try { raw[acct].creatives_c1 = [await runCreatives(ids, token)]; }
      catch (e) { failed.push({ call: acct + '|creatives', error: String(e.message || e).slice(0, 200) }); }
    }
    // bỏ cả nhóm số liệu nếu một phần của nó lỗi/bỏ dở, để bản đang lưu được giữ nguyên
    const bad = new Set(failed.map(f => f.call).concat(skipped).map(k => { const [a, n] = k.split('|'); return a + '|' + n.replace(/__.*$/, ''); }));
    for (const acct of Object.keys(raw)) for (const n of Object.keys(raw[acct])) if (bad.has(acct + '|' + n.replace(/__.*$/, ''))) delete raw[acct][n];

    const fresh = C.normalize(raw, { windows: C.windowsOf(calls) });
    const merged = C.mergeDocs(stored, fresh);
    const checks = compareStored(stored, merged, today, C);
    // tài khoản đã lấy đủ lịch sử trong lần này → từ lần sau chỉ cần lấy 45 ngày gần nhất
    for (const acct of fullAccts) if (![...bad].some(k => k.indexOf(acct + '|') === 0 && !/\|(ads|adm|bd_|creatives)/.test(k))) hist[acct] = today;
    const prev = prevMeta;
    const meta = Object.assign({}, prev, {
      v: C.VERSION, syncedAt: new Date().toISOString(), syncedBy: who.kind === 'cron' ? 'vercel-cron' : 'vercel:' + who.email, dataUntil: today, start: C.START,
      accounts: prev.accounts && prev.accounts.length ? prev.accounts : C.ACCOUNTS, source: 'meta-api',
      fullAt: groups.includes('ads') && groups.includes('bd') && !failed.length && !skipped.length ? new Date().toISOString() : (prev.fullAt || null),
      failed: failed.map(f => f.call).concat(skipped),
      hist, perAccount: Object.fromEntries(Object.entries(perAccount).map(([a, x]) => [a, { ok: x.ok, failed: x.failed, skipped: x.skipped, error: x.error || null }]))
    });
    const mdl = C.model(Object.assign({}, stored, merged, { meta }));
    const t30 = C.totals(mdl, accts.filter(a => (C.ACCOUNTS.find(x => x.id === a) || {}).role !== 'recruit'), C.dates.addDays(today, -30), C.dates.addDays(today, -1));
    const summary = { last30d: { spend: Math.round(t30.spend), leads: t30.leads, cpl: t30.cpl && Math.round(t30.cpl) } };
    if (checks.blocked) return send(res, 409, { ok: false, error: (checks.leadDrops.length > 3 ? 'Số lead mới bằng 0 ở nhiều ngày cũ vốn có lead' : 'Số liệu mới lệch với số liệu đang lưu ở nhiều ngày cũ') + ' nên không ghi. Kiểm tra token/tài khoản rồi chạy lại với ?dry=1.', checks, failed, skipped, summary, perAccount });
    let written = 0;
    if (!dry && Object.keys(fresh).length) written = await writeDocs(Object.assign({}, merged, { meta }), { by: meta.syncedBy });
    send(res, 200, { ok: true, dry, groups, calls: calls.length, written, failed, skipped, checks: { checkedDays: checks.checkedDays, mismatches: checks.mismatches.slice(0, 5), leadDrops: checks.leadDrops.slice(0, 5) }, summary, perAccount, ms: Date.now() - started });
  } catch (e) {
    console.error('[sync]', e);
    send(res, e.status && e.status < 600 ? (e.status === 400 && e.meta ? 502 : e.status) : 500, { ok: false, error: safeError(e) });
  }
}
