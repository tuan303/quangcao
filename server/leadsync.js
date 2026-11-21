// Điều phối cập nhật tự động: đọc Google Sheet DATA TUYỂN SINH → lấy lead Facebook → đối chiếu từng phụ huynh → ghi SỐ TỔNG HỢP.
// Họ tên, ngày sinh, số điện thoại, email (của học sinh trong Sheet và của phụ huynh trong lead) chỉ nằm trong bộ nhớ của hàm lúc tính:
// không ghi vào Firestore, không ghi log. Tài liệu được ghi: `fbmatch` (số theo ngày × chiến dịch), `admissions` (tổng hợp từ Sheet), `leadsync` (trạng thái).
import { sheetIdFrom, readAdmissionsSheet, serviceAccountInfo } from './gsheets.js';
import { fetchLeads, checkLeads } from './leads.js';
import { syncAccounts } from './scope.js';
import { readDocs, writeDocs } from './store.js';

const LOCK_MS = 300000;
const fail = (message, extra = {}) => Object.assign(new Error(message), { expose: true, status: 502 }, extra);

/** Đã cấu hình đủ để chạy tự động chưa. */
export function leadSyncConfig(env = process.env) {
  const sheet = !!sheetIdFrom(env.ADMISSIONS_SHEET_ID), meta = !!String(env.META_ACCESS_TOKEN || '').trim();
  return { sheet, meta, ready: sheet && meta };
}
async function libs() {
  await import('../fbads-core.js'); await import('../admissions.js'); await import('../leadmatch.js');
  return { C: globalThis.FBCore, A: globalThis.FBAdm, M: globalThis.FBMatch };
}
/** Lead trong các ngày từ `from` (tổng l của mọi ô): để phát hiện lần đọc hụt bất thường so với lần trước. */
function leadsFrom(match, from) {
  let n = 0; for (const d of Object.keys(match && match.days || {})) if (d >= from) for (const c of Object.keys(match.days[d])) n += match.days[d][c][0];
  return n;
}

/**
 * Chạy một lần cập nhật đầy đủ.
 * @param {{by?:string, env?:object, force?:boolean}} opt  force: bỏ qua kiểm tra "số lead giảm bất thường" (chỉ quản trị bấm tay)
 * @returns {Promise<{ok:true, ms:number, stats:object}>} số tổng hợp, không có dữ liệu cá nhân
 */
export async function runLeadSync({ by = 'cron', env = process.env, force = false, today: todayArg, store = { readDocs, writeDocs } } = {}) {
  const started = Date.now(), cfg = leadSyncConfig(env);
  if (!cfg.sheet) throw fail('Chưa đặt ADMISSIONS_SHEET_ID (đường dẫn hoặc ID của Google Sheet DATA TUYỂN SINH) trên Vercel.', { status: 501 });
  if (!cfg.meta) throw fail('Chưa cấu hình META_ACCESS_TOKEN nên chưa lấy được lead Facebook.', { status: 501 });
  const { C, A, M } = await libs();
  const today = A.isDayKey(todayArg) ? todayArg : C.dates.todayVN();
  const prevDocs = await store.readDocs(['leadsync', 'fbmatch']);
  const lock = prevDocs.leadsync && prevDocs.leadsync.runningUntil ? Date.parse(prevDocs.leadsync.runningUntil) : 0;
  if (lock > Date.now()) throw fail('Đang có một lần cập nhật khác chạy. Đợi vài phút rồi thử lại.', { status: 409, busy: true });
  const base = { v: 1, at: new Date().toISOString(), by: String(by).slice(0, 20) };
  await store.writeDocs({ leadsync: Object.assign({}, prevDocs.leadsync || {}, { runningUntil: new Date(started + LOCK_MS).toISOString() }) }, { by: base.by });
  let stage = 'sheet';
  try {
    const book = await readAdmissionsSheet(env.ADMISSIONS_SHEET_ID, { pickTabs: A.pickTabs, env });
    const ag = A.aggregate({ reg: book.reg, paid: book.paid, skipped: book.skipped, collect: true, today });
    if (!ag.ok) throw fail('Google Sheet: ' + ag.error, { status: 422 });
    const vs = A.validate(ag.summary); if (!vs.ok) throw fail('Số tổng hợp từ Google Sheet không hợp lệ: ' + vs.error, { status: 422 });
    // Mùa tuyển sinh đọc từ tiêu đề cột Khối ("Khối 27 28"). Gõ nhầm năm (hoặc mất chữ mùa) không được làm mất số đã gộp của mùa đang chạy: dừng và nói rõ thay vì bắt đầu lại.
    const span = A.seasonSpan(vs.summary), prevSeason = prevDocs.fbmatch && typeof prevDocs.fbmatch.season === 'string' ? prevDocs.fbmatch.season : '';
    if (span && (today < A.addDays(span.start, -92) || today > A.addDays(span.end, 92))) throw fail('Mùa tuyển sinh ghi ở tiêu đề cột Khối của Sheet (' + vs.summary.season + ') không khớp với ngày hôm nay (' + today + '). Hãy kiểm tra năm trong tiêu đề; chưa cập nhật để không ghi đè số liệu đang đúng.', { status: 422 });
    if (!span && prevSeason) throw fail('Không đọc được mùa tuyển sinh ở tiêu đề cột Khối của Sheet (lần trước là ' + prevSeason + ', ví dụ "Khối 27 28"). Chưa cập nhật để không ghi đè số liệu đang đúng.', { status: 422 });
    stage = 'meta';
    const accts = syncAccounts(C, env).accts;
    const raw = await fetchLeads({ token: String(env.META_ACCESS_TOKEN).trim(), accts, sinceDay: A.addDays(today, -90), env });
    stage = 'match';
    const next = M.matchLeads(raw.leads.map(M.leadFromGraph), ag.students);
    next.season = vs.summary.season || '';
    const pv = prevDocs.fbmatch && M.validate(prevDocs.fbmatch), prev = pv && pv.ok && pv.match.season === next.season ? pv.match : null;
    const from = M.windowFrom(today), before = leadsFrom(prev, from), after = leadsFrom(next, from);
    if (!force && prev && before >= 20 && after < before * 0.7) throw fail('Số lead đọc được lần này (' + after + ') thấp hơn hẳn lần trước (' + before + ') cho cùng khoảng ngày nên chưa ghi đè. Kiểm tra quyền đọc lead của token Meta và các biểu mẫu; nếu đúng là số mới, quản trị bấm lại với tuỳ chọn ghi đè.', { status: 409 });
    const merged = M.mergeMatch(prev, next, from); merged.syncedAt = new Date().toISOString();
    const vm = M.validate(merged); if (!vm.ok) throw fail('Kết quả đối chiếu không hợp lệ: ' + vm.error, { status: 500 });
    stage = 'write';
    const stats = { rows: next.leads.rows, parents: next.leads.parents, matched: next.leads.matched, students: next.cov.students, studentsWithPhone: next.cov.withPhone, paidExt: next.cov.paidExt, paidExtWithPhone: next.cov.paidExtWithPhone, forms: raw.forms, pages: raw.pages, skippedForms: raw.skippedForms, from: next.winFrom };
    const ms = Date.now() - started;
    await store.writeDocs({
      fbmatch: vm.match,
      admissions: Object.assign({}, vs.summary, { uploadedAt: new Date().toISOString(), by: null, source: 'sheet' }),
      leadsync: Object.assign({}, base, { ok: true, stage: null, error: null, ms, stats, runningUntil: null })
    }, { by: base.by });
    return { ok: true, ms, stats };
  } catch (e) {
    const msg = e && e.expose ? String(e.message).slice(0, 400) : 'Lỗi không rõ khi cập nhật. Xem log của hàm trên Vercel.';
    await store.writeDocs({ leadsync: Object.assign({}, base, { ok: false, stage, error: msg, ms: Date.now() - started, stats: null, runningUntil: null }) }, { by: base.by }).catch(() => {});
    if (e && e.expose) e.stage = stage;
    throw e;
  }
}

/** Cho cron: chỉ chạy khi đã cấu hình và lần cập nhật gần nhất đã cũ (mặc định 20 giờ); lỗi không làm hỏng việc gọi nó. */
export async function maybeLeadSync({ by = 'cron', env = process.env, staleMs = 20 * 3600000, store = { readDocs, writeDocs } } = {}) {
  if (!leadSyncConfig(env).ready) return { skipped: 'chưa cấu hình' };
  try {
    const s = (await store.readDocs(['leadsync'])).leadsync;
    if (s && s.ok && s.at && Date.now() - Date.parse(s.at) < staleMs) return { skipped: 'còn mới' };
    return await runLeadSync({ by, env, store });
  } catch (e) { console.error('[leadsync] cập nhật tự động lỗi:', e && e.expose ? e.message : 'xem log'); return { ok: false, error: e && e.expose ? e.message : 'lỗi', stage: e && e.stage }; }
}

/**
 * Kiểm tra từng bước (cho quản trị bấm "Kiểm tra kết nối"): chỉ trả số đếm, tên tab và thông báo; không có nội dung ô.
 * @returns {Promise<{config:object, serviceAccount:object|null, sheet:{steps:object[]}, meta:{steps:object[], pages:object[]}}>}
 */
export async function checkSetup({ env = process.env, today: todayArg } = {}) {
  const { C, A } = await libs(), cfg = leadSyncConfig(env);
  let sa = null; try { sa = serviceAccountInfo(env); } catch (e) { /* cấu hình hỏng được báo ở bước đọc */ }
  const out = { config: cfg, serviceAccount: sa, sheet: { steps: [] }, meta: { steps: [], pages: [] } };
  const add = (id, ok, text) => out.sheet.steps.push({ id, ok, text });
  if (!cfg.sheet) add('config', false, 'Chưa đặt ADMISSIONS_SHEET_ID trên Vercel (đường dẫn hoặc ID của Google Sheet).');
  else {
    add('config', true, 'Đã đặt ADMISSIONS_SHEET_ID.');
    try {
      const book = await readAdmissionsSheet(env.ADMISSIONS_SHEET_ID, { pickTabs: A.pickTabs, env });
      add('read', true, 'Đọc được Google Sheet "' + book.title + '" (' + book.tabs.length + ' tab cần dùng).');
      const ri = A.columnsInfo(book.reg);
      add('reg', !!ri && ri.internal && ri.program, ri ? 'Tab "' + book.tabs[0].slice(0, 40) + '": ' + (book.reg.length - ri.headerRow) + ' dòng; cột HS nội bộ ' + (ri.internal ? 'có' : 'THIẾU') + ', Chiến dịch ' + (ri.program ? 'có' : 'THIẾU') + ', Ngày đăng ký ' + (ri.regDate ? 'có' : 'chưa có') + ', Ngày đóng phí ' + (ri.paidDate ? 'có' : 'chưa có') + '.' : 'Không thấy dòng tiêu đề có cột MDT ở tab Danh sách đăng ký.');
      add('phones-reg', !!ri && ri.phones > 0, ri && ri.phones > 0 ? 'Tab Danh sách đăng ký có ' + ri.phones + ' cột SĐT' + (ri.emails ? ', ' + ri.emails + ' cột email' : '') + '.' : 'Tab Danh sách đăng ký CHƯA có cột SĐT phụ huynh (tên cột như "SĐT bố", "SĐT mẹ", "SĐT ưu tiên", "Zalo"). Cần thêm để đối chiếu.');
      book.paid.forEach(p => { const pi = A.columnsInfo(p.rows); add('paid-' + p.name, !!pi, 'Tab "' + p.name.slice(0, 40) + '": ' + (pi ? (p.rows.length - pi.headerRow) + ' dòng, ' + pi.phones + ' cột SĐT' : 'không thấy cột MDT') + '.'); });
      if (book.skipped.length) add('skipped', false, 'Tab (ĐP) chưa đọc được vì tên không kết thúc bằng "(ĐP)": ' + book.skipped.slice(0, 5).map(s => '"' + s.slice(0, 40) + '"').join(', ') + '.');
      const ag = A.aggregate({ reg: book.reg, paid: book.paid, skipped: book.skipped, collect: true, today: A.isDayKey(todayArg) ? todayArg : C.dates.todayVN() });
      if (!ag.ok) add('aggregate', false, ag.error);
      else {
        const S = Object.values(ag.students), ext = S.filter(s => !s.int), paid = ext.filter(s => s.paid), has = s => (s.ph && s.ph.length) || (s.em && s.em.length);
        const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '—';
        add('coverage', paid.length ? paid.filter(has).length / paid.length >= 0.9 : false, 'Học sinh ngoài (không nội bộ) có SĐT/email: ' + ext.filter(has).length + '/' + ext.length + ' (' + pct(ext.filter(has).length, ext.length) + '); đã đóng phí có SĐT/email: ' + paid.filter(has).length + '/' + paid.length + ' (' + pct(paid.filter(has).length, paid.length) + '). Cần từ 90% để kết quả đáng tin.');
      }
    } catch (e) { add('read', false, e && e.expose ? e.message : 'Không đọc được Google Sheet.'); }
  }
  try { out.meta = await checkLeads({ token: String(env.META_ACCESS_TOKEN || '').trim(), accts: syncAccounts(C, env).accts, env }); }
  catch (e) { out.meta.steps.push({ id: 'meta', ok: false, text: e && e.expose ? e.message : 'Không kiểm tra được Meta.' }); }
  return out;
}
