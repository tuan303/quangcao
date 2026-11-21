// Kiểm thử offline cho phần Chuyển đổi tuyển sinh: đọc bảng, tổng hợp, kiểm tra dữ liệu gửi lên, ghép chiến dịch, tỷ lệ chuyển đổi.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../fbads-core.js';
import '../admissions.js';
import { scanText, scanHistory, accepted, decodeText, sniffData, DATA_FILE } from './scan-history.mjs';
const A = globalThis.FBAdm, C = globalThis.FBCore;

const ZIP = new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, ...Buffer.from('xl/workbook.xml')]); // đầu file .xlsx (zip) có tệp xl/workbook.xml
const HDR = ['MDT', 'HS nội bộ', 'Họ tên học sinh', 'Ngày sinh', 'Giới tính', 'Khối 27 28', 'Lớp', 'Trường học', 'Chiến dịch'];
const stu = (mdt, internal, khoi, prog, extra = []) => [mdt, internal, 'TÊN HỌC SINH ' + mdt, '2016-01-01', 'Nam', khoi, null, 'Trường ABC', prog, ...extra];
function sampleInput(withDates) {
  const hdr = withDates ? HDR.concat(['Ngày đăng ký', 'Ngày đóng phí']) : HDR;
  const d = (a, b) => withDates ? [a, b] : [];
  const reg = [[2434, 865], hdr,
    stu(1001, null, 'Khối 6', 'TS6', d('01/10/2026', 46305)),   // 46305 = 10/10/2026
    stu(1002, 20000001, 'Khối 6', 'TS6', d('02/10/2026', null)),
    stu(1003, null, 'Khối 10', 'TS10', d('2026-10-03', '2026-10-12')),
    stu(1004, null, 'Khối 1', 'JS', d(46296, null)),
    stu(1004, null, 'Khối 1', 'JS', d(46296, null)),           // trùng MDT
    stu(1005, null, 'Khối 2', 'HB', d(46297, 46299)),
    stu(1006, null, 'Khối 1', 'TS1', d(46297, null)),
    [null, null, null]];
  const paid = [
    { name: 'LỚP 6 2728 (ĐP)', rows: [[], [null, null, 'Count'], ['MDT', 'HS nội bộ', 'Họ tên học sinh'], [630], [1001, null, 'TÊN', '2016-01-01'], [1002, 20000001, 'TÊN', '2016-01-01'], [9999, null, 'KHÔNG CÓ TRONG DS', '2016-01-01']] },
    { name: 'HB 2728 (ĐP)', rows: [['MDT', 'HS nội bộ', 'Họ tên học sinh'], [355], [1005, null, 'TÊN', '2016-01-01']] }
  ];
  return { reg, paid };
}

test('programOf: tiền tố TS10/TS6/TS1/JS đi trước, "học bổng"/"HB" chỉ khi chưa có tiền tố', () => {
  const t = { 'TS6-LEAD | Form TS6 | Fanpage trường': 'TS6', 'TS6-LEAD | Học bổng | Lớp 6': 'TS6', 'TS10-LEAD | Tư vấn | Lớp 10': 'TS10', 'TS1-LEAD | Form tham quan | Lớp 1': 'TS1',
    'TS1-NHẮN TIN FANPAGE': 'TS1', 'JS26-LEAD | Lạnh | Trường 10km': 'JS', 'Jolly Step TT': 'JS', 'KỲ THI HỌC BỔNG [TRAFFIC]': 'HB', 'HB 2027 | Form': 'HB', 'Chiến dịch HB-khối 5': 'HB',
    'Thương hiệu | Video thành tích học sinh': null, 'Trại hè 2026 | Đăng ký': null, 'UNICONNECT': null, 'PH NHẮN TIN TS6': 'TS6', 'Bài đẩy ts12': null };
  for (const [name, want] of Object.entries(t)) assert.equal(A.programOf(name), want, name);
});

test('parseDate: số seri Excel, dd/mm/yyyy và yyyy-mm-dd; giá trị lạ bị bỏ', () => {
  assert.equal(A.parseDate(46305), '2026-10-10');
  assert.equal(A.parseDate(46305.75), '2026-10-10');
  assert.equal(A.parseDate('01/10/2026'), '2026-10-01');
  assert.equal(A.parseDate('1-9-2026'), '2026-09-01');
  assert.equal(A.parseDate('2026-10-03T00:00:00'), '2026-10-03');
  for (const bad of [null, '', 'abc', 12, 999999999, '31/13/2026', '01/01/1990']) assert.equal(A.parseDate(bad), '', String(bad));
});

test('aggregate (không có cột ngày): đếm theo chương trình, khối, loại HS nội bộ, ĐP từ các tab (ĐP)', () => {
  const r = A.aggregate(sampleInput(false)), s = r.summary;
  assert.ok(r.ok); assert.equal(s.season, '2027–28');
  assert.deepEqual(s.total, { reg: 6, regInt: 1, paid: 3, paidInt: 1 });
  assert.deepEqual(s.programs.TS6, { reg: 2, regInt: 1, paid: 2, paidInt: 1 });
  assert.deepEqual(s.programs.JS, { reg: 1, regInt: 0, paid: 0, paidInt: 0 }); // MDT trùng chỉ tính một lần
  assert.deepEqual(s.programs.HB, { reg: 1, regInt: 0, paid: 1, paidInt: 0 });
  assert.deepEqual(s.khoi['Khối 6'], { reg: 2, regInt: 1, paid: 2, paidInt: 1 });
  assert.equal(s.checks.dupMdt, 1); assert.equal(s.checks.paidNotInRegistration, 1);
  assert.deepEqual(s.paidSheets, { 'LỚP 6 2728 (ĐP)': 2 + 1, 'HB 2728 (ĐP)': 1 }); // dòng đếm "630" và dòng không đủ ô không tính
  assert.equal(s.hasRegDate, false); assert.deepEqual(s.regByDay, {});
});

test('aggregate (có cột ngày): đếm theo ngày đăng ký và ngày đóng phí; ngày đóng phí cũng coi là đã đóng phí', () => {
  const s = A.aggregate(sampleInput(true)).summary;
  assert.ok(s.hasRegDate && s.hasPaidDate);
  assert.equal(s.regByDay['2026-10-01'].TS6[0], 1); assert.equal(s.regByDay['2026-10-02'].TS6[1], 1); // HS nội bộ ở ô thứ hai
  assert.deepEqual(s.regPaidByDay['2026-10-01'].TS6, [1, 0]);   // nhóm đăng ký ngày 01/10 và đã đóng phí
  assert.equal(s.regPaidByDay['2026-10-01'].JS, undefined);      // 1004 đăng ký nhưng chưa đóng phí
  assert.equal(s.paidByDay['2026-10-10'].TS6[0], 1);
  assert.equal(s.paidByDay['2026-10-12'].TS10[0], 1);            // 1003 đóng phí theo cột ngày, không có trong tab ĐP
  assert.equal(s.total.paid, 4);
  assert.equal(s.checks.paidNoDate, 1);                          // 1002 có trong tab ĐP nhưng chưa có ngày đóng phí
  assert.equal(s.checks.regNoDate, 0);
});

test('aggregate: thiếu tab/cột thì báo lỗi rõ ràng', () => {
  assert.equal(A.aggregate({ reg: [['x']], paid: [] }).ok, false);
  assert.match(A.aggregate({ reg: [['MDT', 'Họ tên']], paid: [] }).error, /Chiến dịch/);
  assert.match(A.aggregate({ reg: [['MDT', 'Chiến dịch']], paid: [] }).error, /chưa có học sinh/);
});

test('validate: chỉ giữ số tổng hợp, loại chuỗi lạ, từ chối dạng sai', () => {
  const s = A.aggregate(sampleInput(true)).summary;
  const polluted = JSON.parse(JSON.stringify(s)); polluted.students = [{ name: 'A', phone: '0900000000' }]; polluted.programs.TS6.name = 'Nguyễn Văn A'; polluted.note = '0900000000';
  const v = A.validate(polluted);
  assert.ok(v.ok); assert.ok(!('students' in v.summary) && !('note' in v.summary) && !('name' in v.summary.programs.TS6));
  assert.equal(JSON.stringify(v.summary).includes('Nguyễn'), false); assert.equal(JSON.stringify(v.summary).includes('0900'), false);
  assert.deepEqual(v.summary.total, s.total);
  const mut = f => { const x = JSON.parse(JSON.stringify(s)); f(x); return A.validate(x).ok; };
  assert.equal(mut(x => { x.programs['Nguyễn Văn A'] = x.programs.TS6; }), false);       // mã chương trình là chuỗi lạ
  assert.equal(mut(x => { x.khoi['Lớp 5A1 Nguyễn'] = x.khoi['Khối 6']; }), false);
  assert.equal(mut(x => { x.regByDay['hôm qua'] = {}; }), false);
  assert.equal(mut(x => { x.regByDay['2026-10-01'].TS6 = ['a', 'b']; }), false);
  assert.equal(mut(x => { x.regPaidByDay['bad'] = {}; }), false);
  assert.equal(mut(x => { x.programs.TS6.paid = 99; }), false);                          // đóng phí nhiều hơn đăng ký
  assert.equal(mut(x => { x.total.reg = -1; }), false);
  assert.equal(mut(x => { x.paidSheets['<script>'] = 1; }), false);
  assert.equal(A.validate(null).ok, false); assert.equal(A.validate({ v: 2 }).ok, false);
});

test('funnel: tỷ lệ theo mùa (không có ngày) loại HS nội bộ và không tính phần trăm khi mẫu quá nhỏ', () => {
  const sum = { v: 1, total: {}, programs: { TS6: { reg: 700, regInt: 270, paid: 600, paidInt: 250 }, HB: { reg: 8, regInt: 0, paid: 5, paidInt: 0 }, TS1: { reg: 0, regInt: 0, paid: 0, paidInt: 0 } }, hasRegDate: false, hasPaidDate: false, regByDay: {}, paidByDay: {} };
  const fb = { TS6: { leads: 1000, spend: 60e6, camps: 3 }, HB: { leads: 6, spend: 1e6, camps: 1 }, other: { leads: 50, spend: 9e6, camps: 2 } };
  const f = A.funnel(sum, fb, '2026-08-01', '2026-11-19'), r = Object.fromEntries(f.rows.map(x => [x.k, x]));
  assert.equal(f.mode, 'season');
  assert.equal(r.TS6.regExt, 430); assert.equal(r.TS6.paidExt, 350);
  assert.equal(r.TS6.leadToReg, 0.43); assert.equal(r.TS6.regToPaid, 350 / 430); assert.equal(r.TS6.leadToPaid, 0.35);
  assert.equal(r.TS6.costPerPaid, 60e6 / 350); assert.equal(r.TS6.costPerReg, 60e6 / 430);
  assert.equal(r.HB.leadToReg, null); assert.equal(r.HB.regToPaid, null);      // dưới 10: không tính phần trăm
  assert.equal(r.TS1.regExt, 0); assert.equal(r.TS1.costPerPaid, null);
  assert.equal(f.total.regExt, 438); assert.equal(f.total.paidExt, 355); assert.equal(f.total.leads, 1006); assert.equal(f.other.spend, 9e6);
});

test('funnel: có cột Ngày đăng ký thì lấy nhóm học sinh đăng ký trong kỳ và số em trong nhóm đã đóng phí', () => {
  const sum = A.aggregate(sampleInput(true)).summary;
  assert.equal(A.funnel(sum, {}, '2026-10-01', '2026-10-31').mode, 'dated');
  const pick = (f, k) => f.rows.find(x => x.k === k);
  const f = A.funnel(sum, { TS6: { leads: 40, spend: 4e6, camps: 1 } }, '2026-10-01', '2026-10-05');
  assert.deepEqual([pick(f, 'TS6').regExt, pick(f, 'TS6').regInt, pick(f, 'TS6').paidExt, pick(f, 'TS6').paidInt], [1, 1, 1, 1]);
  assert.deepEqual([pick(f, 'TS10').regExt, pick(f, 'TS10').paidExt], [1, 1]);
  assert.deepEqual([pick(f, 'JS').regExt, pick(f, 'JS').paidExt], [1, 0]);   // đăng ký nhưng chưa đóng phí
  const g = A.funnel(sum, {}, '2026-10-02', '2026-10-02');
  assert.deepEqual([pick(g, 'TS6').regExt, pick(g, 'TS6').regInt, pick(g, 'HB').regExt, pick(g, 'HB').paidExt, pick(g, 'TS1').paidExt], [0, 1, 1, 1, 0]);
  // tỷ lệ đóng phí của nhóm không bao giờ vượt 100% (khác với đếm lượt đóng phí trong kỳ)
  for (const r of A.funnel(sum, {}, '2026-10-01', '2026-10-31').rows) assert.ok(r.paidExt <= r.regExt, r.k);
  // chỉ có cột Ngày đăng ký (chưa có Ngày đóng phí): vẫn tính theo kỳ vì tình trạng đóng phí lấy từ các tab ĐP
  const noPay = A.aggregate((() => { const i = sampleInput(true); i.reg = i.reg.map(r => r.slice(0, 10)); return i; })()).summary;
  assert.ok(noPay.hasRegDate && !noPay.hasPaidDate); assert.equal(A.funnel(noPay, {}, '2026-10-01', '2026-10-05').mode, 'dated');
  assert.equal(A.funnel(noPay, {}, '2026-10-01', '2026-10-05').rows.find(x => x.k === 'TS6').paidInt, 1);
  // không có cột ngày: số tích luỹ cả mùa
  assert.equal(A.funnel(A.aggregate(sampleInput(false)).summary, {}, '2026-10-01', '2026-10-05').mode, 'season');
});

test('fbByProgram: lead và chi tiêu Facebook gom theo chương trình từ tên chiến dịch', () => {
  const mk = (n, obj, spend, leads) => { const v = C.zero(); v[C.MI.spend] = spend; v[C.MI.lead] = leads; v[C.MI.impr] = 1000; return { n, obj, m: v }; };
  const rows = { a: mk('TS6-LEAD | Form', 'OUTCOME_LEADS', 3e6, 30), b: mk('TS6 nhắn tin', 'OUTCOME_ENGAGEMENT', 1e6, 4), c: mk('JS26-LEAD', 'OUTCOME_LEADS', 2e6, 20), d: mk('Thương hiệu', 'OUTCOME_AWARENESS', 5e5, 0), e: mk('Học bổng 2027', 'OUTCOME_LEADS', 1e6, 8) };
  const A1 = '895057262833914', day = '2026-10-10', dv = C.zero(); dv[C.MI.spend] = 7.5e6; dv[C.MI.impr] = 5000;
  const camp = { acct: A1, rows: {}, monthly: {} }, campd = { acct: A1, since: '2026-09-01', rows: {} };
  Object.entries(rows).forEach(([id, x]) => { camp.rows[id] = { n: x.n, obj: x.obj, m: x.m }; campd.rows[id] = { [day]: x.m }; });
  const m = C.model({ ['acct-' + A1]: { acct: A1, daily: { [day]: dv } }, ['camp-' + A1]: camp, ['campd-' + A1]: campd });
  const fb = A.fbByProgram(C, m, [A1], day, day);
  assert.deepEqual([fb.TS6.leads, fb.TS6.spend, fb.TS6.camps], [34, 4e6, 2]);
  assert.deepEqual([fb.JS.leads, fb.JS.spend], [20, 2e6]); assert.deepEqual([fb.HB.leads, fb.HB.spend], [8, 1e6]);
  assert.deepEqual([fb.other.leads, fb.other.spend, fb.other.camps], [0, 5e5, 1]);
  assert.equal(fb.TS1.camps, 0);
});

test('readWorkbook: chọn tab "Danh sách đăng ký" và các tab (ĐP), bỏ qua tab khác', () => {
  const sheets = { 'DATA TUYỂN NGANG': [['x']], 'Danh sách đăng ký': sampleInput(false).reg, 'LỚP 6 2728 (ĐP)': sampleInput(false).paid[0].rows, 'HB 2728 (ĐP)': sampleInput(false).paid[1].rows, HSTN: [[]] };
  const asked = [];
  const X = { read: (buf, o) => { if (o.bookSheets) return { SheetNames: Object.keys(sheets) }; asked.push(o.sheets); return { Sheets: Object.fromEntries(Object.entries(sheets).map(([k, v]) => [k, v])) }; }, utils: { sheet_to_json: ws => ws } };
  const r = A.readWorkbook(X, ZIP);
  assert.ok(r.ok); assert.deepEqual(asked[0], ['Danh sách đăng ký', 'LỚP 6 2728 (ĐP)', 'HB 2728 (ĐP)']);
  assert.equal(r.summary.total.paid, 3);
  assert.equal(A.readWorkbook({ read: () => ({ SheetNames: ['Sheet1'] }), utils: {} }, ZIP).ok, false);
});

test('packOf: gói cho phần Phân tích chỉ gồm số tổng hợp, theo mùa và (khi có ngày) 30 ngày', () => {
  const A1 = '895057262833914', day = '2026-10-10', dv = C.zero(); dv[C.MI.spend] = 3e6; dv[C.MI.impr] = 5000;
  const v = C.zero(); v[C.MI.spend] = 3e6; v[C.MI.lead] = 30; v[C.MI.impr] = 5000;
  const camp = { acct: A1, rows: { a: { n: 'TS6-LEAD | Form', obj: 'OUTCOME_LEADS', m: v } }, monthly: {} }, campd = { acct: A1, since: '2026-09-01', rows: { a: { [day]: v } } };
  const m = C.model({ ['acct-' + A1]: { acct: A1, daily: { [day]: dv } }, ['camp-' + A1]: camp, ['campd-' + A1]: campd });
  const sum = Object.assign(A.aggregate(sampleInput(true)).summary, { uploadedAt: '2026-10-14T10:00:00Z' });
  const p = A.packOf(C, m, [A1], sum, '2026-10-15');
  assert.equal(p.mode, 'dated'); assert.ok(p.last30d && p.prev30d && p.school_year_to_date);
  const t = p.last30d.programs.find(x => x.program === 'TS6');
  assert.equal(t.fb_leads, 30); assert.equal(t.fb_spend, 3e6); assert.equal(t.registered_external, 1);
  assert.equal(A.packOf(C, m, [A1], A.aggregate(sampleInput(false)).summary, '2026-10-15').last30d, undefined);
  const txt = JSON.stringify(p);
  assert.ok(!/TÊN HỌC SINH|Trường ABC|2016-01-01/.test(txt));
  assert.ok(txt.length < 20000);
});

test('aggregate: cột Ngày đóng phí đặt ngay trong tab ĐP cũng được dùng', () => {
  const inp = sampleInput(false);
  inp.paid[0].rows = inp.paid[0].rows.map((r, i) => i === 2 ? r.concat(['Ngày đóng phí']) : (r[0] === 1001 ? [1001, null, 'TÊN', 46305] : r)); // tiêu đề ở dòng thứ ba của tab LỚP 6; cột thứ tư là Ngày đóng phí
  const s = A.aggregate(inp).summary;
  assert.ok(s.hasPaidDate); assert.equal(s.paidByDay['2026-10-10'].TS6[0], 1); assert.equal(s.checks.paidNoDate, 2);
});


/* ---- bổ sung sau rà soát độc lập ---- */
const sheetOf = (hdr, rows) => [[], hdr, ...rows];
const regRows = (extraHdr, rows) => sheetOf(['MDT', 'HS nội bộ', 'Họ tên học sinh', 'Khối 27 28', 'Chiến dịch', ...extraHdr], rows);
const paidTab = (name, rows, hdr = ['MDT', 'HS nội bộ', 'Họ tên học sinh']) => ({ name, rows: [[], hdr, [rows.length], ...rows] });

test('mdtKey: số nguyên dương, chấp nhận "123.0" và số thực sai số nhỏ', () => {
  for (const [v, w] of [[123, '123'], ['123', '123'], [' 0123 ', '123'], ['123.0', '123'], ['123,00', '123'], [123.0000000001, '123'], [0, ''], [-5, ''], [12.5, ''], ['MDT123', ''], ['', ''], [null, ''], [NaN, ''], [{}, ''], [1e13, '']])
    assert.equal(A.mdtKey(v), w, String(v));
});

test('parseDate: ngày phải có thật, năm 2020–2040, nhận yyyy/mm/dd, dd/mm/yy, chữ số seri và hệ ngày 1904', () => {
  for (const bad of ['31/02/2026', '31/04/2026', '2026-02-31', '29/02/2027', 2012, 2050, 46305 - 30000, '15/10/', '2026/13/01', 'hôm qua']) assert.equal(A.parseDate(bad), '', String(bad));
  assert.equal(A.parseDate('29/02/2028'), '2028-02-29');
  assert.equal(A.parseDate('15/10/26'), '2026-10-15'); assert.equal(A.parseDate('2026/10/15'), '2026-10-15'); assert.equal(A.parseDate('2026.1.5'), '2026-01-05');
  assert.equal(A.parseDate('46310'), '2026-10-15'); assert.equal(A.parseDate(' 15 / 10 / 2026 '), '2026-10-15'); assert.equal(A.parseDate('15/10/2026'), '2026-10-15');
  assert.equal(A.parseDate(46305 - 1462, true), '2026-10-10');   // hệ 1904: số seri nhỏ hơn 1462 ngày
});

test('aggregate: nhận các kiểu tiêu đề cột nội bộ, họ tên học sinh, ngày đăng ký/đóng phí', () => {
  for (const h of ['HS nội bộ', 'HSNB', 'H/S nội bộ', 'Học sinh nội bộ', 'Mã HS nội bộ', 'hs  NỘI BỘ', 'Nội bộ']) {
    const r = A.aggregate({ reg: sheetOf(['MDT', h, 'Họ tên học sinh', 'Khối 27 28', 'Chiến dịch'], [[1, 77, 'A', 'Khối 6', 'TS6'], [2, null, 'B', 'Khối 6', 'TS6']]), paid: [paidTab('X (ĐP)', [[1, 77, 'A']])] });
    assert.ok(r.ok, h); assert.equal(r.summary.total.regInt, 1, h);
  }
  const noInternal = A.aggregate({ reg: sheetOf(['MDT', 'Ghi chú nội bộ', 'Họ tên học sinh', 'Chiến dịch'], [[1, 'x', 'A', 'TS6'], [2, null, 'B', 'TS6']]), paid: [paidTab('X (ĐP)', [[1, null, 'A']])] });
  assert.equal(noInternal.ok, false); assert.match(noInternal.error, /HS nội bộ/);
  const dates = A.aggregate({ reg: regRows(['Ngày ĐK', 'Ngày đóng học phí'], [[1, null, 'A', 'Khối 6', 'TS6', '01/10/2026', '03/10/2026'], [2, null, 'B', 'Khối 6', 'TS6', '02/10/2026', null]]), paid: [paidTab('X (ĐP)', [[1, null, 'A']])] }).summary;
  assert.ok(dates.hasRegDate && dates.hasPaidDate);
  const ki = A.aggregate({ reg: regRows(['Ngày đăng kí'], [[1, null, 'A', 'Khối 6', 'TS6', '01/10/2026']]), paid: [paidTab('X (ĐP)', [[1, null, 'A']])] }).summary; assert.ok(ki.hasRegDate);
});

test('aggregate: họ tên phụ huynh đứng trước không làm sai cột tên học sinh; MDT "123.0" ở tab ĐP vẫn ghép; dòng bị bỏ được đếm', () => {
  const reg = sheetOf(['MDT', 'HS nội bộ', 'Họ tên phụ huynh', 'Họ tên học sinh', 'Khối 27 28', 'Chiến dịch'], [
    [101, null, 'PH A', 'HS A', 'Khối 6', 'TS6'], [102, null, 'PH B', 'HS B', 'Khối 6', 'TS6'],
    ['MDT103', null, 'PH C', 'HS C', 'Khối 6', 'TS6'],          // MDT sai: dòng bị bỏ và được đếm
    [104, null, 'PH D', null, 'Khối 6', 'TS6'],                  // thiếu họ tên học sinh
    [null, null, null, null, null, null]]);                      // dòng trống không phải lỗi
  const paid = [{ name: 'LỚP 6 (ĐP)', rows: [['STT', 'MDT', 'Họ tên học sinh'], [1, '101.0', 'HS A'], [2, 102.0000000001, 'HS B'], [3, 'abc', 'HS lạ'], [4, 999, 'Không có trong DS'], [630]] }];
  const r = A.aggregate({ reg, paid }), s = r.summary;
  assert.ok(r.ok); assert.equal(s.total.reg, 2); assert.equal(s.total.paid, 2);          // MDT ở cột B của tab ĐP vẫn đọc được
  assert.equal(s.checks.skippedReg, 2); assert.equal(s.checks.skippedPaid, 1);           // dòng MDT sai/thiếu tên; "abc" có tên nên được đếm, dòng đếm tổng thì không
  assert.equal(s.checks.paidNotInRegistration, 1);
});

test('aggregate: tab ĐP không đọc được được báo; không có tab ĐP và không có cột ngày đóng phí thì từ chối', () => {
  const reg = regRows([], [[1, null, 'A', 'Khối 6', 'TS6'], [2, null, 'B', 'Khối 6', 'TS6']]);
  const r = A.aggregate({ reg, paid: [{ name: 'LỚP 6 (ĐP)', rows: [['Họ tên'], ['A']] }, paidTab('HB (ĐP)', [[1, null, 'A']])], skipped: ['ĐP LỚP 10'] });
  assert.ok(r.ok); assert.deepEqual(r.summary.checks.paidTabsSkipped, ['ĐP LỚP 10', 'LỚP 6 (ĐP)']);
  assert.ok(A.validate(r.summary).ok);
  const none = A.aggregate({ reg, paid: [] }); assert.equal(none.ok, false); assert.match(none.error, /tab \(ĐP\)/);
  assert.ok(A.aggregate({ reg: regRows(['Ngày đóng phí'], [[1, null, 'A', 'Khối 6', 'TS6', 46305]]), paid: [] }).ok);   // có cột Ngày đóng phí thì vẫn tính được
  const twice = A.aggregate({ reg, paid: [paidTab('Tab (ĐP)', [[1, null, 'A']]), paidTab('Tab (ĐP)', [[2, null, 'B']])] }).summary;
  assert.deepEqual(Object.keys(twice.paidSheets).sort(), ['Tab (ĐP)', 'Tab (ĐP) 2']); assert.equal(twice.total.paid, 2);
});

test('modeOf: chỉ xem theo kỳ khi từ 90% học sinh có Ngày đăng ký đọc được', () => {
  const mk = (n, dated, withHeader = true) => {
    const rows = Array.from({ length: n }, (_, i) => [1000 + i, null, 'HS ' + i, 'Khối 6', 'TS6', i < dated ? 46300 + (i % 20) : null]);
    return A.aggregate({ reg: regRows(withHeader ? ['Ngày đăng ký'] : [], rows.map(r => withHeader ? r : r.slice(0, 5))), paid: [paidTab('X (ĐP)', [[1000, null, 'HS 0']])] }).summary;
  };
  for (const [n, d, want] of [[100, 0, 'season'], [100, 5, 'season'], [100, 89, 'season'], [100, 90, 'dated'], [100, 100, 'dated']]) assert.equal(A.modeOf(mk(n, d)), want, d + '/' + n);
  assert.equal(A.modeOf(mk(100, 100, false)), 'season');
  const textDates = A.aggregate({ reg: regRows(['Ngày đăng ký'], Array.from({ length: 50 }, (_, i) => [1000 + i, null, 'HS', 'Khối 6', 'TS6', 'hôm qua'])), paid: [paidTab('X (ĐP)', [[1000, null, 'HS']])] }).summary;
  assert.equal(textDates.hasRegDate, true); assert.equal(textDates.checks.regBadDate, 50); assert.equal(A.modeOf(textDates), 'season');
  assert.ok(A.validate(textDates).ok); assert.equal(A.validate(textDates).summary.checks.regBadDate, 50);   // validate() giữ các số kiểm tra mới
});

test('windowOf: kỳ được cắt theo khoảng file có số đăng ký; kỳ nằm ngoài khoảng đó được báo', () => {
  const rows = Array.from({ length: 40 }, (_, i) => [1000 + i, null, 'HS', 'Khối 6', 'TS6', 46280 + (i % 20), null]);   // 46280 = 15/09/2026 … 04/10/2026
  const sum = Object.assign(A.aggregate({ reg: regRows(['Ngày đăng ký', 'Ngày đóng phí'], rows), paid: [paidTab('X (ĐP)', [[1000, null, 'HS']])] }).summary, { uploadedAt: '2026-10-10T03:00:00Z' });
  const today = '2026-10-15', w = (a, b) => A.windowOf(sum, a, b, today);
  assert.deepEqual(A.coverage(sum, '2026-08-01'), { first: '2026-09-15', last: '2026-10-04', uploaded: '2026-10-10', from: '2026-08-01', to: '2026-10-10' });
  assert.deepEqual([w('2026-09-15', '2026-10-14').s, w('2026-09-15', '2026-10-14').e, w('2026-09-15', '2026-10-14').clipped], ['2026-09-15', '2026-10-10', true]);   // file cập nhật đến 10/10
  assert.equal(w('2025-03-01', '2026-10-14').s, '2026-08-01');           // "Toàn bộ" không kéo lead về trước đầu mùa
  assert.equal(w('2025-08-01', '2026-07-31').outside, true);             // năm học trước
  assert.equal(w('2026-10-11', '2026-10-14').outside, true);             // sau ngày tải lên
  assert.equal(w('2026-09-20', '2026-09-30').clipped, false);
  const season = Object.assign(A.aggregate({ reg: regRows([], rows.map(r => r.slice(0, 5))), paid: [paidTab('X (ĐP)', [[1000, null, 'HS']])] }).summary, { uploadedAt: '2026-10-10T03:00:00Z' });
  const ws = A.windowOf(season, '2026-10-01', '2026-10-14', today);
  assert.deepEqual([ws.s, ws.e, ws.mode, ws.atUpload, ws.staleDays, ws.uploaded], ['2026-08-01', '2026-10-10', 'season', true, 5, '2026-10-10']);   // lead và chi tiêu chỉ tính đến ngày tải file
  const fresh = A.windowOf(Object.assign({}, season, { uploadedAt: '2026-10-15T03:00:00Z' }), 'x', 'y', today); assert.deepEqual([fresh.e, fresh.atUpload, fresh.staleDays], ['2026-10-15', false, 0]);
  const noUp = A.windowOf(Object.assign({}, season, { uploadedAt: undefined }), 'x', 'y', today); assert.deepEqual([noUp.e, noUp.staleDays], ['2026-10-15', null]);
  const rolled = A.windowOf(Object.assign({}, season, { uploadedAt: '2027-08-20T03:00:00Z' }), 'x', 'y', '2027-09-01');   // sang năm học mới vẫn là mùa trong file, hết ở 31/07
  assert.deepEqual([rolled.s, rolled.e, rolled.outside, rolled.atUpload], ['2026-08-01', '2027-07-31', false, false]);
});

test('programOf: chịu "TS 6", "TS-6", "học_bổng", khoảng trắng lạ; chiến dịch nhiều khối để ở chưa ghép', () => {
  const t = { 'TS 6 remarketing': 'TS6', 'TS 10 tư vấn': 'TS10', 'TS 1 lead form': 'TS1', 'TS-6 | Form': 'TS6', 'TS_6 | Form': 'TS6', 'Học  bổng': 'HB', 'Học bổng 2027': 'HB', 'học_bổng': 'HB', 'Học-bổng': 'HB',
    'TS1+TS6 | Chung': null, 'TS6-TS10 | Chung': null, 'TS1-TS6-TS10 | Brand': null, 'JS26-LEAD | Lên lớp 1 (TS1)': 'JS', 'TS1-LEAD | Jolly Steps': 'TS1', 'TS6LEAD': 'TS6', 'TS10LEAD': 'TS10', 'TS6A': 'TS6',
    'ATS6': null, 'TS60': null, 'TS100': null, 'Bài đẩy ts12': null, 'JSX': null, 'TS6-LEAD | Học bổng | Lớp 6': 'TS6' };
  for (const [name, want] of Object.entries(t)) assert.equal(A.programOf(name), want, name);
});

test('funnel: học sinh chưa rõ chương trình (ô Chiến dịch trống) để riêng, không làm sai tổng', () => {
  const reg = regRows([], [...Array.from({ length: 12 }, (_, i) => [100 + i, null, 'HS', 'Khối 6', 'TS6']), ...Array.from({ length: 5 }, (_, i) => [200 + i, null, 'HS', 'Khối 6', null])]);
  const s = A.aggregate({ reg, paid: [paidTab('X (ĐP)', [[100, null, 'HS'], [200, null, 'HS']])] }).summary;
  const f = A.funnel(s, { TS6: { leads: 24, spend: 2.4e6, camps: 1 } }, '2026-08-01', '2026-10-15');
  assert.equal(f.total.regExt, 12); assert.equal(f.total.leadToReg, 0.5); assert.equal(f.unknown.regExt, 5); assert.equal(f.unknown.paidExt, 1); assert.equal(f.unknown.label, 'Chưa rõ chương trình');
  assert.equal(f.extra.length, 0);
});

test('validate: không bao giờ ném lỗi và chỉ nhận các số kiểm tra đã biết', () => {
  const s = A.aggregate(sampleInput(true)).summary;
  const weird = [undefined, null, 0, 'x', [], {}, { v: 1 }, { v: 1, total: { reg: { toString() { throw new Error('boom'); } } } }, { v: 1, season: { toString() { throw new Error('boom'); } } }, Object.assign(Object.create(null), { v: 1 })];
  for (const w of weird) assert.doesNotThrow(() => A.validate(w));
  const p = JSON.parse(JSON.stringify(s)); p.checks.paidTabsSkipped = ['LỚP 1 (ĐP)', '<img src=x onerror=alert(1)>']; assert.equal(A.validate(p).ok, false);
  p.checks.paidTabsSkipped = ['LỚP 1 (ĐP)']; p.checks.evil = 'Nguyễn Văn A'; const v = A.validate(p);
  assert.ok(v.ok); assert.deepEqual(v.summary.checks.paidTabsSkipped, ['LỚP 1 (ĐP)']); assert.ok(!('evil' in v.summary.checks));
  assert.deepEqual(Object.keys(v.summary.checks).sort(), ['dupMdt', 'paidBadDate', 'paidNoDate', 'paidNotInRegistration', 'paidTabsSkipped', 'regBadDate', 'regNoDate', 'skippedPaid', 'skippedReg']);
});

test('readWorkbook: chỉ nhận .xlsx, mở rộng ô gộp, đọc hệ ngày 1904, lỗi thư viện thành thông báo dễ hiểu', () => {
  const X = (sheets, wbProps) => ({
    read: (buf, o) => o.bookSheets ? { SheetNames: Object.keys(sheets) } : { Sheets: sheets, Workbook: wbProps ? { WBProps: wbProps } : undefined },
    utils: { encode_cell: ({ r, c }) => 'R' + r + 'C' + c, sheet_to_json: ws => Object.keys(ws).filter(k => /^R\d+C\d+$/.test(k)).reduce((rows, k) => { const [, r, c] = k.match(/R(\d+)C(\d+)/); (rows[+r] ||= [])[+c] = ws[k].v; return rows; }, []).map(r => r || []) }
  });
  assert.match(A.readWorkbook(X({}), new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])).error, /\.xlsx/);        // file .xls cũ
  assert.match(A.readWorkbook(X({}), new Uint8Array([])).error, /\.xlsx/);
  assert.match(A.readWorkbook({ read: () => { throw new Error('parse_xlscfb is not defined'); }, utils: {} }, ZIP).error, /Không đọc được file Excel/);
  // Chiến dịch nằm trong ô gộp hai dòng: dòng thứ hai vẫn nhận mã chương trình
  const cell = v => ({ t: typeof v === 'number' ? 'n' : 's', v });
  const reg = { R1C0: cell('MDT'), R1C1: cell('HS nội bộ'), R1C2: cell('Họ tên học sinh'), R1C3: cell('Chiến dịch'),
    R2C0: cell(11), R2C2: cell('A'), R2C3: cell('TS6'), R3C0: cell(12), R3C2: cell('B'), '!merges': [{ s: { r: 2, c: 3 }, e: { r: 3, c: 3 } }] };
  const paid = { R0C0: cell('MDT'), R0C1: cell('Họ tên học sinh'), R1C0: cell(11), R1C1: cell('A') };
  const r = A.readWorkbook(X({ 'Danh sách đăng ký': reg, 'LỚP 6 (ĐP)': paid }), ZIP);
  assert.ok(r.ok); assert.deepEqual(r.summary.programs.TS6, { reg: 2, regInt: 0, paid: 1, paidInt: 0 });
  // hệ ngày 1904
  const reg4 = { R0C0: cell('MDT'), R0C1: cell('HS nội bộ'), R0C2: cell('Họ tên học sinh'), R0C3: cell('Chiến dịch'), R0C4: cell('Ngày đăng ký'), R1C0: cell(11), R1C2: cell('A'), R1C3: cell('TS6'), R1C4: cell(46305 - 1462) };
  const r4 = A.readWorkbook(X({ 'Danh sách đăng ký': reg4, 'LỚP 6 (ĐP)': paid }, { date1904: true }), ZIP);
  assert.deepEqual(Object.keys(r4.summary.regByDay), ['2026-10-10']);
  // tab (ĐP) tên khác được báo là không đọc
  const skipped = A.readWorkbook(X({ 'Danh sách đăng ký': reg, 'LỚP 6 (ĐP)': paid, 'ĐP LỚP 10': paid, 'Ghi chú': {} }), ZIP).summary;
  assert.deepEqual(skipped.checks.paidTabsSkipped, ['ĐP LỚP 10']);
});

/* ---- bổ sung sau rà soát độc lập vòng hai ---- */
const rowsOfDates = (dates, start = 1000) => dates.map((d, i) => [start + i, null, 'HS', 'Khối 6', 'TS6', d]);
const fakeX = (sheets) => ({ read: (buf, o) => o.bookSheets ? { SheetNames: Object.keys(sheets) } : { Sheets: sheets }, utils: { sheet_to_json: ws => ws } });

test('aggregate: ngày sau hôm nay hoặc sớm hơn đầu mùa hơn ba tháng bị loại và được đếm; không có hôm nay thì không kiểm tra', () => {
  const d = [...Array(40).fill('15/09/2026'), '15/09/2025', '05/10/2027', '01/05/2026', '30/04/2026'];   // 2 ngày gõ nhầm năm; 01/05 đúng ba tháng trước 01/08 vẫn nhận, 30/04 thì không
  const reg = regRows(['Ngày đăng ký'], rowsOfDates(d)), paid = [paidTab('X (ĐP)', [[1000, null, 'HS']])];
  const r = A.aggregate({ reg, paid, today: '2026-10-15' }).summary;
  assert.deepEqual([r.checks.regBadDate, r.checks.regNoDate], [3, 3]);
  assert.deepEqual(Object.keys(r.regByDay).sort(), ['2026-05-01', '2026-09-15']);
  assert.ok(A.datedShare(r) > 0.9 && A.modeOf(r) === 'dated');
  assert.equal(A.aggregate({ reg, paid }).summary.checks.regBadDate, 0);                   // không biết hôm nay: giữ nguyên mọi ngày đọc được
  assert.equal(A.aggregate({ reg, paid, today: 'hôm nay' }).summary.checks.regBadDate, 0);  // hôm nay sai dạng: bỏ qua
  // cột Ngày đóng phí cũng bị lọc như vậy
  const pr = A.aggregate({ reg: regRows(['Ngày đóng phí'], [[1, null, 'A', 'Khối 6', 'TS6', '03/10/2027'], [2, null, 'B', 'Khối 6', 'TS6', '03/10/2026']]), paid: [paidTab('X (ĐP)', [[1, null, 'A']])], today: '2026-10-15' }).summary;
  assert.deepEqual([pr.checks.paidBadDate, Object.keys(pr.paidByDay)], [1, ['2026-10-03']]);
});

test('coverage và windowOf: một ngày gõ nhầm năm còn sót trong số liệu đã lưu không kéo khoảng thời gian của báo cáo', () => {
  const d = [...Array(40).fill('15/09/2026'), '15/09/2025', '05/10/2027'];
  const stray = Object.assign(A.aggregate({ reg: regRows(['Ngày đăng ký'], rowsOfDates(d)), paid: [paidTab('X (ĐP)', [[1000, null, 'HS']])] }).summary, { uploadedAt: '2026-10-10T03:00:00Z' });   // không lọc lúc đọc: như số liệu lưu từ bản cũ
  assert.deepEqual(A.coverage(stray, '2026-08-01', '2026-10-15'), { first: '2026-09-15', last: '2026-09-15', uploaded: '2026-10-10', from: '2026-08-01', to: '2026-10-10' });
  const today = '2026-10-15', w = (a, b) => A.windowOf(stray, a, b, today);
  assert.equal(w('2025-08-01', '2026-07-31').outside, true);        // năm học trước vẫn nằm ngoài, không thành "0 đăng ký"
  assert.equal(w('2025-03-01', '2026-10-14').s, '2026-08-01');      // Toàn bộ không kéo lead về trước đầu mùa
  assert.equal(w('2026-10-11', '2026-10-14').outside, true);
  assert.equal(A.coverage(Object.assign({}, stray, { regByDay: { '2025-01-01': { TS6: [1, 0] } } }), '2026-08-01', today), null);   // chỉ còn ngày vô lý: không có khoảng nào
  assert.equal(A.windowOf(Object.assign({}, stray, { regByDay: { '2025-01-01': { TS6: [1, 0] } } }), '2026-09-01', '2026-10-14', today).outside, true);
});

test('windowOf: mùa ghi trong file đã hết thì cắt ở 31/07; mùa chưa bắt đầu thì báo; nhãn mùa phải là hai năm liên tiếp', () => {
  const mk = (season, dates) => Object.assign(A.aggregate({ reg: sheetOf(['MDT', 'HS nội bộ', 'Họ tên học sinh', 'Khối ' + season, 'Chiến dịch', 'Ngày đăng ký'], rowsOfDates(dates).map(r => r.slice(0, 6))), paid: [paidTab('X (ĐP)', [[1000, null, 'HS']])] }).summary, { uploadedAt: '2026-10-14T03:00:00Z' });
  const old = mk('26 27', [...Array(20).fill('10/08/2025'), ...Array(20).fill('19/07/2026')]);          // file của mùa 2026–27 cập nhật sau khi mùa kết thúc
  assert.equal(old.season, '2026–27');
  const wo = A.windowOf(old, '2026-09-15', '2026-10-14', '2026-10-15'); assert.equal(wo.outside, true);   // không hiện lead của mùa mới so với 0 đăng ký
  assert.equal(A.windowOf(old, '2025-08-01', '2026-07-31', '2026-10-15').outside, false); assert.equal(wo.seasonMismatch, false);
  const late = mk('26 27', Array(40).fill('15/09/2026')), wl = A.windowOf(late, '2026-09-15', '2026-10-14', '2026-10-15');   // đăng ký Sep 2026 mà tiêu đề còn ghi mùa 2026–27: quên đổi tiêu đề cột Khối
  assert.deepEqual([wl.outside, wl.seasonMismatch], [true, true]); assert.match(A.packOf(C, C.model({}), [], late, '2026-10-15').school_year_to_date.note || '', /tiêu đề cột Khối|không có số chuyển đổi/);
  const fut = mk('28 29', Array(40).fill('15/09/2026')), wf = A.windowOf(fut, '2026-09-01', '2026-10-14', '2026-10-15');
  assert.equal(fut.season, '2028–29'); assert.deepEqual([wf.outside, wf.future], [true, true]);
  assert.equal(A.windowOf(fut, '2026-09-01', '2026-10-14', '2028-09-01').future, false);                  // đến mùa đó thì bình thường
  for (const h of ['26 28', '27 29', '12 13', 'Khối 5 6', '27-28', '27-28x', '2027-2028', '2027–28', '27/28']) assert.equal(A.aggregate({ reg: sheetOf(['MDT', 'HS nội bộ', 'Họ tên học sinh', 'Khối ' + h, 'Chiến dịch'], [[1, null, 'A', 'Khối 6', 'TS6']]), paid: [paidTab('X (ĐP)', [[1, null, 'A']])] }).summary.season, /^(27-28x?|2027-2028|2027–28|27\/28)$/.test(h) ? '2027–28' : '', h);
});

test('aggregate: tab (ĐP) của mùa khác để lại trong file không được cộng vào mùa này và được báo', () => {
  const reg = regRows([], [[1, null, 'A', 'Khối 6', 'TS6'], [2, null, 'B', 'Khối 6', 'TS6'], [3, null, 'C', 'Khối 6', 'TS6']]);
  const r = A.aggregate({ reg, paid: [paidTab('LỚP 6 2728 (ĐP)', [[1, null, 'A']]), paidTab('LỚP 6 2627 (ĐP)', [[2, null, 'B']]), paidTab('LỚP 10 (ĐP)', [[3, null, 'C']])] }).summary;
  assert.deepEqual(Object.keys(r.paidSheets), ['LỚP 6 2728 (ĐP)', 'LỚP 10 (ĐP)']); assert.deepEqual(r.checks.paidTabsSkipped, ['LỚP 6 2627 (ĐP)']); assert.equal(r.total.paid, 2);
  for (const [name, want] of [['LỚP 6 2728 (ĐP)', '2728'], ['HB 2728', '2728'], ['LỚP 10', ''], ['LỚP 10 2728 (ĐP)', '2728'], ['Lớp 2025', ''], ['x 20272028', '2728'], ['HB 2627 (ĐP)', '2627'], ['LỚP 6 26-27 (ĐP)', '2627'], ['LỚP 6 26 27 (ĐP)', '2627'], ['LỚP 6 2026-27 (ĐP)', '2627'], ['LỚP 6 2026-2027 (ĐP)', '2627'], ['LỚP 6 K26 (ĐP)', ''], ['LỚP 10 11 (ĐP)', ''], ['HB 202728', '2728'], [null, '']]) assert.equal(A.seasonCodeOf(name), want, String(name));
  const old26 = A.aggregate({ reg, paid: [paidTab('LỚP 6 2728 (ĐP)', [[1, null, 'A']]), paidTab('LỚP 6 26-27 (ĐP)', [[2, null, 'B']]), paidTab('LỚP 6 2026-2027 (ĐP)', [[3, null, 'C']])] }).summary;
  assert.deepEqual(Object.keys(old26.paidSheets), ['LỚP 6 2728 (ĐP)']); assert.equal(old26.checks.paidTabsSkipped.length, 2);   // cách ghi khác của mùa cũ cũng bị loại
});

test('programCode và programOf: "Học bổng", "TS 06", "JS26", "HB27" gộp vào mã chuẩn; mã lạ giữ riêng; chữ dài là chưa rõ', () => {
  for (const [v, w] of [['TS6', 'TS6'], ['ts 6', 'TS6'], ['TS 06', 'TS6'], ['TS-10', 'TS10'], ['Học bổng', 'HB'], ['HB', 'HB'], ['hb27', 'HB'], ['JS26', 'JS'], ['Jolly Steps', 'JS'], ['SK2', 'SK2'], ['sk 2', 'SK2'], ['TS12', 'TS12'], ['SUKIEN', 'KHAC'], ['Sự kiện', 'KHAC'], ['Lan', 'KHAC'], ['chị Hà', 'KHAC'], ['Hương', 'KHAC'], ['12345', 'KHAC'], ['#N/A', 'KHAC'], ['Loading...', 'KHAC'], ['ABCDEF1', 'KHAC'], ['TS1234', 'KHAC'], ['Tuyển sinh lớp 1 đợt hai', 'KHAC'], ['', 'KHAC'], [null, 'KHAC']]) assert.equal(A.programCode(v), w, String(v)); // chữ tự do (tên, ghi chú, ô lỗi) không bao giờ thành mã được lưu
  for (const [n, w] of [['HB26', 'HB'], ['HB2027-LEAD', 'HB'], ['HB 27 | Form', 'HB'], ['HBO Max', null], ['CHB', null], ['hbx', null]]) assert.equal(A.programOf(n), w, n);
  const r = A.aggregate({ reg: regRows([], [[1, null, 'A', 'Khối 6', 'Học bổng'], [2, null, 'B', 'Khối 6', 'TS 06'], [3, null, 'C', 'Khối 6', 'TS6']]), paid: [paidTab('X (ĐP)', [[1, null, 'A']])] }).summary;
  assert.deepEqual(Object.keys(r.programs).sort(), ['HB', 'TS6']); assert.equal(r.programs.TS6.reg, 2);
});

test('funnel: mã chương trình ngoài năm chương trình và ô Chiến dịch trống hiện riêng, không cộng vào Tổng', () => {
  const reg = regRows([], [...Array.from({ length: 12 }, (_, i) => [100 + i, null, 'HS', 'Khối 6', 'TS6']), ...Array.from({ length: 5 }, (_, i) => [200 + i, null, 'HS', 'Khối 6', 'SK2']), ...Array.from({ length: 3 }, (_, i) => [300 + i, null, 'HS', 'Khối 6', null])]);
  const s = A.aggregate({ reg, paid: [paidTab('X (ĐP)', [[100, null, 'HS'], [200, null, 'HS'], [201, null, 'HS'], [300, null, 'HS']])] }).summary;
  const f = A.funnel(s, { TS6: { leads: 24, spend: 2.4e6, camps: 1 } }, '2026-08-01', '2026-10-15');
  assert.deepEqual([f.total.regExt, f.total.paidExt, f.total.leadToReg, f.total.costPerReg], [12, 1, 0.5, 2.4e6 / 12]);   // chỉ năm chương trình
  assert.deepEqual(f.extra.map(r => [r.k, r.regExt, r.paidExt]), [['SK2', 5, 2]]); assert.deepEqual([f.unknown.regExt, f.unknown.paidExt], [3, 1]);
  assert.deepEqual([f.apart.regExt, f.apart.paidExt, f.apart.codes, f.apart.blank], [8, 3, ['SK2'], true]);
  assert.equal(A.funnel(A.aggregate({ reg: regRows([], [[1, null, 'A', 'Khối 6', 'TS6']]), paid: [paidTab('X (ĐP)', [[1, null, 'A']])] }).summary, {}, '2026-08-01', '2026-10-15').apart.regExt, 0);
});

test('validate: chỉ nhận số thật, tổng khớp nhau, ngày có thật, nhãn mùa hợp lệ', () => {
  const base = A.aggregate(sampleInput(true)).summary, mut = f => { const x = JSON.parse(JSON.stringify(base)); f(x); return A.validate(x); };
  assert.ok(mut(() => {}).ok);
  for (const [name, f] of Object.entries({
    'số dạng chuỗi': x => { x.total.reg = '6'; }, 'null': x => { x.programs.TS6.reg = null; }, 'mảng': x => { x.programs.TS6.paid = [1]; }, 'số thập lục': x => { x.programs.TS6.reg = '0x10'; },
    'tổng chương trình lệch': x => { x.programs.TS6.reg += 1; x.programs.TS6.paid += 1; }, 'tổng khối lệch': x => { x.khoi['Khối 6'].reg += 1; },
    'ngày không có thật': x => { x.regByDay['2026-02-30'] = {}; }, 'tháng 99': x => { x.regByDay['2099-99-99'] = {}; }, 'ngày đóng phí không có thật': x => { x.paidByDay['2026-13-01'] = {}; },
    'không có học sinh': x => { x.total = { reg: 0, regInt: 0, paid: 0, paidInt: 0 }; x.programs = { TS6: { reg: 0, regInt: 0, paid: 0, paidInt: 0 } }; x.khoi = { 'Khác': { reg: 0, regInt: 0, paid: 0, paidInt: 0 } }; }
  })) assert.equal(mut(f).ok, false, name);
  for (const [name, f, want] of [['mảng', x => { x.season = ['2027–28']; }, ''], ['hai năm không liên tiếp', x => { x.season = '2027–29'; }, ''], ['năm ngoài khoảng', x => { x.season = '2099–00'; }, ''], ['hợp lệ', x => { x.season = '2027–28'; }, '2027–28']]) assert.equal(mut(f).summary.season, want, name);
  assert.deepEqual(Object.keys(mut(() => {}).summary).sort(), Object.keys(base).sort());
});

test('readWorkbook: file zip không phải .xlsx (.ods, .xlsb, .docx) bị từ chối trước khi đọc; ngày gõ nhầm năm bị loại theo ngày truyền vào', () => {
  const never = { read: () => { throw new Error('không được gọi'); }, utils: {} };
  for (const body of ['content.xml mimetype application/vnd.oasis.opendocument.spreadsheet', 'xl/workbook.bin', 'word/document.xml']) assert.match(A.readWorkbook(never, new Uint8Array([0x50, 0x4b, 3, 4, ...Buffer.from(body)])).error, /\.xlsx/, body);
  assert.match(A.readWorkbook(never, new Uint8Array([0x50, 0x4b, 3, 4])).error, /\.xlsx/);
  const reg = regRows(['Ngày đăng ký'], rowsOfDates([...Array(30).fill('15/09/2026'), '15/09/2025'])), paid = [[], ['MDT', 'HS nội bộ', 'Họ tên học sinh'], [1000, null, 'HS']];
  const ok = A.readWorkbook(fakeX({ 'Danh sách đăng ký': reg, 'LỚP 6 2728 (ĐP)': paid }), ZIP, '2026-10-15');
  assert.ok(ok.ok); assert.equal(ok.summary.checks.regBadDate, 1); assert.deepEqual(Object.keys(ok.summary.regByDay), ['2026-09-15']);
  assert.ok(A.readWorkbook(fakeX({ 'Danh sách đăng ký': reg, 'LỚP 6 2728 (ĐP)': paid }), ZIP).ok);               // không truyền ngày: lấy hôm nay của máy
  assert.deepEqual(A.readWorkbook(fakeX({ 'Danh sách đăng ký': reg, 'LỚP 6 2728 (ĐP)': paid, 'LỚP 6 2627 (ĐP)': paid }), ZIP, '2026-10-15').summary.checks.paidTabsSkipped, ['LỚP 6 2627 (ĐP)']);
  assert.match(A.readWorkbook(fakeX({ 'Danh sách đăng ký': reg, 'LỚP 6 2627 (ĐP)': paid }), ZIP, '2026-10-15').error, /tab \(ĐP\)/);   // chỉ còn tab của mùa khác: không có tab ĐP nào dùng được
});

test('packOf: Tổng chỉ gồm năm chương trình, phần ngoài Tổng nằm riêng; có tuổi file và ghi chú cắt theo ngày tải', () => {
  const A1 = '895057262833914', day = '2026-10-10', dv = C.zero(); dv[C.MI.spend] = 3e6; dv[C.MI.impr] = 5000;
  const v = C.zero(); v[C.MI.spend] = 3e6; v[C.MI.lead] = 30; v[C.MI.impr] = 5000;
  const camp = { acct: A1, rows: { a: { n: 'TS6-LEAD | Form', obj: 'OUTCOME_LEADS', m: v } }, monthly: {} }, campd = { acct: A1, since: '2026-09-01', rows: { a: { [day]: v } } };
  const m = C.model({ ['acct-' + A1]: { acct: A1, daily: { [day]: dv } }, ['camp-' + A1]: camp, ['campd-' + A1]: campd });
  const reg = regRows([], [...Array.from({ length: 12 }, (_, i) => [100 + i, null, 'HS', 'Khối 6', 'TS6']), ...Array.from({ length: 5 }, (_, i) => [200 + i, null, 'HS', 'Khối 6', 'SK2']), [300, null, 'HS', 'Khối 6', null]]);
  const sum = Object.assign(A.aggregate({ reg, paid: [paidTab('X (ĐP)', [[100, null, 'HS'], [200, null, 'HS']])] }).summary, { uploadedAt: '2026-10-10T03:00:00Z' });
  const p = A.packOf(C, m, [A1], sum, '2026-10-15'), b = p.school_year_to_date;
  assert.equal(p.mode, 'season'); assert.equal(p.file_age_days, 5);
  assert.deepEqual(b.programs.map(x => x.program), ['TS1', 'JS', 'TS6', 'TS10', 'HB']);
  assert.equal(b.total.registered_external, 12); assert.deepEqual(b.programs_not_in_total.map(x => [x.program, x.registered_external]), [['SK2', 5], ['KHAC', 1]]);
  assert.equal(b.until, '2026-10-10'); assert.match(b.note, /ngày tải file/);
  assert.ok(p.notes.some(n => /programs_not_in_total/.test(n)) && p.notes.some(n => /5 ngày trước/.test(n)));
  assert.ok(!/unknown_program/.test(JSON.stringify(p)));
});

// Số điện thoại và email giả dựng lúc chạy (mỗi 'x' là một chữ số lấy lần lượt từ D) để chính file này không chứa chuỗi giống dữ liệu thật.
const D = ['9', '1', '8', '3', '7', '4', '6', '5', '0', '2'];
const ph = pattern => { let k = 0; return pattern.replace(/x/g, () => D[k++ % 10]); };
const mail = (...parts) => parts.join('@');

test('scanText: thấy số điện thoại và email thật, bỏ qua số giả, tiền, toạ độ và email ví dụ', () => {
  assert.deepEqual(scanText('gọi ' + [ph('0xxx xxx xxx'), ph('+84 xxx.xxx.xxx'), ph('0xxxxxxxxx'), ph('xxxxxxxxx'), ph('0xx-xxx-xxxx')].join(', ')).map(x => x.kind), ['phone', 'phone', 'phone', 'phone', 'phone']);
  assert.deepEqual(scanText('0900000000, 999999999, 109.664 ₫, 1.234.567.890, M3 5 12 10 8 6.5 3 4 1 7, 2026-10-15 3 5 7 9, 86400000, 20000001'), []);
  // CSV, JSON gọn, danh sách trong ngoặc vuông: dấu phẩy không che số
  assert.deepEqual(scanText('["A",' + ph('xxxxxxxxx') + ',"B"]').map(x => x.kind), ['phone']);
  assert.deepEqual(scanText('A,' + ph('0xxxxxxxxx') + ',6').map(x => x.kind), ['phone']);
  assert.deepEqual(scanText('[' + ph('xxxxxxxxx') + ',' + ph('xxxxxxxxx') + ']').map(x => x.kind), ['phone', 'phone']);
  assert.deepEqual(scanText(ph('0xxx\u00a0xxx\u00a0xxx')).map(x => x.kind), ['phone']);                         // dấu cách không ngắt khi chép từ web hay Zalo
  assert.deepEqual(scanText(ph('0xxx\txxx\txxx')).map(x => x.kind), ['phone']);
  assert.deepEqual(scanText('liên hệ ' + mail('a.b', 'truong.edu.vn')).map(x => x.kind), ['email']);
  const t0 = Date.now(); scanText('a'.repeat(200000)); scanText('0'.repeat(200000)); assert.ok(Date.now() - t0 < 1500, 'quét một chuỗi dài không ngắt phải chạy tuyến tính');
  assert.equal(decodeText(Buffer.from('\ufeff' + 'A,' + ph('0xxxxxxxxx'), 'utf16le')).includes('A,'), true);           // Unicode Text của Excel (UTF-16LE có BOM)
  assert.equal(decodeText(Buffer.from([0x50, 0x4b, 0, 3])), null);
  assert.deepEqual(scanText('admin@example.edu, x@example.com, 105@system.gserviceaccount.com'), []);
  assert.ok(!JSON.stringify(scanText(ph('0xxxxxxxxx') + ' ' + mail('a.b', 'truong.edu.vn'))).match(/\d|truong|a\.b/), 'kết quả đã che chữ số và chữ');   // không in lại giá trị
  assert.ok(DATA_FILE.test('x/DATA.XLSX') && DATA_FILE.test('a.ods') && DATA_FILE.test('a.xlsm') && DATA_FILE.test('a.tsv') && !DATA_FILE.test('a.js'));
});

test('scanHistory: thấy số điện thoại và file dữ liệu ở nhánh cũ chưa xoá, nói rõ nhánh nào; baseline chỉ bỏ qua email và theo mã tệp đầy đủ', async () => {
  const { execFileSync } = await import('node:child_process'), { mkdtempSync, writeFileSync, rmSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'adm-hist-'));
  try {
    const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.com'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'a.js'), 'const x = 1;\n'); g('add', '.'); g('commit', '-q', '-m', 'sạch');
    g('checkout', '-q', '-b', 'nhanh-cu'); const num = ph('0xxxxxxxxx'); writeFileSync(join(dir, 'leak.test.js'), "const p = '" + num + "'; // " + mail('ai.do', 'truong.edu.vn') + "\n"); writeFileSync(join(dir, 'data.xlsx'), 'PK'); g('add', '-f', '.'); g('commit', '-q', '-m', 'lỡ đẩy'); g('checkout', '-q', 'main');
    const r = scanHistory(dir, new Set());
    assert.deepEqual(r.hits.map(h => h.kind + ':' + h.path).sort(), ['data-file:data.xlsx', 'email:leak.test.js', 'phone:leak.test.js']);
    assert.deepEqual(r.hits.find(h => h.kind === 'phone').refs, ['nhanh-cu']); assert.deepEqual(r.warnings, []);
    assert.ok(!JSON.stringify(r).includes(num));
    const phoneHit = r.hits.find(h => h.kind === 'phone'), mailHit = r.hits.find(h => h.kind === 'email');
    assert.equal(scanHistory(dir, new Set([phoneHit.blobFull + ':phone'])).hits.length, 3);                                    // số điện thoại không bao giờ được chấp nhận
    assert.equal(scanHistory(dir, new Set([mailHit.blob + ':email'])).hits.length, 3);                                         // mã rút gọn không đủ
    const s1 = scanHistory(dir, new Set([mailHit.blobFull + ':email'])); assert.deepEqual([s1.hits.length, s1.suppressed], [2, 1]);   // email có trong baseline bị bỏ qua và được đếm
    g('tag', 'ban-cu', 'nhanh-cu'); g('branch', '-q', '-D', 'nhanh-cu');                                                        // chỉ còn tag trỏ tới commit lỡ đẩy
    assert.equal(scanHistory(dir, new Set()).hits.filter(h => h.kind === 'phone').length, 1); assert.deepEqual(scanHistory(dir, new Set()).hits.find(h => h.kind === 'phone').refs, ['ban-cu']);
    g('tag', '-d', 'ban-cu');                                                                                                   // gỡ tag thì sạch
    const clean = scanHistory(dir, new Set()); assert.equal(clean.hits.length, 0); assert.deepEqual(clean.warnings, []);
    // kho nông hoặc chỉ theo dõi một nhánh: chưa kết luận được, phải báo
    const shallow = join(dir, '..', 'adm-hist-shallow-' + Date.now()); g('checkout', '-q', '-b', 'khac'); writeFileSync(join(dir, 'b.js'), '1;\n'); g('add', '.'); g('commit', '-q', '-m', 'hai'); g('checkout', '-q', 'main');
    execFileSync('git', ['clone', '-q', '--depth', '1', 'file://' + dir, shallow], { stdio: 'pipe' });
    try { const w = scanHistory(shallow, new Set()); assert.ok(w.warnings.some(x => /nông/.test(x)), w.warnings.join('|')); assert.ok(w.warnings.some(x => /một số nhánh/.test(x)), w.warnings.join('|')); }
    finally { rmSync(shallow, { recursive: true, force: true }); }
    const full = join(dir, '..', 'adm-hist-full-' + Date.now()); execFileSync('git', ['clone', '-q', 'file://' + dir, full], { stdio: 'pipe' });
    try { const f = scanHistory(full, new Set()); assert.deepEqual(f.warnings, []); assert.ok(f.refs.every(x => x !== 'origin'), 'origin/HEAD không tính là một nhánh'); } finally { rmSync(full, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('privacy-baseline: chỉ có email, mã tệp đầy đủ 40 ký tự, đúng một mục đã biết', async () => {
  const { readFileSync } = await import('node:fs');
  const list = JSON.parse(readFileSync(new URL('./privacy-baseline.json', import.meta.url), 'utf8')).accepted;
  assert.deepEqual(list, ['caa7c0dab88a3be3eada3eccb47bb1d2267fa57c:email']);
  assert.deepEqual([...accepted()], list);
});

test('vệ sinh dữ liệu: kho mã không chứa số điện thoại, email thật, file Excel hay dữ liệu học sinh thật', async t => {
  const { execFileSync } = await import('node:child_process');
  const { readFileSync, existsSync } = await import('node:fs');
  if (!existsSync(new URL('../.git', import.meta.url))) return t.skip('không phải kho git (bản tải về, Docker COPY…): không có tệp nào để quét'); // chỉ bỏ qua khi thật sự không có .git; mọi lỗi git khác làm bài thử hỏng
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }).split('\0').filter(Boolean);
  assert.deepEqual(files.filter(f => DATA_FILE.test(f) || /(^|\/)dev-docs\.json$/.test(f)), [], 'không đưa file dữ liệu vào kho (kho công khai)');
  const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  for (const ext of ['xlsx', 'xls', 'xlsb', 'xlsm', 'ods', 'csv', 'tsv']) assert.ok(ignore.split(/\r?\n/).includes('*.' + ext), '.gitignore thiếu *.' + ext);
  const hits = [];
  for (const f of files) {
    if (/^(vendor\/|package-lock\.json$)/.test(f) || /\.(png|jpe?g|gif|ico|woff2?)$/i.test(f) || !existsSync(new URL('../' + f, import.meta.url))) continue;
    const text = decodeText(readFileSync(new URL('../' + f, import.meta.url))); if (text == null) continue;
    for (const h of scanText(text)) hits.push(f + ': ' + h.kind + ' ' + h.shape);
  }
  assert.deepEqual(hits, [], 'có chuỗi giống số điện thoại hoặc email thật trong kho mã');
});

/* ---- bổ sung sau rà soát độc lập vòng ba ---- */
test('aggregate: mọi tab (ĐP) thuộc mùa khác thì báo rõ mã mùa thay vì nói tab thiếu MDT; quá 12 mã chương trình hay 12 tab báo ngay', () => {
  const reg = regRows([], [[1, null, 'A', 'Khối 6', 'TS6'], [2, null, 'B', 'Khối 6', 'TS6']]);                 // tiêu đề Khối 27 28
  const e1 = A.aggregate({ reg, paid: [paidTab('LỚP 6 2627 (ĐP)', [[1, null, 'A']])] });
  assert.equal(e1.ok, false); assert.match(e1.error, /tab \(ĐP\)/); assert.match(e1.error, /2627/); assert.match(e1.error, /2728/);
  const e2 = A.aggregate({ reg: sheetOf(['MDT', 'HS nội bộ', 'Họ tên học sinh', 'Khối 28 29', 'Chiến dịch'], [[1, null, 'A', 'Khối 6', 'TS6']]), paid: [paidTab('LỚP 6 2728 (ĐP)', [[1, null, 'A']]), paidTab('LỚP 10 2728 (ĐP)', [[1, null, 'A']])] });
  assert.equal(e2.ok, false); assert.match(e2.error, /2728/); assert.match(e2.error, /2829/); assert.ok(!/MDT/.test(e2.error));
  assert.match(A.aggregate({ reg, paid: [{ name: 'LỚP 6 (ĐP)', rows: [['Họ tên'], ['A']] }] }).error, /cột MDT/);              // lý do thiếu MDT vẫn nói đúng
  const many = A.aggregate({ reg: regRows([], Array.from({ length: 13 }, (_, i) => [i + 1, null, 'HS', 'Khối 6', 'SK' + i])), paid: [paidTab('X (ĐP)', [[1, null, 'HS']])] });
  assert.equal(many.ok, false); assert.match(many.error, /13 giá trị khác nhau/); assert.ok(!/SK1/.test(many.error));    // không in lại nội dung ô
  const tabs = A.aggregate({ reg, paid: Array.from({ length: 21 }, (_, i) => paidTab('Tab ' + i + ' (ĐP)', [[1, null, 'A']])) });
  assert.equal(tabs.ok, false); assert.match(tabs.error, /21 tab/); assert.match(tabs.error, /gộp bớt/);
  assert.ok(A.aggregate({ reg, paid: Array.from({ length: 13 }, (_, i) => paidTab('LỚP ' + (i + 1) + ' 2728 (ĐP)', [[1, null, 'A']])) }).ok);   // mỗi khối một tab: 13 tab vẫn nhận
  // tính chất: mọi kết quả ok:true của aggregate đều qua validate()
  const progs = ['TS1', 'JS', 'TS6', 'TS10', 'HB', 'SK2', null, 'Học bổng', 'TS 06'];
  for (let k = 0; k < 40; k++) {
    const rows = Array.from({ length: 5 + k }, (_, i) => [100 + i, i % 5 === 0 ? 7 : null, 'HS', 'Khối ' + (1 + (i * 3 + k) % 12), progs[(i * 7 + k) % progs.length], k % 3 ? '1' + (i % 9) + '/09/2026' : null]);
    const r = A.aggregate({ reg: regRows(['Ngày đăng ký'], rows), paid: [paidTab('X 2728 (ĐP)', rows.filter((_, i) => i % 2 === 0).map(x => x.slice(0, 3)))], today: '2026-10-15' });
    assert.ok(r.ok, String(k)); assert.ok(A.validate(r.summary).ok, 'validate ' + k);
  }
});

test('windowOf: phần lớn ngày đăng ký sau hết mùa ghi trong file thì mọi kỳ đều báo lệch mùa, một ngày lẻ trong mùa không che được', () => {
  const mk = (season, dates) => Object.assign(A.aggregate({ reg: sheetOf(['MDT', 'HS nội bộ', 'Họ tên học sinh', 'Khối ' + season, 'Chiến dịch', 'Ngày đăng ký'], rowsOfDates(dates).map(r => r.slice(0, 6))), paid: [paidTab('X (ĐP)', [[1000, null, 'HS']])] }).summary, { uploadedAt: '2026-10-14T03:00:00Z' });
  const today = '2026-10-15', stale = mk('26 27', Array(40).fill('15/09/2026')), stray = mk('26 27', [...Array(40).fill('15/09/2026'), '20/07/2026']);
  for (const [name, sum] of [['lệch', stale], ['một ngày lẻ trong mùa', stray]]) for (const [a, b] of [['2025-08-01', '2026-07-31'], ['2026-01-01', '2026-10-14'], ['2025-03-01', '2026-10-14'], ['2026-09-15', '2026-10-14'], ['2026-08-01', '2026-10-14']]) {
    const w = A.windowOf(sum, a, b, today); assert.deepEqual([w.outside, w.seasonMismatch], [true, true], name + ' ' + a + '..' + b);
  }
  const fine = mk('26 27', [...Array(30).fill('10/08/2025'), ...Array(30).fill('19/07/2026'), '05/08/2026']);       // vài ngày muộn sau hết mùa: bình thường
  for (const [a, b] of [['2025-08-01', '2026-07-31'], ['2026-01-01', '2026-10-14'], ['2025-03-01', '2026-10-14']]) assert.equal(A.windowOf(fine, a, b, today).seasonMismatch, false, a + '..' + b);
  assert.equal(A.windowOf(fine, '2025-08-01', '2026-07-31', today).outside, false);
});

test('windowOf: atUpload chỉ bật khi đầu cuối kỳ thật sự bị cắt về ngày tải file; coverage không để một ô ghi ngày mai kéo dài lead', () => {
  const rows = Array.from({ length: 40 }, (_, i) => [1000 + i, null, 'HS', 'Khối 6', 'TS6', 46280 + (i % 20), null]);   // 15/09/2026 … 04/10/2026
  const mk = up => Object.assign(A.aggregate({ reg: regRows(['Ngày đăng ký', 'Ngày đóng phí'], rows), paid: [paidTab('X (ĐP)', [[1000, null, 'HS']])] }).summary, { uploadedAt: up });
  const sum = mk('2026-10-05T03:00:00Z'), today = '2026-10-15';
  const closed = A.windowOf(sum, '2026-09-01', '2026-09-30', today); assert.deepEqual([closed.e, closed.atUpload, closed.clipped, closed.staleDays], ['2026-09-30', false, false, 10]);   // tháng đã đóng: file phủ trọn kỳ
  const straddle = A.windowOf(sum, '2026-09-20', '2026-10-14', today); assert.deepEqual([straddle.e, straddle.atUpload, straddle.clipped], ['2026-10-05', true, true]);
  const season = Object.assign({}, A.aggregate({ reg: regRows([], rows.map(r => r.slice(0, 5))), paid: [paidTab('X (ĐP)', [[1000, null, 'HS']])] }).summary, { uploadedAt: '2026-07-20T03:00:00Z' });
  const early = A.windowOf(season, 'x', 'y', today); assert.deepEqual([early.e, early.atUpload, early.staleDays], ['2026-10-15', false, 87]);   // file tải trước đầu mùa: lead vẫn chạy đến nay, không giả vờ bị cắt
  const tomorrow = mk('2026-10-14T03:00:00Z'); tomorrow.regByDay['2026-10-15'] = { TS6: [1, 0] };                      // một ô ghi ngày mai
  assert.equal(A.coverage(tomorrow, '2026-08-01', today).to, '2026-10-14'); assert.equal(A.windowOf(tomorrow, '2026-09-15', '2026-10-14', today).e, '2026-10-14');
});

test('seasonCodeOf: tên tab chỉ nhận cặp trần khi là nhóm số cuối; tin cậy cao thắng; dấu ngăn linh hoạt ở tiêu đề; khoảng ngày và năm lẻ không thành mùa', () => {
  for (const [name, want] of [['ĐP 28 29 THÁNG 9', ''], ['ĐP 28-29/9', ''], ['ĐP 30-31 T8', ''], ['ĐP T9 (28 29)', '2829'], ['ĐP 28-29/9 LỚP 6 2728', '2728'], ['LỚP 6 - 28 29/8 (ĐP) 2728', '2728'],
    ['LỚP 6 26.27 (ĐP)', '2627'], ['LỚP 6 26 27 (ĐP)', '2627'], ['Tab 2223 hs (ĐP)', ''], ['ĐP 2021', ''], ['ĐP 2122', ''], ['LỚP 10 2728 (ĐP)', '2728'], ['HB 2728 (ĐP) 2627', '2627']]) assert.equal(A.seasonCodeOf(name, true), want, name);
  for (const [name, want] of [['Khối 27 28', '2728'], ['Khối 27.28', '2728'], ['Khối 27_28', '2728'], ['Khối 27—28', '2728'], ['Khối 27, 28', '2728'], ['Khối 27 (28)', '2728'], ['Khối 27\u201128', '2728'], ['Khối 27 28 (2 cột)', '2728'],
    ['Khối 6 (cập nhật 28-29/10) 27 28', '2728'], ['Khối 2027–28', '2728'], ['KHỐI 27-28', '2728'], ['Khối  27  28', '2728'], ['Khối (2027-2028)', '2728'], ['Khối 10 11', ''], ['Khối 20 21', ''], ['Khối 2021', ''], ['Khối', ''], ['Khối 6', ''], ['Khối 27 đến 28', '']]) assert.equal(A.seasonCodeOf(name, false), want, name);
  const long = 'ĐP ' + '7 '.repeat(100000), t0 = Date.now(); assert.equal(A.seasonCodeOf(long, true), ''); assert.ok(Date.now() - t0 < 1500, 'tuyến tính');
});

test('aggregate: tiêu đề cột Khối không đọc được mùa mà các tab (ĐP) mang nhiều mã mùa thì dừng và nói rõ; tiêu đề viết kiểu khác vẫn lọc được tab mùa cũ', () => {
  const mkReg = khoi => sheetOf(['MDT', 'HS nội bộ', 'Họ tên học sinh', khoi, 'Chiến dịch'], [[1, null, 'A', 'Khối 6', 'TS6'], [2, null, 'B', 'Khối 6', 'TS6'], [3, null, 'C', 'Khối 6', 'TS6'], [4, null, 'D', 'Khối 6', 'TS6'], [5, null, 'E', 'Khối 6', 'TS6'], [6, null, 'F', 'Khối 6', 'TS6']]);
  const tabs = [paidTab('LỚP 6 2627 (ĐP)', [[1, null, 'A'], [2, null, 'B'], [3, null, 'C'], [4, null, 'D']]), paidTab('LỚP 6 2728 (ĐP)', [[5, null, 'E']])];
  for (const h of ['Khối 27.28', 'Khối 27_28', 'Khối 27—28', 'Khối 27, 28', 'Khối 27 (28)', 'Khối 27\u201128']) { const r = A.aggregate({ reg: mkReg(h), paid: tabs }).summary; assert.deepEqual([r.season, r.total.paid, r.checks.paidTabsSkipped], ['2027–28', 1, ['LỚP 6 2627 (ĐP)']], h); }
  for (const h of ['Khối', 'Khối 6', 'Khối 27 đến 28']) { const e = A.aggregate({ reg: mkReg(h), paid: tabs }); assert.equal(e.ok, false, h); assert.match(e.error, /2627/); assert.match(e.error, /2728/); assert.match(e.error, /tab \(ĐP\)/); }
  assert.ok(A.aggregate({ reg: mkReg('Khối'), paid: [tabs[1]] }).ok);                                         // chỉ một mã mùa trong các tab: không có gì để nhầm
  assert.ok(A.aggregate({ reg: mkReg('Khối'), paid: [paidTab('LỚP 6 (ĐP)', [[1, null, 'A']])] }).ok);        // tab không ghi mùa
});

test('scanText: nhận số di động Việt Nam ở nhiều kiểu viết (ngoặc, 0084, nhóm 2-4-4, dấu cách toàn chiều rộng, CSV) mà không bắt nhầm đường vẽ SVG, ngày giờ, tiền', () => {
  for (const pattern of ['(0xx) xxx xxxx', '(0xxx) xxx xxx', '(+84) xxx xxx xxx', '(84) xxx xxx xxx', '+84 (0)xxx xxx xxx', '0084 xxx xxx xxx', '0084xxxxxxxxx', '0x xxxx xxxx', '0xxx xx xx xx', '0xx xxxx xxx',
    '0xxx　xxx　xxx', '0xxx​xxx​xxx', 'A,0xxx xxx xxx,6', '0xxx.xxx.xxx', '0xxx-xxx-xxx', '0xxx xxx xxx', '0xxx–xxx–xxx']) assert.deepEqual(scanText(ph(pattern)).map(x => x.kind), ['phone'], pattern);
  assert.deepEqual(scanText(ph('0xxx xxx xxx') + ',' + ph('0xxx xxx xxx')).map(x => x.kind), ['phone', 'phone']);
  assert.deepEqual(scanText(ph('0xxxxxxxxx').replace(/\d/g, d => String.fromCharCode(0xff10 + +d))).map(x => x.kind), ['phone']);   // chữ số toàn chiều rộng
  for (const ok of ['d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"', 'd="M0 9.5 3 7.5 3 5 8 3 1"', '0 9 1 8 3 7 4 6 5', '2026-10-15 03:05:07', '5,987,654,321 đ', '0900000000', '999999999', '1.234.567.890', '86400000', 'noreply@anthropic.com'])
    assert.deepEqual(scanText(ok), [], ok);
});

test('scanHistory: file dữ liệu đổi tên, số điện thoại trong tên tệp hay lời nhắn commit, và cách nói với kho nhân bản mirror', async () => {
  const { execFileSync } = await import('node:child_process'), { mkdtempSync, writeFileSync, rmSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'adm-hist2-')), mirror = join(tmpdir(), 'adm-mirror-' + Date.now());
  try {
    const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.com'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'a.js'), 'const x = 1;\n'); g('add', '.'); g('commit', '-q', '-m', 'sạch\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
    assert.deepEqual(scanHistory(dir, new Set()).hits, []);                                                              // dòng Co-Authored-By công khai không phải dữ liệu cá nhân
    writeFileSync(join(dir, 'students.dat'), Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4, 0, 0]), Buffer.from('xl/workbook.xml')]));   // file xlsx đổi tên
    writeFileSync(join(dir, 'gọi ' + ph('0xxxxxxxxx') + '.txt'), 'x\n');
    g('add', '-f', '.'); g('commit', '-q', '-m', 'liên hệ ' + ph('0xxx xxx xxx') + ' hoặc ' + mail('ai.do', 'truong.edu.vn'));
    const r = scanHistory(dir, new Set()), got = r.hits.map(h => h.kind + ':' + h.path).sort();
    assert.deepEqual(got, ['data-file:students.dat', 'email:(nội dung commit)', 'phone:(nội dung commit)', 'phone:(tên tệp)']);
    assert.ok(!JSON.stringify(r).includes(ph('0xxxxxxxxx')));
    assert.equal(sniffData(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1])), true); assert.equal(sniffData(Buffer.from('%PDF-1.4')), true); assert.equal(sniffData(Buffer.from('const a = 1;')), false);
    execFileSync('git', ['clone', '-q', '--mirror', 'file://' + dir, mirror], { stdio: 'pipe' });
    assert.deepEqual(scanHistory(mirror, new Set()).warnings, []);                                                       // bản mirror đủ ref: không cảnh báo nhầm
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(mirror, { recursive: true, force: true }); }
});

test('npm run privacy: mã thoát 0 khi sạch và quét đủ, 1 khi thấy, 2 khi chưa kết luận hoặc không quét được', async () => {
  const { execFileSync } = await import('node:child_process'), { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, rmSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'adm-cli-')), src = join(root, 'src'), full = join(root, 'full'), shallow = join(root, 'shallow'), plain = join(root, 'plain');
  const run = dir => { try { return { code: 0, out: execFileSync('node', [join(dir, 'scripts', 'scan-history.mjs')], { stdio: 'pipe', encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: String(e.stdout) }; } };
  try {
    const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
    mkdirSync(join(src, 'scripts'), { recursive: true }); g(src, 'init', '-q', '-b', 'main'); g(src, 'config', 'user.email', 't@example.com'); g(src, 'config', 'user.name', 't'); g(src, 'config', 'commit.gpgsign', 'false');
    copyFileSync(new URL('./scan-history.mjs', import.meta.url), join(src, 'scripts', 'scan-history.mjs')); writeFileSync(join(src, 'a.js'), '1;\n'); g(src, 'add', '.'); g(src, 'commit', '-q', '-m', 'một');
    writeFileSync(join(src, 'b.js'), '2;\n'); g(src, 'add', '.'); g(src, 'commit', '-q', '-m', 'hai');
    execFileSync('git', ['clone', '-q', 'file://' + src, full], { stdio: 'pipe' });
    const ok = run(full); assert.equal(ok.code, 0, ok.out); assert.match(ok.out, /Không thấy gì trong/); assert.match(ok.out, /Không thấy gì[^]*số bàn/);   // nói rõ những gì bộ quét không thấy
    writeFileSync(join(full, 'leak.js'), "const p = '" + ph('0xxxxxxxxx') + "';\n"); g(full, 'add', '.'); g(full, 'commit', '-q', '-m', 'lỡ');
    const bad = run(full); assert.equal(bad.code, 1); assert.match(bad.out, /phone  leak\.js/); assert.ok(!bad.out.includes(ph('0xxxxxxxxx')));
    execFileSync('git', ['clone', '-q', '--depth', '1', 'file://' + src, shallow], { stdio: 'pipe' });
    const sh = run(shallow); assert.equal(sh.code, 2); assert.match(sh.out, /Chưa kết luận/);
    mkdirSync(join(plain, 'scripts'), { recursive: true }); copyFileSync(new URL('./scan-history.mjs', import.meta.url), join(plain, 'scripts', 'scan-history.mjs'));   // không phải kho git
    const none = run(plain); assert.equal(none.code, 2); assert.match(none.out, /Không quét được/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


/* ---- số điện thoại và email phụ huynh (chỉ để khớp trong bộ nhớ) ---- */
// số giả dựng lúc chạy từ số thứ tự: không có chuỗi số điện thoại nào nằm trong mã nguồn (kho công khai)
const phn = n => '9' + String(12345678 + n * 100003);
test('phoneKey: mọi cách viết số di động Việt Nam về cùng một khoá 9 chữ số; số lạ, lặp chữ số, quá ngắn hoặc dài bị loại', () => {
  const k = phn(1);
  for (const v of ['0' + k, '+84' + k, '84' + k, '0084' + k, '+84 ' + k.slice(0, 3) + ' ' + k.slice(3, 6) + ' ' + k.slice(6), '0' + k.slice(0, 3) + '.' + k.slice(3, 6) + '.' + k.slice(6), '(0' + k.slice(0, 2) + ') ' + k.slice(2), 'p:+84' + k, ' 0' + k + ' ', '0' + k + 'a', Number(k), Number('0' + k)])
    assert.equal(A.phoneKey(v), k, String(v));
  const land = '2' + '4' + String(36251234);                                                          // số bàn mã vùng 24: 10 chữ số bắt đầu bằng 2 sau khi bỏ số 0 đầu
  assert.equal(A.phoneKey('0' + land), land);
  for (const bad of [null, undefined, '', ' ', true, false, 'abc', 123, '12345678', '0' + k + '9', '+84' + k + k, '0' + '9'.repeat(9), '0' + '90'.repeat(4) + '9', 1e15, -5, NaN, Infinity, {}, [], '0' + '1' + k.slice(1)])
    assert.equal(A.phoneKey(bad), '', String(bad));
});
test('phoneKeys và emailKeys: một ô có thể ghi nhiều số/email cách nhau bằng dấu phân cách; không trùng; email chuẩn hoá chữ thường', () => {
  const a = phn(2), b = phn(3);
  assert.deepEqual(A.phoneKeys('0' + a + ' / 0' + b), [a, b]);
  assert.deepEqual(A.phoneKeys('0' + a + ',0' + a + ';+84' + b + '\n'), [a, b]);
  assert.deepEqual(A.phoneKeys('0' + a), [a]); assert.deepEqual(A.phoneKeys(Number(a)), [a]);
  assert.deepEqual(A.phoneKeys('không có'), []); assert.deepEqual(A.phoneKeys(null), []);
  assert.equal(A.emailKey('  Phu.Huynh+1@Example.COM '), 'phu.huynh+1@example.com');
  for (const bad of ['', 'a@example', 'a b@example.com', '@example.com', 'a@@example.com', null, 5, 'x'.repeat(130) + '@example.com']) assert.equal(A.emailKey(bad), '', String(bad));
  assert.deepEqual(A.emailKeys('p1@example.com; P1@Example.com,  q2@example.org'), ['p1@example.com', 'q2@example.org']);
});
test('aggregate({collect:true}): lấy SĐT/email từ mọi cột SĐT, Zalo, email ở tab đăng ký và tab ĐP; không có collect thì không trả học sinh; bản tổng hợp không chứa SĐT', () => {
  const p1 = phn(11), p2 = phn(12), p3 = phn(13), p4 = phn(14), p5 = phn(15), p6 = phn(16), em = 'phuhuynh1@example.com';
  const hdr = ['MDT', 'HS nội bộ', 'Họ tên học sinh', 'Khối 27 28', 'Chiến dịch', 'SĐT bố', 'SĐT mẹ', 'Zalo ưu tiên', 'Email phụ huynh', 'Ghi chú'];
  const reg = sheetOf(hdr, [
    [1, null, 'A', 'Khối 6', 'TS6', '0' + p1, Number(p2), null, em, '0' + p6 + ' gọi sau'],   // p6 nằm ở cột Ghi chú: không phải cột SĐT nên bị bỏ qua
    [2, 20000001, 'B', 'Khối 6', 'TS6', null, null, '+84' + p5, null, null],
    [3, null, 'C', 'Khối 6', 'TS6', null, null, null, null, null]]);
  const paid = [paidTab('LỚP 6 2728 (ĐP)', [[1, null, 'A', '0' + p4], [3, null, 'C', '0' + p3]], ['MDT', 'HS nội bộ', 'Họ tên học sinh', 'SĐT ưu tiên'])];
  const r = A.aggregate({ reg, paid, collect: true, today: '2026-11-20' });
  assert.ok(r.ok); const S = r.students;
  assert.deepEqual(S[1].ph, [p1, p2, p4]);                                                          // p4: SĐT chỉ ghi ở tab ĐP vẫn được gộp vào học sinh
  assert.deepEqual(S[1].em, [em]); assert.equal(S[1].paid, true); assert.equal(S[1].int, false);
  assert.deepEqual(S[2].ph, [p5]); assert.equal(S[2].int, true); assert.equal(S[2].paid, false);
  assert.deepEqual(S[3].ph, [p3]); assert.equal(S[3].paid, true);
  const json = JSON.stringify(r.summary);
  for (const k of [p1, p2, p3, p4, p5, p6, em]) assert.ok(!json.includes(k), 'bản tổng hợp không được chứa số điện thoại hay email');
  assert.ok(A.validate(r.summary).ok);
  const plain = A.aggregate({ reg, paid, today: '2026-11-20' });
  assert.equal(plain.students, undefined);                                                         // không yêu cầu thì không trả học sinh
  assert.deepEqual(JSON.parse(JSON.stringify(plain.summary)), JSON.parse(JSON.stringify(r.summary))); // collect không đổi số tổng hợp
});

test('phoneKeys: nhiều số trong một ô (cách bằng dấu cách, gạch, "và", "&", ngoặc, "Bố:/Mẹ:"), số kèm ghi chú có chữ số; không biến ngày, mã, chữ thường thành số', () => {
  const a = phn(21), b = phn(22), c = phn(23), A0 = '0' + a, B0 = '0' + b;
  for (const v of [A0 + ' ' + B0, A0 + ' - ' + B0, A0 + '-' + B0, A0 + ' và ' + B0, A0 + ' & ' + B0, A0 + ' (bố) ' + B0 + ' (mẹ)', 'Bố: ' + A0 + ' Mẹ: ' + B0, '+84' + a + ' / ' + B0, '84' + a + ' ' + B0, A0 + '\n' + B0, A0 + ', ' + B0 + '; ' + '0' + c])
    assert.deepEqual(A.phoneKeys(v).slice(0, 2), [a, b], String(v));
  assert.deepEqual(A.phoneKeys(A0 + ', ' + B0 + '; 0' + c), [a, b, c]);
  for (const v of [A0 + ' (gọi sau 5h)', A0 + ' ext 12', A0 + ' (zalo 2)', A0 + ' (24/7)', A0 + ' 5', 'Zalo ' + A0, A0 + ' – gọi giờ hành chính']) assert.deepEqual(A.phoneKeys(v), [a], String(v));
  assert.equal(A.phoneKeys(Array.from({ length: 9 }, (_, i) => '0' + phn(40 + i)).join(' ')).length, 6);                    // tối đa 6 khoá mỗi ô
  for (const v of ['12/03/2016', '2016-03-12', '01/10/2026 10:15', '12345', 'MS' + '2023' + '0001', 'khối 6, lớp 6A2', '(24/7)', '2026', 'abc', '']) assert.deepEqual(A.phoneKeys(v), [], String(v));
});
test('columnsOf: tên cột SĐT/email có đuôi số hoặc dính liền vẫn nhận; "Mã ĐT", "Ngày ĐT" không phải cột SĐT', () => {
  const info = h => A.columnsInfo([['MDT', h]]);
  for (const h of ['SĐT', 'SĐT bố', 'SĐT 1', 'SĐT1', 'SĐT2', 'SĐTbố', 'Phone 1', 'Phone1', 'Zalo', 'Số ĐT', 'ĐT mẹ', 'ĐT', 'Điện thoại PH', 'Số điện thoại', 'Di động', 'Mobile', 'Hotline']) assert.equal(info(h).phones, 1, h);
  for (const h of ['Email', 'Email 1', 'Email1', 'Gmail', 'E-mail ưu tiên', 'Thư điện tử']) assert.equal(info(h).emails, 1, h);
  for (const h of ['Mã ĐT', 'Ngày ĐT', 'Mã DT', 'Ưu tiên', 'Họ tên phụ huynh', 'Trường học', 'Ghi chú']) assert.equal(info(h).phones + info(h).emails, 0, h);
});
test('HS nội bộ: mã, TRUE, "x", "Có" là nội bộ; trống, FALSE, 0, "Không", "No", "N/A", "Loading...", ô lỗi (#N/A, #REF!) không phải (không để cả lớp thành nội bộ)', () => {
  const vals = [[7, true], [20000001, true], [true, true], ['x', true], ['Có', true], ['HS-NB', true], ['001', true], [null, false], ['', false], ['  ', false], [false, false], ['FALSE', false], ['false', false], [0, false], ['0', false], ['Không', false], ['không', false], ['KHONG', false], ['No', false], ['N', false], ['n/a', false], ['#N/A', false], ['#REF!', false], ['#VALUE!', false], ['Loading...', false], ['-', false]];
  const reg = [[], ['MDT', 'HS nội bộ', 'Họ tên học sinh', 'Khối 27 28', 'Chiến dịch'], ...vals.map(([v], i) => [i + 1, v, 'HS ' + i, 'Khối 6', 'TS6'])];
  const r = A.aggregate({ reg, paid: [paidTab('X (ĐP)', [[1, null, 'HS']])], collect: true, today: '2026-11-20' }); assert.ok(r.ok, r.error);
  vals.forEach(([v, want], i) => assert.equal(r.students[i + 1].int, want, JSON.stringify(v)));
  assert.equal(r.summary.total.regInt, vals.filter(x => x[1]).length);
});
