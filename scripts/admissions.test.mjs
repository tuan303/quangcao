// Kiểm thử offline cho phần Chuyển đổi tuyển sinh: đọc bảng, tổng hợp, kiểm tra dữ liệu gửi lên, ghép chiến dịch, tỷ lệ chuyển đổi.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../fbads-core.js';
import '../admissions.js';
const A = globalThis.FBAdm, C = globalThis.FBCore;

const HDR = ['MDT', 'HS nội bộ', 'Họ tên học sinh', 'Ngày sinh', 'Giới tính', 'Khối 27 28', 'Lớp', 'Trường học', 'Chiến dịch'];
const stu = (mdt, internal, khoi, prog, extra = []) => [mdt, internal, 'TÊN HỌC SINH ' + mdt, '2016-01-01', 'Nam', khoi, null, 'Trường ABC', prog, ...extra];
function sampleInput(withDates) {
  const hdr = withDates ? HDR.concat(['Ngày đăng ký', 'Ngày đóng phí']) : HDR;
  const d = (a, b) => withDates ? [a, b] : [];
  const reg = [[2434, 865], hdr,
    stu(1001, null, 'Khối 6', 'TS6', d('01/10/2026', 46305)),   // 46305 = 10/10/2026
    stu(1002, 24120440, 'Khối 6', 'TS6', d('02/10/2026', null)),
    stu(1003, null, 'Khối 10', 'TS10', d('2026-10-03', '2026-10-12')),
    stu(1004, null, 'Khối 1', 'JS', d(46296, null)),
    stu(1004, null, 'Khối 1', 'JS', d(46296, null)),           // trùng MDT
    stu(1005, null, 'Khối 2', 'HB', d(46297, 46299)),
    stu(1006, null, 'Khối 1', 'TS1', d(46297, null)),
    [null, null, null]];
  const paid = [
    { name: 'LỚP 6 2728 (ĐP)', rows: [[], [null, null, 'Count'], ['MDT', 'HS nội bộ', 'Họ tên học sinh'], [630], [1001, null, 'TÊN', '2016-01-01'], [1002, 24120440, 'TÊN', '2016-01-01'], [9999, null, 'KHÔNG CÓ TRONG DS', '2016-01-01']] },
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
  for (const bad of [null, '', 'abc', 12, 932321516, '31/13/2026', '01/01/1990']) assert.equal(A.parseDate(bad), '', String(bad));
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
  const r = A.readWorkbook(X, new ArrayBuffer(1));
  assert.ok(r.ok); assert.deepEqual(asked[0], ['Danh sách đăng ký', 'LỚP 6 2728 (ĐP)', 'HB 2728 (ĐP)']);
  assert.equal(r.summary.total.paid, 3);
  assert.equal(A.readWorkbook({ read: () => ({ SheetNames: ['Sheet1'] }), utils: {} }, new ArrayBuffer(1)).ok, false);
});

test('packOf: gói cho phần Phân tích chỉ gồm số tổng hợp, theo mùa và (khi có ngày) 30 ngày', () => {
  const A1 = '895057262833914', day = '2026-10-10', dv = C.zero(); dv[C.MI.spend] = 3e6; dv[C.MI.impr] = 5000;
  const v = C.zero(); v[C.MI.spend] = 3e6; v[C.MI.lead] = 30; v[C.MI.impr] = 5000;
  const camp = { acct: A1, rows: { a: { n: 'TS6-LEAD | Form', obj: 'OUTCOME_LEADS', m: v } }, monthly: {} }, campd = { acct: A1, since: '2026-09-01', rows: { a: { [day]: v } } };
  const m = C.model({ ['acct-' + A1]: { acct: A1, daily: { [day]: dv } }, ['camp-' + A1]: camp, ['campd-' + A1]: campd });
  const sum = A.aggregate(sampleInput(true)).summary;
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

