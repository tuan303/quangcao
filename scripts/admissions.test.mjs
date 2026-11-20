// Kiểm thử offline cho phần Chuyển đổi tuyển sinh: đọc bảng, tổng hợp, kiểm tra dữ liệu gửi lên, ghép chiến dịch, tỷ lệ chuyển đổi.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../fbads-core.js';
import '../admissions.js';
const A = globalThis.FBAdm, C = globalThis.FBCore;

const ZIP = new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]); // đầu file .xlsx (zip)
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
  assert.deepEqual([A.windowOf(season, '2026-10-01', '2026-10-14', today).s, A.windowOf(season, '2026-10-01', '2026-10-14', today).e, A.windowOf(season, '2026-10-01', '2026-10-14', today).mode], ['2026-08-01', '2026-10-15', 'season']);
  assert.deepEqual(A.windowOf(season, 'x', 'y', '2027-09-01'), { mode: 'season', s: '2026-08-01', e: '2027-07-31', outside: false, clipped: false, seasonStart: '2026-08-01' }); // sang năm học mới vẫn là mùa trong file
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

test('vệ sinh dữ liệu: kho mã không chứa số điện thoại, file Excel hay dữ liệu học sinh thật', async () => {
  const { execFileSync } = await import('node:child_process');
  const { readFileSync, existsSync } = await import('node:fs');
  let files; try { files = execFileSync('git', ['ls-files', '-z'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }).split('\0').filter(Boolean); } catch { return; } // ngoài kho git thì bỏ qua
  assert.deepEqual(files.filter(f => /\.(xlsx?|xlsb|csv|ods)$/i.test(f) || /(^|\/)dev-docs\.json$/.test(f)), [], 'không đưa file dữ liệu vào kho (kho công khai)');
  const phone = /(^|[^0-9.])((?:\+?84|0)?[35789][0-9]{8})($|[^0-9.])/g;
  const hits = [];
  for (const f of files) {
    if (/^(vendor\/|package-lock\.json$)/.test(f) || /\.(png|jpe?g|ico|woff2?)$/i.test(f) || !existsSync(new URL('../' + f, import.meta.url))) continue;
    for (const m of readFileSync(new URL('../' + f, import.meta.url), 'utf8').matchAll(phone)) if (new Set(m[2].replace(/^\+?84/, '')).size > 2) hits.push(f + ': ' + m[2].slice(0, 3) + '…'); // số lặp chữ số (999999999, 0900000000) là dữ liệu giả
  }
  assert.deepEqual(hits, [], 'có chuỗi giống số điện thoại trong kho mã');
});
