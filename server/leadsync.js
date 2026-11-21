// Điều phối cập nhật tự động: đọc Google Sheet DATA TUYỂN SINH → lấy lead Facebook → đối chiếu từng phụ huynh → ghi SỐ TỔNG HỢP.
// Họ tên, ngày sinh, số điện thoại, email (của học sinh trong Sheet và của phụ huynh trong lead) chỉ nằm trong bộ nhớ của hàm lúc tính:
// không ghi vào Firestore, không ghi log. Tài liệu được ghi: `fbmatch` (số theo ngày × chiến dịch), `admissions` (tổng hợp từ Sheet), `leadsync` (trạng thái).
import { sheetIdFrom, readAdmissionsSheet, serviceAccountInfo } from './gsheets.js';
import { fetchLeads, checkLeads, NO_LEADS_HINT, emptyRead, thinRead } from './leads.js';
import { syncAccounts } from './scope.js';
import { readDocs, writeDocs } from './store.js';
import { describeUnknown } from './safelog.js';

const LOCK_MS = 300000;
/** Mã các chốt chặn có thể ghi đè. Quản trị xác nhận TỪNG chốt chặn đã chạm: force là danh sách mã đã xác nhận (hoặc true = tất cả), chốt chặn chưa được xác nhận vẫn dừng. */
export const GUARDS = ['stored', 'season', 'empty', 'campaign', 'drop', 'sheet'];
const ackOf = force => new Set(force === true ? GUARDS : Array.isArray(force) ? force.filter(g => GUARDS.indexOf(g) >= 0) : []);
const fail = (message, extra = {}) => Object.assign(new Error(message), { expose: true, status: 502 }, extra);

/** Đã cấu hình đủ để chạy tự động chưa. */
export function leadSyncConfig(env = process.env) {
  const sheet = !!sheetIdFrom(env.ADMISSIONS_SHEET_ID), meta = !!String(env.META_ACCESS_TOKEN || '').trim();
  return { sheet, sheetSet: !!String(env.ADMISSIONS_SHEET_ID || '').trim(), meta, ready: sheet && meta };
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

/** Sheet đọc lần này kém hẳn lần trước cho cùng mùa → danh sách lý do (rỗng nếu ổn): tab ĐP mất, số học sinh tụt, phủ SĐT tụt, tỷ lệ nội bộ nhảy.
 *  Một tab bị đổi tên, bị xoá trống khi dán, cột SĐT bị sửa tiêu đề… sẽ cho số "đọc được" nhưng hụt: không được ghi đè số đúng (và không được đóng băng số hụt). */
export function degradedReasons(prevAdm, sum, prevCov, cov) {
  const out = [], pct = x => Math.round(x * 100) + '%', rate = (a, b) => b > 0 ? a / b : 0;
  if (prevAdm) {
    const lost = Object.keys(prevAdm.paidSheets || {}).filter(k => !(k in (sum.paidSheets || {})));
    if (lost.length) out.push('không còn đọc được tab ĐP ' + lost.slice(0, 3).map(s => '"' + s + '"').join(', '));
    if (prevAdm.total.reg >= 20 && sum.total.reg < prevAdm.total.reg * 0.7) out.push('số học sinh đăng ký giảm từ ' + prevAdm.total.reg + ' xuống ' + sum.total.reg);
    if (prevAdm.total.paid >= 20 && sum.total.paid < prevAdm.total.paid * 0.7) out.push('số học sinh đã đóng phí giảm từ ' + prevAdm.total.paid + ' xuống ' + sum.total.paid);
    const a = rate(prevAdm.total.regInt, prevAdm.total.reg), b = rate(sum.total.regInt, sum.total.reg);
    if (prevAdm.total.reg >= 20 && Math.abs(a - b) > 0.2) out.push('tỷ lệ học sinh nội bộ đổi từ ' + pct(a) + ' sang ' + pct(b));
    // cột ngày bị đổi tên: học sinh đăng ký trước khi phụ huynh điền form sẽ bị tính nhầm vào quảng cáo
    if (prevAdm.hasRegDate && !sum.hasRegDate) out.push('cột Ngày đăng ký không còn đọc được');
    if (prevAdm.hasPaidDate && !sum.hasPaidDate) out.push('cột Ngày đóng phí không còn đọc được');
  }
  if (prevCov && cov) {
    const a = rate(prevCov.extWithPhone, prevCov.ext), b = rate(cov.extWithPhone, cov.ext), c = rate(prevCov.paidExtWithPhone, prevCov.paidExt), d = rate(cov.paidExtWithPhone, cov.paidExt);
    if (prevCov.ext >= 20 && b < a - 0.2) out.push('học sinh có SĐT/email giảm từ ' + pct(a) + ' xuống ' + pct(b));
    if (prevCov.paidExt >= 20 && d < c - 0.2) out.push('học sinh đã đóng phí có SĐT/email giảm từ ' + pct(c) + ' xuống ' + pct(d));
    const e1 = rate(prevCov.extWithRegDate, prevCov.ext), e2 = rate(cov.extWithRegDate, cov.ext);
    if (prevCov.ext >= 20 && e2 < e1 - 0.2) out.push('học sinh có Ngày đăng ký giảm từ ' + pct(e1) + ' xuống ' + pct(e2));
  }
  return out;
}

/**
 * Chạy một lần cập nhật đầy đủ.
 * @param {{by?:string, env?:object, force?:boolean|string[]}} opt  force: danh sách mã chốt chặn (GUARDS) mà quản trị đã xác nhận bỏ qua, hoặc true = tất cả (chỉ quản trị bấm tay)
 * @returns {Promise<{ok:true, ms:number, stats:object}>} số tổng hợp, không có dữ liệu cá nhân
 */
export async function runLeadSync({ by = 'cron', env = process.env, force = false, today: todayArg, store = { readDocs, writeDocs } } = {}) {
  const started = Date.now(), cfg = leadSyncConfig(env), ack = ackOf(force);
  if (!cfg.sheet) throw fail(cfg.sheetSet ? 'ADMISSIONS_SHEET_ID trên Vercel không đúng dạng: dán đường dẫn (…/spreadsheets/d/<mã>/…) hoặc mã của Google Sheet DATA TUYỂN SINH, không kèm dấu cách hay ký tự lạ.' : 'Chưa đặt ADMISSIONS_SHEET_ID (đường dẫn hoặc ID của Google Sheet DATA TUYỂN SINH) trên Vercel.', { status: 501 });
  if (!cfg.meta) throw fail('Chưa cấu hình META_ACCESS_TOKEN nên chưa lấy được lead Facebook.', { status: 501 });
  const { C, A, M } = await libs();
  const today = A.isDayKey(todayArg) ? todayArg : C.dates.todayVN();
  const prevDocs = await store.readDocs(['leadsync', 'fbmatch', 'admissions']);
  const left = (prevDocs.leadsync && prevDocs.leadsync.runningUntil ? Date.parse(prevDocs.leadsync.runningUntil) : 0) - Date.now();
  // khoá xa hơn nhiều so với hạn tối đa là dữ liệu hỏng: bỏ qua thay vì chặn cập nhật mãi
  if (left > 0 && left <= LOCK_MS * 2) throw fail('Đang có một lần cập nhật khác chạy. Đợi vài phút rồi thử lại.', { status: 409, busy: true });
  const base = { v: 1, at: new Date().toISOString(), by: String(by).slice(0, 20) };
  await store.writeDocs({ leadsync: Object.assign({}, prevDocs.leadsync || {}, { runningUntil: new Date(started + LOCK_MS).toISOString() }) }, { by: base.by });
  let stage = 'sheet';
  try {
    const book = await readAdmissionsSheet(env.ADMISSIONS_SHEET_ID, { pickTabs: A.pickTabs, env });
    const ag = A.aggregate({ reg: book.reg, paid: book.paid, skipped: book.skipped, collect: true, today });
    if (!ag.ok) throw fail('Google Sheet: ' + ag.error, { status: 422 });
    const vs = A.validate(ag.summary); if (!vs.ok) throw fail('Số tổng hợp từ Google Sheet không hợp lệ: ' + vs.error, { status: 422 });
    if (!Object.values(ag.students).some(s => (s.ph && s.ph.length) || (s.em && s.em.length))) throw fail('Không thấy số điện thoại hay email nào của học sinh trong Google Sheet nên chưa đối chiếu được. Thêm cột SĐT bố, SĐT mẹ (hoặc SĐT ưu tiên) vào tab Danh sách đăng ký và các tab ĐP; nếu đã có, kiểm tra tên cột (nút “Kiểm tra kết nối” cho biết số cột SĐT nhận ra ở từng tab).', { status: 422 });
    // Mùa tuyển sinh đọc từ tiêu đề cột Khối ("Khối 27 28"). Gõ nhầm năm (hoặc mất chữ mùa) không được làm mất số đã gộp của mùa đang chạy: dừng và nói rõ thay vì bắt đầu lại.
    const span = A.seasonSpan(vs.summary), prevSeason = prevDocs.fbmatch && typeof prevDocs.fbmatch.season === 'string' ? prevDocs.fbmatch.season : '';
    if (span && (today < A.addDays(span.start, -92) || today > A.addDays(span.end, 92))) throw fail('Mùa tuyển sinh ghi ở tiêu đề cột Khối của Sheet (' + vs.summary.season + ') không khớp với ngày hôm nay (' + today + '). Hãy kiểm tra năm trong tiêu đề; chưa cập nhật để không ghi đè số liệu đang đúng.', { status: 422 });
    if (!span && prevSeason) throw fail('Không đọc được mùa tuyển sinh ở tiêu đề cột Khối của Sheet (lần trước là ' + prevSeason + ', ví dụ "Khối 27 28"). Chưa cập nhật để không ghi đè số liệu đang đúng.', { status: 422 });
    // Số đã gộp của lần trước chỉ bị bỏ khi chuyển sang mùa khác hợp lệ (cả hai mùa đều đọc được và khác nhau). Số lưu không còn đọc được theo cấu trúc hiện tại thì không tự bỏ: dừng để quản trị quyết định.
    const pv = prevDocs.fbmatch && M.validate(prevDocs.fbmatch);
    if (prevDocs.fbmatch && !(pv && pv.ok) && !ack.has('stored')) throw fail('Số đối chiếu đang lưu không đọc được theo cấu trúc hiện tại (' + String(pv && pv.error || 'sai dạng').slice(0, 120) + ') nên chưa ghi đè. Nếu bạn chắc muốn bắt đầu lại từ lead còn đọc được (90 ngày gần nhất), bấm lại “Cập nhật ngay” với tuỳ chọn ghi đè.', { status: 409, canForce: true, guards: ['stored'] });
    // Hai mùa hợp lệ nhưng khác nhau: chỉ được sang mùa SAU. Mùa cùng năm bắt đầu hoặc sớm hơn (gõ nhầm "27 29" thay vì "27 28") thì dừng, không bỏ số đã chốt của mùa đang chạy.
    const pSeason = pv && pv.ok && pv.match.season || '', pSpan = pSeason ? A.seasonSpan({ season: pSeason }) : null;
    if (!ack.has('season') && pSpan && span && (vs.summary.season || '') !== pSeason && !(span.start > pSpan.start)) throw fail('Mùa tuyển sinh ghi ở tiêu đề cột Khối (' + vs.summary.season + ') khác mùa đang lưu (' + pSeason + ') nhưng không phải mùa sau: có thể gõ nhầm năm. Chưa cập nhật để không bỏ số đã chốt của mùa đang chạy. Nếu đúng là mùa mới, quản trị bấm lại “Cập nhật ngay” với tuỳ chọn ghi đè.', { status: 409, canForce: true, guards: ['season'] });
    stage = 'meta';
    const accts = syncAccounts(C, env).accts;
    const raw = await fetchLeads({ token: String(env.META_ACCESS_TOKEN).trim(), accts, sinceDay: A.addDays(today, -90), env });
    // Meta báo các biểu mẫu mới tạo có lead nhưng không trả lead nào: không phải "0 lead" thật mà là chưa đủ quyền đọc lead (ứng dụng Development, thiếu Leads access).
    // Cũng dừng khi Meta chỉ trả một phần nhỏ (ví dụ ứng dụng Development chỉ thấy lead của người có vai trò: vài lead thử trong hàng trăm): lần đọc đầu mà ghi nhận vài lead sẽ làm mất các ngày 60–90 trước vì sau đó không đọc lại được.
    // Chỉ canh lần đọc ĐẦU (chưa có số đã lưu cùng mùa): từ lần sau chốt chặn "drop" so với số đã lưu, và chốt chặn này không được chặn mãi cron sau khi quản trị đã chấp nhận một lần ghi đè.
    const ck = raw.check, firstRead = !(pv && pv.ok && pv.match.days && Object.keys(pv.match.days).length && (!pv.match.season || pv.match.season === (vs.summary.season || '')));
    if (!ack.has('empty') && ck && (emptyRead(ck.expected, ck.got) || (firstRead && thinRead(ck.expected, ck.got, raw.leads.length)))) throw fail('Meta báo các biểu mẫu tạo trong 80 ngày qua có ' + ck.expected + ' lead nhưng ' + (ck.got === 0 ? 'không trả lead nào' : 'chỉ trả ' + ck.got) + ': ' + NO_LEADS_HINT + ' Nếu lead thật sự đã bị xoá, quản trị bấm lại với tuỳ chọn ghi đè.', { status: 409, canForce: true, guards: ['empty'] });
    // Nhiều lead quảng cáo không tra được chiến dịch (Meta lỗi, hết giờ): chúng sẽ rơi vào "chưa rõ chiến dịch" và làm sai số theo chương trình, kể cả của các ngày sắp được chốt.
    if (!ack.has('campaign') && raw.unresolved > Math.max(3, raw.leads.length * 0.03)) throw fail('Không tra được chiến dịch của ' + raw.unresolved + '/' + raw.leads.length + ' lead nên chưa ghi đè: số theo chương trình sẽ sai. Thử lại sau vài phút; nếu vẫn vậy, quản trị bấm lại với tuỳ chọn ghi đè.', { status: 409, canForce: true, guards: ['campaign'] });
    stage = 'match';
    const next = M.matchLeads(raw.leads.map(M.leadFromGraph), ag.students);
    next.season = vs.summary.season || '';
    // Dòng ở tab ĐP không nối được với Danh sách đăng ký (MDT không có hoặc sai) không thành học sinh nên không khớp được với phụ huynh: ghi số đếm để trang cảnh báo
    next.cov.unlinkedPaid = ((vs.summary.checks && vs.summary.checks.paidNotInRegistration) || 0) + ((vs.summary.checks && vs.summary.checks.skippedPaid) || 0);
    const prev = pv && pv.ok && (!pv.match.season || pv.match.season === next.season) ? pv.match : null;
    const from = M.windowFrom(today), before = leadsFrom(prev, from), after = leadsFrom(next, from);
    // Mọi chốt chặn được xét hết rồi báo một lần (cờ ghi đè bỏ qua tất cả, nên quản trị phải thấy đủ các lý do trước khi xác nhận)
    const reasons = [], fired = [];
    if (!ack.has('drop') && prev && before >= 20 && after < before * 0.7) { fired.push('drop'); reasons.push('Số lead đọc được lần này (' + after + ') thấp hơn hẳn lần trước (' + before + ') cho cùng khoảng ngày. Kiểm tra quyền đọc lead của token Meta và các biểu mẫu.'); }
    // Sheet đọc kém hẳn lần trước (cùng mùa): dừng trước khi ghi đè hay đóng băng số hụt
    if (!ack.has('sheet')) {
      const pa = prevDocs.admissions && A.validate(prevDocs.admissions), prevAdm = pa && pa.ok && pa.summary.season === vs.summary.season ? pa.summary : null;
      const why = degradedReasons(prevAdm, vs.summary, prev && prev.cov, next.cov);
      if (why.length) fired.push('sheet'), reasons.push('Google Sheet đọc lần này khác hẳn lần trước (' + why.join('; ') + '). Kiểm tra tab và tên cột trong Sheet (có thể một tab bị đổi tên, bị xoá trống, cột SĐT hay cột ngày bị sửa tiêu đề).');
    }
    if (reasons.length) throw fail(reasons.join(' ') + ' Chưa ghi đè số liệu đang đúng; nếu số mới là đúng, quản trị bấm lại “Cập nhật ngay” với tuỳ chọn ghi đè.', { status: 409, canForce: true, guards: fired });
    // Lần đọc này đủ SĐT hoặc ngày hơn lần trước (một cổng độ phủ vừa mở): các ngày đã chốt trước đó được tính khi còn thiếu nên tính lại cả khoảng lead đọc được; ngày cũ hơn thì Meta không cho đọc lại, giữ nguyên và đánh dấu (lowCovUntil).
    const gain = !!(prev && M.coverageGain(prev.cov, next.cov));
    // Lần trước chỉ đọc được một phần nhỏ số lead hiện tại (ví dụ ứng dụng Meta còn Development nên chỉ thấy vài lead của người có vai trò; biểu mẫu cũ hơn 80 ngày nên chốt chặn "empty" chưa canh được) không phải lịch sử thật:
    // dựng lại cả cửa sổ đọc được như lần đầu, nếu không các ngày 60–90 trước bị chốt rỗng và không bao giờ đọc lại được (Meta chỉ giữ lead 90 ngày).
    const thinPrev = !!(prev && prev.leads && next.leads.rows >= 20 && (Number(prev.leads.rows) || 0) * 3 < next.leads.rows), rebuild = gain || thinPrev;
    let mergeFrom = from;
    // Sau một đợt gián đoạn (token hết hạn, chốt chặn chờ xác nhận…): các ngày còn "sống" (dưới 60 ngày) ở lần chạy tốt cuối vẫn phải được tính lại; giữ 14 ngày đầu cửa sổ đọc làm vùng nhận ra phụ huynh điền form từ trước.
    const lastGood = prev && A.vnDate(prev.syncedAt);
    if (lastGood && next.winFrom) { const gf = M.windowFrom(lastGood), floor = A.addDays(next.winFrom, 14); if (gf < mergeFrom) mergeFrom = gf > floor ? gf : floor; if (mergeFrom > from) mergeFrom = from; }
    if (rebuild && next.winFrom) mergeFrom = next.winFrom;
    // Một lần trước không có ngày nào (đọc rỗng vì Meta chưa cho đọc lead) không được coi là đã chốt lịch sử: gộp như lần đầu để vẫn giữ các ngày 60–90 trước còn đọc được
    const mergePrev = prev && prev.days && Object.keys(prev.days).length ? prev : null;
    const merged = M.mergeMatch(mergePrev, next, mergeFrom); merged.syncedAt = new Date().toISOString();
    if (prev && prev.lowCovUntil) merged.lowCovUntil = prev.lowCovUntil;
    // Ba mươi ngày đầu của vùng tính lại chưa có vùng nhận ra phụ huynh điền form từ trước (lead cũ hơn 90 ngày không đọc lại được) nên chỉ gần đúng: đánh dấu cùng các ngày cũ hơn còn giữ số đã chốt
    if (gain && prev.from && next.winFrom && prev.from < next.winFrom) merged.lowCovUntil = [merged.lowCovUntil, A.addDays(next.winFrom, 30)].filter(Boolean).sort().pop();
    const vm = M.validate(merged); if (!vm.ok) throw fail('Kết quả đối chiếu không hợp lệ: ' + vm.error, { status: 500 });
    stage = 'write';
    const stats = { rows: next.leads.rows, parents: next.leads.parents, matched: next.leads.matched, students: next.cov.students, studentsWithPhone: next.cov.withPhone, paidExt: next.cov.paidExt, paidExtWithPhone: next.cov.paidExtWithPhone, forms: raw.forms, pages: raw.pages, skippedForms: raw.skippedForms, from: next.winFrom };
    const ms = Date.now() - started;
    await store.writeDocs({
      ...(pv && pv.ok ? { fbmatch_prev: prevDocs.fbmatch } : {}),   // một bản sao của số đã gộp trước đó, để quay lại được nếu một lần ghi sai lọt qua các chốt chặn
      // đổi mùa: số của mùa cũ được giữ ở tài liệu riêng (fbmatch_<mùa>) vì lead cũ hơn 90 ngày không dựng lại được
      ...(pSeason && pSeason !== next.season ? { ['fbmatch_' + pSeason.replace(/\D/g, '')]: prevDocs.fbmatch } : {}),
      ...(prevDocs.fbmatch && !(pv && pv.ok) ? { fbmatch_invalid: prevDocs.fbmatch } : {}),                       // số lưu không đọc được (đã được quản trị xác nhận bỏ): giữ lại một bản để xem hay khôi phục thủ công
      fbmatch: vm.match,
      admissions: Object.assign({}, vs.summary, { uploadedAt: new Date().toISOString(), by: null, source: 'sheet' }),
      leadsync: Object.assign({}, base, { ok: true, stage: null, error: null, ms, stats, runningUntil: null })
    }, { by: base.by });
    return { ok: true, ms, stats };
  } catch (e) {
    const msg = e && e.expose ? String(e.message).slice(0, 400) : 'Lỗi không rõ khi cập nhật. Xem log của hàm trên Vercel.';
    await store.writeDocs({ leadsync: Object.assign({}, base, { ok: false, stage, error: msg, ms: Date.now() - started, stats: null, runningUntil: null }) }, { by: base.by }).catch(() => {});
    if (e && e.expose) e.stage = stage; else console.error('[leadsync] lỗi không rõ ở bước ' + stage + ':', describeUnknown(e));
    throw e;
  }
}

/** Cho cron: chỉ chạy khi đã cấu hình và lần cập nhật thành công gần nhất đã cũ (mặc định 12 giờ: cron /api/sync lúc 05:30 và /api/insights lúc 07:15 không chạy trùng nhau, còn bấm tay trước 17:30 hôm trước thì sáng hôm sau vẫn cập nhật, sau 17:30 thì bỏ qua vì số còn mới); lỗi không làm hỏng việc gọi nó. */
export async function maybeLeadSync({ by = 'cron', env = process.env, staleMs = 12 * 3600000, store = { readDocs, writeDocs } } = {}) {
  if (!leadSyncConfig(env).ready) return { skipped: 'chưa cấu hình' };
  try {
    const s = (await store.readDocs(['leadsync'])).leadsync;
    if (s && s.ok && s.at && Date.now() - Date.parse(s.at) < staleMs) return { skipped: 'còn mới' };
    return await runLeadSync({ by, env, store });
  } catch (e) { console.error('[leadsync] cập nhật tự động lỗi:', e && e.expose ? e.message : describeUnknown(e)); return { ok: false, error: e && e.expose ? e.message : 'lỗi', stage: e && e.stage }; }
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
      const hn = a => a.length ? ' (' + a.slice(0, 6).map(s => '"' + s + '"').join(', ') + ')' : '';
      add('phones-reg', !!ri && ri.phones > 0, ri && ri.phones > 0 ? 'Tab Danh sách đăng ký có ' + ri.phones + ' cột SĐT' + hn(ri.phoneHeaders) + (ri.emails ? ', ' + ri.emails + ' cột email' + hn(ri.emailHeaders) : '') + '.' : 'Tab Danh sách đăng ký CHƯA có cột SĐT phụ huynh (tên cột như "SĐT bố", "SĐT mẹ", "SĐT ưu tiên", "Zalo"). Cần thêm để đối chiếu.');
      book.paid.forEach(p => { if (!p.rows.length && (book.otherSeasonNames || []).indexOf(p.name) >= 0) { add('paid-' + p.name, true, 'Tab "' + p.name.slice(0, 40) + '": của mùa khác, không đọc.'); return; } const pi = A.columnsInfo(p.rows); add('paid-' + p.name, !!pi, 'Tab "' + p.name.slice(0, 40) + '": ' + (pi ? (p.rows.length - pi.headerRow) + ' dòng, ' + pi.phones + ' cột SĐT' + (pi.phones ? hn(pi.phoneHeaders) : '') : 'không thấy cột MDT') + '.'); });
      if (book.skipped.length) add('skipped', false, 'Tab (ĐP) chưa đọc được vì tên không kết thúc bằng "(ĐP)": ' + book.skipped.slice(0, 5).map(s => '"' + s.slice(0, 40) + '"').join(', ') + '.');
      const ag = A.aggregate({ reg: book.reg, paid: book.paid, skipped: book.skipped, collect: true, today: A.isDayKey(todayArg) ? todayArg : C.dates.todayVN() });
      if (!ag.ok) add('aggregate', false, ag.error);
      else {
        const S = Object.values(ag.students), ext = S.filter(s => !s.int), paid = ext.filter(s => s.paid), has = s => (s.ph && s.ph.length) || (s.em && s.em.length);
        const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '—';
        // đủ khi CẢ học sinh ngoài nội bộ (để hiện số đăng ký) VÀ học sinh đã đóng phí (để hiện số đóng phí) đều có SĐT/email từ 90%: cùng ngưỡng với các cổng độ phủ của trang
        add('coverage', paid.length > 0 && paid.filter(has).length / paid.length >= 0.9 && ext.length > 0 && ext.filter(has).length / ext.length >= 0.9, 'Học sinh ngoài (không nội bộ) có SĐT/email: ' + ext.filter(has).length + '/' + ext.length + ' (' + pct(ext.filter(has).length, ext.length) + '); đã đóng phí có SĐT/email: ' + paid.filter(has).length + '/' + paid.length + ' (' + pct(paid.filter(has).length, paid.length) + '). Cần từ 90% để kết quả đáng tin.');
        const dated = ext.filter(s => s.rd).length; add('dates', ext.length > 0 && dated / ext.length >= 0.9, 'Ngày đăng ký đọc được ở ' + dated + '/' + ext.length + ' học sinh ngoài nội bộ (' + pct(dated, ext.length) + '). Cần từ 90% để loại học sinh đã đăng ký trước khi phụ huynh điền form.');
      }
    } catch (e) { add('read', false, e && e.expose ? e.message : 'Không đọc được Google Sheet.'); }
  }
  try { out.meta = await checkLeads({ token: String(env.META_ACCESS_TOKEN || '').trim(), accts: syncAccounts(C, env).accts, env }); }
  catch (e) { out.meta.steps.push({ id: 'meta', ok: false, text: e && e.expose ? e.message : 'Không kiểm tra được Meta.' }); }
  return out;
}
