// Kiểm thử offline cho phần đối chiếu từng phụ huynh: lead Facebook ↔ học sinh đã đóng phí (leadmatch.js).
// Mọi số điện thoại là số giả dựng lúc chạy (kho mã công khai: không có số thật, tên thật hay email thật).
import test from 'node:test';
import assert from 'node:assert/strict';
import '../fbads-core.js';
import '../admissions.js';
import '../leadmatch.js';
const A = globalThis.FBAdm, M = globalThis.FBMatch;

const phn = n => '9' + String(10000000 + (n * 7919 + 12345) % 89999999);        // khoá 9 chữ số của số giả thứ n (luôn 8 chữ số sau số 9, không trùng nhau, không phải dãy tăng/giảm)
const st = (p, o = {}) => Object.assign({ p, k: 'Khối 6', int: false, paid: false, rd: '', pd: '', ph: [], em: [] }, o);
const FORM = 'TS6-LEAD | Form tư vấn', FORM10 = 'TS10-LEAD | Form';
const lead = (id, t, cid, name, phone, extra = {}) => M.leadFromGraph(Object.assign({
  id, created_time: t, campaign_id: cid, campaign_name: name,
  field_data: [{ name: 'full_name', values: ['Tên Phụ Huynh ' + id] }, { name: 'phone_number', values: [phone] }]
}, extra));
const at = (day, hh = 3) => day + 'T' + String(hh).padStart(2, '0') + ':00:00+0000';   // giờ UTC; 03:00 UTC = 10:00 giờ Việt Nam cùng ngày
const cellOf = (r, day, cid) => r.days[day] && r.days[day][cid];

test('leadFromGraph: ngày giờ Việt Nam, SĐT/email từ ô chuẩn và ô tự đặt tên, chiến dịch, lead tự nhiên; không giữ họ tên', () => {
  const k = phn(1), k2 = phn(2);
  const l = M.leadFromGraph({ id: 'L1', created_time: '2026-10-02T18:30:00+0000', campaign_id: 'c120211', campaign_name: 'TS6-LEAD | Form <b>x</b>', is_organic: false, field_data: [
    { name: 'full_name', values: ['Nguyễn Văn A'] }, { name: 'phone_number', values: ['p:+84' + k] }, { name: 'email', values: ['PH@Example.com'] },
    { name: 'số_điện_thoại_zalo', values: ['0' + k2] }, { name: 'ghi_chu', values: ['con học lớp 6, sinh năm 2016'] }] });
  assert.equal(l.day, '2026-10-03'); assert.equal(l.at, '2026-10-03T01:30:00');                    // 18:30 UTC ngày 02 = 01:30 ngày 03 giờ Việt Nam
  assert.deepEqual(l.ph, [k, k2]); assert.deepEqual(l.em, ['ph@example.com']);
  assert.equal(l.cid, '120211'); assert.equal(l.cname, 'TS6-LEAD | Form b x /b');   // ký tự lạ (< >) thành dấu cách: không chèn thẻ, không dính hai từ lại; giữ gạch chéo vì tên chiến dịch hay có
  assert.equal(l.prog, 'TS6');                                                       // chương trình theo tên NGUYÊN VĂN, cùng cách ghép với chi tiêu
  assert.equal(l.organic, false);
  assert.ok(!JSON.stringify(l).includes('Nguyễn'), 'họ tên không được giữ');
  const odd = M.leadFromGraph({ id: 'L2', created_time: '2026-10-02T03:00:00+0000', campaign_id: '', field_data: [{ name: 'trường_học', values: ['0' + k] }] });
  assert.deepEqual(odd.ph, [k]); assert.equal(odd.cid, M.NONE);                                    // ô tên lạ nhưng giá trị là số điện thoại; không có chiến dịch
  const org = M.leadFromGraph({ id: 'L3', created_time: '2026-10-02T03:00:00+0000', campaign_id: '123456', is_organic: true, field_data: [] });
  assert.equal(org.cid, M.ORGANIC); assert.equal(org.organic, true);
  assert.equal(M.leadFromGraph({ id: 'L4', created_time: '2026-10-02T03:00:00+0000', is_organic: 'true' }).organic, true);
  for (const junk of [null, undefined, {}, [], 5, 'x', { field_data: 'x' }, { field_data: [null, { values: 7 }, { name: 'phone', values: [null, {}, [], true] }], created_time: 'không phải ngày' }]) {
    const j = M.leadFromGraph(junk); assert.deepEqual(j.ph, []); assert.deepEqual(j.em, []); assert.equal(j.day, '');
  }
});

test('matchLeads: kịch bản cơ bản — đăng ký, đóng phí, chỉ học sinh nội bộ, lead không khớp, lead không có liên hệ', () => {
  const [pA, pB, pC, pD, pE, pF] = [1, 2, 3, 4, 5, 6].map(phn);
  const S = {
    1: st('TS6', { paid: true, ph: [pA], rd: '2026-10-03', pd: '2026-10-10' }), 2: st('TS6', { ph: [pB], rd: '2026-10-04' }),
    3: st('TS6', { int: true, paid: true, ph: [pC] }), 4: st('TS10', { paid: true, ph: [pD, pE], rd: '2026-10-06', pd: '2026-10-15' }), 5: st('HB', { paid: true })
  };
  const leads = [lead('a', at('2026-10-02'), '111111', FORM, 'p:+84' + pA), lead('b', at('2026-10-01'), '222222', 'TS6 remarketing', '0' + pA), lead('c', at('2026-10-03'), '111111', FORM, '+84 ' + pB),
    lead('d', at('2026-10-04'), '111111', FORM, '0' + pC), lead('e', at('2026-10-05'), '333333', FORM10, '0' + pE), lead('f', at('2026-10-06'), '333333', FORM10, '0' + phn(77)), lead('g', at('2026-10-06'), '', '', 'khong co so')];
  const r = M.matchLeads(leads, S);
  assert.deepEqual(r.leads, { rows: 7, parents: 5, noContact: 1, hubKeys: 0, organic: 0, dupFamily: 0, ambiguous: 0, matched: 3, internalOnly: 1, preRegistered: 0, crossProgram: 0 });
  assert.deepEqual(cellOf(r, '2026-10-01', '222222'), [1, 0, 0, 1, 1, 1, 1]);                      // lead đầu tiên (first touch) của phụ huynh A: chiến dịch 222222, không phải 111111
  assert.equal(cellOf(r, '2026-10-02', '111111'), undefined);
  assert.deepEqual(cellOf(r, '2026-10-03', '111111'), [1, 0, 0, 1, 0, 1, 0]);                      // đăng ký chưa đóng phí
  assert.deepEqual(cellOf(r, '2026-10-04', '111111'), [1, 1, 0, 0, 0, 0, 0]);                      // chỉ khớp học sinh nội bộ
  assert.deepEqual(cellOf(r, '2026-10-05', '333333'), [1, 0, 0, 1, 1, 1, 1]);                      // khớp qua số thứ hai của học sinh
  assert.deepEqual(cellOf(r, '2026-10-06', '333333'), [1, 0, 0, 0, 0, 0, 0]);                      // không khớp học sinh nào
  assert.deepEqual([r.from, r.to, r.winFrom], ['2026-10-01', '2026-10-06', '2026-10-01']);
  assert.deepEqual(r.camps['222222'], { n: 'TS6 remarketing', p: 'TS6' }); assert.equal(r.camps['333333'].p, 'TS10');
  assert.deepEqual(r.unmatchedPaid, {}); assert.deepEqual(r.paidNoPhone, { HB: 1 });               // HS nội bộ không tính; em HB chưa có SĐT nên chưa thể khớp
  assert.deepEqual(r.cov, { students: 5, withPhone: 4, ext: 4, extWithPhone: 3, extWithRegDate: 3, paidExt: 3, paidExtWithPhone: 2, paidByProg: { TS6: [1, 1], TS10: [1, 1], HB: [1, 0] } });
  assert.deepEqual(r.lag, { reg: [3, 1, 2], paid: [2, 9, 10] });
  assert.ok(M.validate(r).ok, M.validate(r).error);
});

test('matchLeads: một phụ huynh điền nhiều lần (nhiều kiểu viết số, nhiều chiến dịch) chỉ tính một lần, theo lần đầu; thứ tự đầu vào không đổi kết quả', () => {
  const k = phn(5), S = { 1: st('TS6', { paid: true, ph: [k], rd: '2026-10-09', pd: '2026-10-20' }) };
  const ls = [lead('z3', at('2026-10-03'), '222222', 'TS6 remarketing', '+84' + k), lead('z1', at('2026-10-01'), '111111', FORM, '0' + k), lead('z2', at('2026-10-02'), '111111', FORM, '(0' + k.slice(0, 2) + ') ' + k.slice(2))];
  const r = M.matchLeads(ls, S);
  assert.equal(r.leads.rows, 3); assert.equal(r.leads.parents, 1);
  assert.deepEqual(Object.keys(r.days), ['2026-10-01']); assert.deepEqual(cellOf(r, '2026-10-01', '111111'), [1, 0, 0, 1, 1, 1, 1]);
  // cùng một giờ: thứ tự ổn định theo mã lead; xáo trộn đầu vào cho đúng một kết quả
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const many = [], SS = {};
  for (let i = 0; i < 40; i++) SS[i] = st(['TS1', 'TS6', 'TS10', 'JS'][i % 4], { paid: i % 3 === 0, int: i % 11 === 0, ph: [phn(100 + i), ...(i % 5 === 0 ? [phn(200 + i)] : [])], rd: '2026-10-' + String(5 + (i % 20)).padStart(2, '0') });
  for (let i = 0; i < 70; i++) many.push(lead('m' + i, at('2026-10-' + String(1 + (i % 25)).padStart(2, '0'), 1 + (i % 3)), String(100000 + (i % 4)), ['TS1-A', 'TS6-B', 'TS10-C', 'JS-D'][i % 4], '0' + (i % 9 === 0 ? phn(900 + i) : i % 6 === 0 ? phn(200 + (i % 40)) : phn(100 + (i % 40)))));
  const base = JSON.stringify(M.matchLeads(many, SS));
  for (let t = 0; t < 5; t++) { const sh = many.slice().sort(() => rnd() - 0.5); assert.equal(JSON.stringify(M.matchLeads(sh, SS)), base); }
});

test('matchLeads: bố và mẹ cùng điền form cho một em: cả hai là phụ huynh có con đã đóng phí nhưng học sinh chỉ tính một lần (lead sớm hơn); em thứ hai chỉ có SĐT của mẹ thì mẹ cũng được tính cho em đó', () => {
  const [f, m] = [phn(21), phn(22)];
  const S = { 1: st('TS6', { paid: true, ph: [f, m], rd: '2026-10-05', pd: '2026-10-09' }) };
  let r = M.matchLeads([lead('1', at('2026-10-01'), '111111', FORM, '0' + f), lead('2', at('2026-10-02'), '222222', 'TS6 remarketing', '0' + m)], S);
  assert.equal(r.leads.dupFamily, 1); assert.equal(r.leads.parents, 2);
  assert.deepEqual(cellOf(r, '2026-10-01', '111111'), [1, 0, 0, 1, 1, 1, 1]); assert.deepEqual(cellOf(r, '2026-10-02', '222222'), [1, 0, 0, 1, 1, 0, 0]);   // mẹ: một phụ huynh có con đóng phí, không thêm học sinh
  r = M.matchLeads([lead('1', at('2026-10-01'), '111111', FORM, '0' + f), lead('2', at('2026-10-02'), '222222', 'TS6 remarketing', '0' + m)].reverse(), S);
  assert.equal(r.leads.dupFamily, 1); assert.deepEqual(cellOf(r, '2026-10-01', '111111'), [1, 0, 0, 1, 1, 1, 1]); assert.deepEqual(cellOf(r, '2026-10-02', '222222'), [1, 0, 0, 1, 1, 0, 0]);
  // hai em: em thứ hai chỉ có SĐT của mẹ → lead của mẹ vẫn được tính, cho em đó
  const S2 = { 1: st('TS6', { paid: true, ph: [f, m], rd: '2026-10-05', pd: '2026-10-09' }), 2: st('TS10', { ph: [m], rd: '2026-10-06' }) };
  r = M.matchLeads([lead('1', at('2026-10-01'), '111111', FORM, '0' + f), lead('2', at('2026-10-02'), '222222', 'TS10 remarketing', '0' + m)], S2);
  assert.equal(r.leads.dupFamily, 0);
  assert.deepEqual(cellOf(r, '2026-10-01', '111111'), [1, 0, 0, 1, 1, 1, 1]); assert.deepEqual(cellOf(r, '2026-10-02', '222222'), [1, 0, 0, 1, 1, 1, 0]);   // mẹ: có con đã đóng phí (em 1, đã tính cho lead của bố) và em 2 chưa đóng phí chỉ tính cho mẹ
  // một phụ huynh có hai em: đăng ký 2, đóng phí 1; "có con đóng phí" tính một lần
  const S3 = { 1: st('TS6', { paid: true, ph: [f], rd: '2026-10-05', pd: '2026-10-09' }), 2: st('TS10', { ph: [f], rd: '2026-10-06' }), 3: st('JS', { paid: true, ph: [f], rd: '2026-10-07', pd: '2026-10-08' }) };
  r = M.matchLeads([lead('1', at('2026-10-01'), '111111', FORM, '0' + f)], S3);
  assert.deepEqual(cellOf(r, '2026-10-01', '111111'), [1, 0, 0, 1, 1, 3, 2]); assert.equal(r.leads.crossProgram, 2);   // em TS10 và JS không cùng chương trình với chiến dịch TS6
});

test('matchLeads: học sinh đã đăng ký hoặc đóng phí TRƯỚC ngày điền form không được tính cho form; cùng ngày hoặc không có ngày thì tính; không nằm trong mẫu số', () => {
  const [a, b, c, d] = [31, 32, 33, 34].map(phn);
  const S = { 1: st('TS6', { paid: true, ph: [a], rd: '2026-09-20', pd: '2026-09-25' }), 2: st('TS6', { paid: true, ph: [b], rd: '2026-10-01', pd: '2026-10-09' }),
    3: st('TS6', { paid: true, ph: [c], pd: '2026-09-30' }), 4: st('TS6', { paid: true, ph: [d] }) };
  const r = M.matchLeads(['a', 'b', 'c', 'd'].map((x, i) => lead(x, at('2026-10-01'), '111111', FORM, '0' + [a, b, c, d][i])), S);
  assert.deepEqual(cellOf(r, '2026-10-01', '111111'), [4, 0, 2, 2, 2, 2, 2]);                      // a, c: đã có trước form (b); b, d: tính
  assert.equal(r.leads.preRegistered, 2);
  assert.deepEqual(r.unmatchedPaid, { TS6: 2 });                                                   // 2 em đã có trước form vẫn là "đóng phí chưa khớp lead nào"
  const sum = M.summarize(r), rt = M.rates(sum.total, 1);
  assert.deepEqual([rt.base, rt.leadToReg, rt.leadToPaid, rt.regToPaid], [2, 1, 1, 1]);            // mẫu số bỏ 2 phụ huynh đã đăng ký trước
});

test('matchLeads: học sinh nội bộ không tính; phụ huynh có cả em nội bộ và em ngoài chỉ tính em ngoài; số dùng chung (hơn 6 em) là chưa khớp', () => {
  const [a, b, shared, six] = [41, 42, 43, 44].map(phn);
  const S = { 1: st('TS6', { int: true, paid: true, ph: [a] }), 2: st('TS6', { int: true, ph: [b], rd: '2026-10-02' }), 3: st('TS1', { paid: true, ph: [b], rd: '2026-10-03', pd: '2026-10-04' }) };
  for (let i = 0; i < 7; i++) S['s' + i] = st('TS6', { paid: i < 3, ph: [shared], rd: '2026-10-05', pd: i < 3 ? '2026-10-06' : '' });
  for (let i = 0; i < 6; i++) S['t' + i] = st('TS6', { paid: i < 2, ph: [six], rd: '2026-10-05', pd: i < 2 ? '2026-10-06' : '' });
  const r = M.matchLeads([lead('a', at('2026-10-01'), '111111', FORM, '0' + a), lead('b', at('2026-10-01'), '111111', FORM, '0' + b), lead('s', at('2026-10-01'), '111111', FORM, '0' + shared), lead('t', at('2026-10-01'), '111111', FORM, '0' + six)], S);
  assert.deepEqual(cellOf(r, '2026-10-01', '111111'), [4, 1, 0, 2, 2, 7, 3]);                      // a: chỉ nội bộ; b: em TS1 (1 em, đóng phí); shared: chưa khớp; six: 6 em (2 đóng phí)
  assert.equal(r.leads.ambiguous, 1); assert.equal(r.leads.internalOnly, 1); assert.equal(r.leads.matched, 2);
  assert.deepEqual(r.unmatchedPaid, { TS6: 3 });                                                   // 3 em đóng phí dùng chung một số chưa khớp lead nào
});

test('matchLeads: khớp bằng email khi lead không có SĐT; phụ huynh nhận ra qua email lần trước; lead tự nhiên và không rõ chiến dịch tách riêng', () => {
  const k = phn(51), mail = 'phuhuynh51@example.com';
  const S = { 1: st('JS', { paid: true, em: [mail], rd: '2026-10-05', pd: '2026-10-08' }), 2: st('TS6', { ph: [k], rd: '2026-10-05' }) };
  const only = M.leadFromGraph({ id: 'e1', created_time: at('2026-10-01'), campaign_id: '111111', campaign_name: 'JS26-LEAD', field_data: [{ name: 'email', values: ['PhuHuynh51@Example.com'] }] });
  const both = M.leadFromGraph({ id: 'e2', created_time: at('2026-10-02'), campaign_id: '222222', campaign_name: FORM, field_data: [{ name: 'email', values: [mail] }, { name: 'phone_number', values: ['0' + k] }] });
  let r = M.matchLeads([only, both], S);
  assert.equal(r.leads.parents, 1); assert.equal(r.leads.dupFamily, 0);                            // lead sau có thêm SĐT nhưng email đã nhận ra: một phụ huynh, ngày 01
  assert.deepEqual(cellOf(r, '2026-10-01', '111111'), [1, 0, 0, 1, 1, 2, 1]);                      // em JS (qua email) và em TS6 (qua SĐT của lead sau) đều gộp về phụ huynh này
  const org = M.leadFromGraph({ id: 'o1', created_time: at('2026-10-03'), campaign_id: '999999', is_organic: true, field_data: [{ name: 'phone_number', values: ['0' + phn(99)] }] });
  const none = M.leadFromGraph({ id: 'o2', created_time: at('2026-10-03'), campaign_id: '', field_data: [{ name: 'phone_number', values: ['0' + phn(98)] }] });
  r = M.matchLeads([org, none], {});
  assert.equal(r.leads.organic, 1); assert.deepEqual(r.camps[M.ORGANIC], { n: 'Lead tự nhiên (không từ quảng cáo)', p: 'OTHER' }); assert.deepEqual(r.camps[M.NONE], { n: 'Chưa rõ chiến dịch', p: 'OTHER' });
  const sum = M.summarize(r); assert.equal(sum.organic.l, 1); assert.equal(sum.total.l, 1);        // lead tự nhiên không nằm trong tổng của quảng cáo
});

test('matchLeads: các lead nối nhau bằng bất kỳ SĐT hay email chung là một phụ huynh (hai số trong một form; lead sau nối hai người đã lập); giữ lead sớm nhất', () => {
  const [a, b, c, d] = [111, 112, 113, 114].map(phn), mail = 'chung1@example.com';
  const two = (id, day, cid, phones, emails = []) => M.leadFromGraph({ id, created_time: at(day), campaign_id: cid, campaign_name: FORM, field_data: [...phones.map((p, i) => ({ name: i ? 'zalo' : 'phone_number', values: ['0' + p] })), ...emails.map(e => ({ name: 'email', values: [e] }))] });
  // form 1 ghi hai số (A, B); form 2 chỉ ghi B; form 3 ghi C; form 4 ghi C và email; form 5 ghi A và email → nối nhóm {A,B} với nhóm {C,email}
  let r = M.matchLeads([two('1', '2026-10-01', '111111', [a, b]), two('2', '2026-10-02', '222222', [b]), two('3', '2026-10-03', '333333', [c]), two('4', '2026-10-04', '444444', [c], [mail])], {});
  assert.equal(r.leads.parents, 2); assert.deepEqual(Object.keys(r.days), ['2026-10-01', '2026-10-03']);
  r = M.matchLeads([two('1', '2026-10-01', '111111', [a, b]), two('2', '2026-10-02', '222222', [b]), two('3', '2026-10-03', '333333', [c]), two('4', '2026-10-04', '444444', [c], [mail]), two('5', '2026-10-05', '555555', [a], [mail])], {});
  assert.equal(r.leads.parents, 1); assert.deepEqual(Object.keys(r.days), ['2026-10-01']); assert.deepEqual(cellOf(r, '2026-10-01', '111111'), [1, 0, 0, 0, 0, 0, 0]);
  // phụ huynh sau khi nối khớp học sinh qua số của bất kỳ lead nào trong nhóm
  const S = { 1: st('TS6', { paid: true, ph: [c], rd: '2026-10-06', pd: '2026-10-09' }) };
  r = M.matchLeads([two('1', '2026-10-01', '111111', [a, b]), two('3', '2026-10-03', '333333', [c]), two('5', '2026-10-05', '555555', [a, c])], S);
  assert.equal(r.leads.parents, 1); assert.deepEqual(cellOf(r, '2026-10-01', '111111'), [1, 0, 0, 1, 1, 1, 1]);
  assert.equal(M.matchLeads([two('1', '2026-10-01', '111111', [d])], {}).leads.parents, 1);
});

test('matchLeads: kết quả không chứa SĐT, email, tên; chỉ số nguyên và mã chiến dịch', () => {
  const k = phn(61), mail = 'riengtu61@example.com', S = { 1: st('TS6', { paid: true, ph: [k], em: [mail], rd: '2026-10-05', pd: '2026-10-09' }) };
  const l = M.leadFromGraph({ id: 'x1', created_time: at('2026-10-01'), campaign_id: '111111', campaign_name: FORM, field_data: [{ name: 'full_name', values: ['Trần Thị Bích'] }, { name: 'phone_number', values: ['0' + k] }, { name: 'email', values: [mail] }] });
  const json = JSON.stringify(M.matchLeads([l], S));
  for (const s of [k, mail, 'Trần', 'Bích', 'riengtu61']) assert.ok(!json.includes(s), s);
  assert.ok(!JSON.stringify(M.mergeMatch(null, M.matchLeads([l], S), '2026-08-01')).includes(k));
});

test('mergeMatch: ngày trong cửa sổ lấy theo lần mới, ngày cũ giữ theo lần trước; chiến dịch và mốc đầu được gộp; mùa khác không gộp', () => {
  const k = phn(71), S = { 1: st('TS6', { paid: true, ph: [k], rd: '2026-09-30', pd: '2026-10-09' }) };
  const prev = M.mergeMatch(null, Object.assign(M.matchLeads([lead('o1', at('2026-08-25'), '111111', FORM, '0' + phn(72)), lead('o2', at('2026-10-01'), '111111', FORM, '0' + k)], S), { season: '2027–28' }), '2026-08-01');
  const next = Object.assign(M.matchLeads([lead('n1', at('2026-10-01'), '222222', 'TS6 remarketing', '0' + k), lead('n2', at('2026-10-02'), '222222', 'TS6 remarketing', '0' + phn(73))], S), { season: '2027–28' });
  const wf = '2026-09-01';
  const m = M.mergeMatch(prev, next, wf);
  assert.deepEqual(Object.keys(m.days).sort(), ['2026-08-25', '2026-10-01', '2026-10-02']);          // 25/08 giữ từ lần trước; 01/10 thay bằng lần mới (chiến dịch 222222 thay 111111)
  assert.deepEqual(Object.keys(m.days['2026-10-01']), ['222222']);
  assert.equal(m.winFrom, '2026-08-25'); assert.equal(m.frozenBefore, wf); assert.equal(m.from, '2026-08-25'); assert.equal(m.to, '2026-10-02'); assert.equal(m.season, '2027–28');
  assert.ok(m.camps['111111'] && m.camps['222222']);                                              // chiến dịch cũ còn vì ngày 25/08 vẫn dùng
  assert.deepEqual(m.leads, next.leads); assert.deepEqual(m.cov, next.cov);                       // thống kê chung lấy theo lần mới nhất
  assert.ok(M.validate(m).ok, M.validate(m).error);
  assert.deepEqual(Object.keys(M.mergeMatch(null, next, wf).days).sort(), ['2026-10-01', '2026-10-02']);   // lần đầu: không có lần trước
  assert.equal(M.windowFrom('2026-11-21'), A.addDays('2026-11-21', -M.KEEP_DAYS));
});

test('validate: nhận kết quả hợp lệ, bỏ trường lạ, từ chối số sai dạng, ô không nhất quán, chiến dịch/chương trình lạ; không bao giờ ném lỗi', () => {
  const k = phn(81), S = { 1: st('TS6', { paid: true, ph: [k], rd: '2026-10-05', pd: '2026-10-09' }) };
  const good = Object.assign(M.matchLeads([lead('g1', at('2026-10-01'), '111111', FORM, '0' + k)], S), { season: '2027–28', secret: '0' + k, extra: { x: 1 } });
  const v = M.validate(good); assert.ok(v.ok); assert.equal(v.match.secret, undefined); assert.equal(v.match.extra, undefined); assert.equal(v.match.season, '2027–28');
  const clone = () => JSON.parse(JSON.stringify(good));
  const breaks = {
    'phiên bản': m => { m.v = 2; }, 'số lẻ': m => { m.days['2026-10-01']['111111'][0] = 1.5; }, 'số âm': m => { m.days['2026-10-01']['111111'][0] = -1; },
    'chuỗi': m => { m.days['2026-10-01']['111111'][0] = '1'; }, 'thiếu phần tử': m => { m.days['2026-10-01']['111111'].pop(); },
    'i+b+r > l': m => { m.days['2026-10-01']['111111'] = [1, 1, 0, 1, 0, 1, 0]; }, 'p > r': m => { m.days['2026-10-01']['111111'] = [2, 0, 0, 1, 2, 2, 2]; },
    'ps > rs': m => { m.days['2026-10-01']['111111'] = [1, 0, 0, 1, 1, 1, 2]; }, 'rs > 6r': m => { m.days['2026-10-01']['111111'] = [1, 0, 0, 1, 0, 7, 0]; }, 'ps > 6p': m => { m.days['2026-10-01']['111111'] = [1, 0, 0, 1, 1, 7, 7]; },
    'ngày giả': m => { m.days['2026-02-31'] = m.days['2026-10-01']; }, 'chiến dịch lạ': m => { m.days['2026-10-01']['abc'] = [1, 0, 0, 0, 0, 0, 0]; },
    'chiến dịch chưa khai': m => { delete m.camps['111111']; }, 'chương trình lạ': m => { m.camps['111111'].p = 'x<script>'; },
    'khoá chương trình lạ': m => { m.unmatchedPaid['tên dài có dấu cách'] = 1; }, 'độ phủ': m => { m.cov.withPhone = m.cov.students + 1; },
    'paidByProg': m => { m.cov.paidByProg.TS6 = [1, 2]; }, 'quá nhiều chiến dịch': m => { for (let i = 0; i < 301; i++) m.camps[String(100000 + i)] = { n: '', p: 'TS6' }; }
  };
  for (const [name, f] of Object.entries(breaks)) { const m = clone(); f(m); const r = M.validate(m); assert.equal(r.ok, false, name); assert.equal(typeof r.error, 'string', name); }
  for (const junk of [null, undefined, 5, 'x', [], { v: 1, days: 5 }, { v: 1, days: { '2026-10-01': 5 } }, { v: 1, camps: 5 }, { v: 1, leads: 5, cov: 'x', days: {}, camps: {} }]) assert.doesNotThrow(() => M.validate(junk));
  const cleaned = clone(); cleaned.camps['111111'].n = 'TS6 <img src=x onerror=1> | Form'; assert.equal(M.validate(cleaned).match.camps['111111'].n, 'TS6 img src x onerror 1 | Form');
});

test('summarize và rates: cộng theo khoảng ngày, chương trình của chiến dịch, tháng; tỷ lệ chỉ hiện khi đủ mẫu', () => {
  const m = { v: 1, camps: { 111111: { n: 'a', p: 'TS6' }, 222222: { n: 'b', p: 'TS10' }, organic: { n: 'org', p: 'OTHER' } }, days: {
    '2026-09-30': { 111111: [10, 1, 1, 6, 3, 7, 4] }, '2026-10-01': { 111111: [20, 0, 0, 10, 5, 11, 6], 222222: [5, 0, 0, 1, 0, 1, 0], organic: [7, 0, 0, 2, 1, 2, 1] }, '2026-10-02': { 222222: [30, 2, 3, 12, 6, 13, 7] } } };
  const s = M.summarize(m);
  assert.deepEqual(s.total, { l: 65, i: 3, b: 4, r: 29, p: 14, rs: 32, ps: 17 }); assert.deepEqual(s.organic, { l: 7, i: 0, b: 0, r: 2, p: 1, rs: 2, ps: 1 });
  assert.deepEqual(s.programs.TS6, { l: 30, i: 1, b: 1, r: 16, p: 8, rs: 18, ps: 10 }); assert.deepEqual(Object.keys(s.months).sort(), ['2026-09', '2026-10']);
  assert.equal(s.campaigns['222222'].prog, 'TS10'); assert.equal(s.campaigns['222222'].l, 35); assert.equal(s.days, 3);
  const w = M.summarize(m, '2026-10-01', '2026-10-01'); assert.equal(w.total.l, 25); assert.equal(w.days, 1); assert.equal(w.organic.l, 7);
  assert.equal(M.summarize(null).total.l, 0); assert.equal(M.summarize({}, '2026-10-01').days, 0);
  const rt = M.rates(s.total); assert.equal(rt.base, 58); assert.ok(Math.abs(rt.leadToReg - 29 / 58) < 1e-9); assert.ok(Math.abs(rt.leadToPaid - 14 / 58) < 1e-9); assert.ok(Math.abs(rt.regToPaid - 14 / 29) < 1e-9);
  const small = M.rates({ l: 9, i: 0, b: 0, r: 9, p: 5, rs: 9, ps: 5 }); assert.equal(small.leadToPaid, null); assert.equal(small.regToPaid, null);   // dưới 10: không tính phần trăm
  assert.equal(M.rates({ l: 100, i: 0, b: 0, r: 5, p: 2, rs: 5, ps: 2 }).regToPaid, null);
  assert.equal(M.rates({ l: 100, i: 0, b: 0, r: 5, p: 2, rs: 5, ps: 2 }).leadToPaid, 0.02);
});

test('từ file đến kết quả: aggregate({collect:true}) rồi matchLeads; phụ huynh ghi SĐT ở tab ĐP; phủ SĐT thấp được phản ánh', () => {
  const [a, b, c] = [91, 92, 93].map(phn);
  const hdr = ['MDT', 'HS nội bộ', 'Họ tên học sinh', 'Khối 27 28', 'Chiến dịch', 'SĐT bố', 'SĐT mẹ', 'Ngày đăng ký', 'Ngày đóng phí'];
  const reg = [[], hdr,
    [1, null, 'A', 'Khối 6', 'TS6', '0' + a, null, '2026-10-05', '2026-10-12'], [2, null, 'B', 'Khối 6', 'TS6', null, Number(b), '2026-10-06', null],
    [3, 20000001, 'C', 'Khối 6', 'TS6', '0' + c, null, '2026-10-01', '2026-10-02'], [4, null, 'D', 'Khối 10', 'TS10', null, null, '2026-10-08', '2026-10-14'], [5, null, 'E', 'Khối 1', 'TS1', null, null, '2026-10-09', '2026-10-15']];
  const paid = [{ name: 'LỚP 6 2728 (ĐP)', rows: [[], ['MDT', 'HS nội bộ', 'Họ tên học sinh', 'SĐT ưu tiên'], [3], [1, null, 'A', null], [3, 20000001, 'C', null]] },
    { name: 'LỚP 10 2728 (ĐP)', rows: [[], ['MDT', 'HS nội bộ', 'Họ tên học sinh', 'SĐT ưu tiên'], [1], [4, null, 'D', '+84' + phn(94)]] }];
  const ag = A.aggregate({ reg, paid, collect: true, today: '2026-11-20' }); assert.ok(ag.ok, ag.error);
  const r = M.matchLeads([lead('1', at('2026-10-01'), '111111', FORM, '0' + a), lead('2', at('2026-10-02'), '111111', FORM, '0' + b), lead('3', at('2026-10-03'), '111111', FORM, '0' + c), lead('4', at('2026-10-04'), '333333', FORM10, '0' + phn(94))], ag.students);
  assert.deepEqual(r.leads, { rows: 4, parents: 4, noContact: 0, hubKeys: 0, organic: 0, dupFamily: 0, ambiguous: 0, matched: 3, internalOnly: 1, preRegistered: 0, crossProgram: 0 });
  const s = M.summarize(r); assert.deepEqual(s.total, { l: 4, i: 1, b: 0, r: 3, p: 2, rs: 3, ps: 2 });
  assert.deepEqual(r.paidNoPhone, { TS1: 1 }); assert.deepEqual(r.unmatchedPaid, {});                // em E đóng phí nhưng chưa có SĐT: chưa thể khớp lead
  assert.equal(r.cov.ext, 4); assert.equal(r.cov.paidExt, 3); assert.equal(r.cov.paidExtWithPhone, 2);
  const pc = M.phoneCoverage(r); assert.ok(Math.abs(pc.paid - 2 / 3) < 1e-9); assert.ok(Math.abs(pc.registered - 4 / 5) < 1e-9);
  assert.ok(M.validate(r).ok);
});

test('view: theo kỳ, chương trình của chiến dịch, chiến dịch, tháng; chi phí chỉ khi đủ học sinh; lead tự nhiên tách riêng', () => {
  const m = { v: 1, cov: { ext: 100, extWithPhone: 100, paidByProg: { TS6: [20, 20], TS10: [20, 20] } }, camps: { 111111: { n: 'TS6-LEAD | Form', p: 'TS6' }, 222222: { n: 'TS10-LEAD', p: 'TS10' }, 333333: { n: 'Thương hiệu', p: 'OTHER' }, organic: { n: 'tự nhiên', p: 'OTHER' } }, days: {
    '2026-09-30': { 111111: [10, 1, 1, 6, 3, 7, 4] }, '2026-10-01': { 111111: [20, 0, 0, 10, 5, 11, 6], 222222: [5, 0, 0, 1, 0, 1, 0], 333333: [4, 0, 0, 0, 0, 0, 0], organic: [7, 0, 0, 2, 1, 2, 1] }, '2026-10-02': { 222222: [30, 2, 3, 12, 6, 13, 7] } } };
  const sp = { byProgram: { TS6: 30000000, TS10: 20000000, JS: 0 }, byCampaign: { 111111: 30000000, 222222: 20000000 } };
  const v = M.view(m, '2026-10-01', '2026-10-31', sp);
  assert.deepEqual([v.total.l, v.total.i, v.total.b, v.total.r, v.total.p, v.total.rs, v.total.ps], [59, 2, 3, 23, 11, 25, 13]); assert.equal(v.organic.l, 7);
  assert.equal(v.spend, 50000000); assert.equal(v.total.spend, 50000000); assert.ok(Math.abs(v.total.costPerPaid - 50000000 / 13) < 1e-6); assert.ok(Math.abs(v.total.costPerReg - 50000000 / 25) < 1e-6);
  assert.deepEqual(v.programs.map(p => p.k), ['TS6', 'TS10', 'OTHER']); assert.equal(v.programs[0].label, 'Lớp 6'); assert.equal(v.programs[2].label, 'Chưa ghép chương trình');
  assert.equal(v.programs[0].l, 20); assert.equal(v.programs[0].costPerPaid, 30000000 / 6); assert.equal(v.programs[1].spend, 20000000); assert.equal(v.programs[2].costPerPaid, null);
  assert.deepEqual(v.campaigns.map(c => c.id), ['222222', '111111', '333333']); assert.equal(v.campaigns[0].costPerPaid, 20000000 / 7); assert.equal(v.campaigns[0].prog, 'TS10');
  assert.deepEqual(v.months.map(x => x.m), ['2026-10']); assert.equal(M.view(m, '', '', null).months.length, 2); assert.equal(M.view(m, '', '', null).total.costPerPaid, null);
  const few = M.view({ v: 1, cov: { ext: 50, extWithPhone: 50 }, camps: { 111111: { n: 'a', p: 'TS6' } }, days: { '2026-10-01': { 111111: [30, 0, 0, 5, 2, 5, 2] } } }, '', '', { byProgram: { TS6: 9000000 }, byCampaign: {} });
  assert.equal(few.total.costPerPaid, null); assert.equal(few.total.costPerReg, 9000000 / 5);            // dưới 3 học sinh đóng phí: không tính chi phí
  assert.equal(M.view(null, '', '', null).total.l, 0);
  // chi phí của dòng Tổng chỉ chia cho học sinh của các chương trình đã ghép (chiến dịch chưa ghép không có chi tiêu trong số chi tiêu đó)
  const un = { v: 1, cov: { ext: 50, extWithPhone: 50 }, camps: { 111111: { n: 'a', p: 'TS6' }, 333333: { n: 'Thương hiệu', p: 'OTHER' } }, days: { '2026-10-01': { 111111: [20, 0, 0, 10, 5, 10, 5], 333333: [10, 0, 0, 5, 5, 5, 5] } } };
  const vu = M.view(un, '', '', { byProgram: { TS6: 10000000 }, byCampaign: {} });
  assert.equal(vu.total.ps, 10); assert.equal(vu.mapped.ps, 5); assert.equal(vu.total.costPerPaid, 2000000); assert.equal(vu.unmapped.ps, 5); assert.equal(vu.total.costPerReg, 1000000);
});

test('maturity và attribution: nhóm lead mới chưa đủ thời gian; phần học sinh đóng phí khớp được với lead quảng cáo', () => {
  const m = { v: 1, lag: { reg: [40, 3, 9], paid: [30, 12, 30] }, cov: { students: 100, ext: 80, paidExt: 60, paidExtWithPhone: 54, withPhone: 90 }, camps: { 111111: { n: 'a', p: 'TS6' }, organic: { n: 'o', p: 'OTHER' } },
    days: { '2026-10-01': { 111111: [20, 0, 0, 10, 8, 11, 9], organic: [3, 0, 0, 1, 1, 1, 1] }, '2026-10-02': { 111111: [10, 0, 0, 5, 4, 5, 4] } }, unmatchedPaid: { TS6: 20 }, paidNoPhone: { TS6: 4, HB: 2 } };
  const mt = M.maturity(m, '2026-11-20'); assert.deepEqual([mt.known, mt.n, mt.p50, mt.p90, mt.days, mt.recentFrom, mt.regP50], [true, 30, 12, 30, 30, '2026-10-21', 3]);
  const young = M.maturity({ v: 1, lag: { reg: [2, 1, 1], paid: [4, 5, 6] } }, '2026-11-20'); assert.deepEqual([young.known, young.days, young.recentFrom], [false, 30, '2026-10-21']);
  assert.equal(M.maturity({ v: 1, lag: { reg: [0, 0, 0], paid: [12, 1, 2] } }, '2026-11-20').days, 7);   // tối thiểu 7 ngày
  const at = M.attribution(m);
  assert.equal(at.paidExt, 60); assert.equal(at.fromAds, 13); assert.equal(at.fromOrganic, 1); assert.equal(at.noPhone, 6); assert.equal(at.unmatched, 20);
  assert.ok(Math.abs(at.share - 13 / 60) < 1e-9); assert.ok(Math.abs(at.phoneShare - 0.9) < 1e-9);
  assert.equal(M.attribution(null).share, null);
});

test('packOf: gói cho phần Phân tích chỉ có số tổng hợp; 30 ngày gần nhất, 30 ngày trước và toàn bộ; không có tên, số điện thoại', () => {
  const day = d => A.addDays('2026-11-20', -d);
  const m = { v: 1, winFrom: day(80), lag: { reg: [20, 3, 9], paid: [15, 12, 30] }, cov: { students: 100, ext: 80, extWithPhone: 78, extWithRegDate: 80, paidExt: 60, paidExtWithPhone: 54, withPhone: 90 }, camps: { 111111: { n: 'TS6-LEAD | Form', p: 'TS6' } },
    days: { [day(5)]: { 111111: [40, 2, 3, 15, 8, 16, 9] }, [day(40)]: { 111111: [30, 0, 0, 12, 6, 12, 6] } }, unmatchedPaid: {}, paidNoPhone: { HB: 2 } };
  const calls = []; const p = M.packOf(m, '2026-11-20', (s, u) => { calls.push([s, u]); return { byProgram: { TS6: 10000000 }, byCampaign: { 111111: 10000000 } }; });
  assert.equal(p.last_30d.total.parents, 40); assert.equal(p.last_30d.total.students_paid, 9); assert.equal(p.prev_30d.total.parents, 30); assert.equal(p.all_time.total.parents, 70);
  assert.equal(p.last_30d.total.cost_per_paid_student_vnd, Math.round(10000000 / 9)); assert.equal(p.last_30d.by_program[0].program, 'TS6'); assert.equal(p.last_30d.top_campaigns[0].campaign, 'TS6-LEAD | Form');
  assert.deepEqual(calls[0], [day(30), day(1)]); assert.equal(p.attribution.paid_without_phone_in_sheet, 2); assert.equal(p.maturity.days_from_form_to_payment_median, 12); assert.equal(p.lead_history_from, day(80));
  assert.equal(p.last_30d.total.already_registered_before_form, 3); assert.equal(p.last_30d.total.only_internal_students, 2);
  assert.equal(M.packOf(m, '2026-11-20', null).all_time.total.spend_vnd, null); assert.equal(p.last_30d.total.students_paid_in_costed_programs, 9); assert.equal(M.packOf(m, '2026-11-20', null).all_time.total.students_paid_in_costed_programs, null);   // chưa có chi tiêu là null, không phải 0
});

test('view: thiếu SĐT thì không tính đăng ký; chương trình thiếu SĐT của học sinh đóng phí bị bỏ khỏi Tổng, tỷ lệ và chi phí (không hiện số 0 sai)', () => {
  const camps = { 111111: { n: 'TS6-LEAD', p: 'TS6' }, 222222: { n: 'HB-LEAD', p: 'HB' } };
  const days = { '2026-10-01': { 111111: [40, 0, 0, 20, 12, 20, 12], 222222: [30, 0, 0, 1, 1, 1, 1] } };
  const sp = { byProgram: { TS6: 10000000, HB: 6000000 }, byCampaign: { 111111: 10000000, 222222: 6000000 } };
  const mk = cov => ({ v: 1, camps, days, cov });
  // đủ SĐT ở mọi chương trình và ở học sinh chưa đóng phí
  let v = M.view(mk({ ext: 100, extWithPhone: 95, paidByProg: { TS6: [30, 30], HB: [20, 19] } }), '', '', sp);
  assert.equal(v.regOk, true); assert.deepEqual(v.lowPhone, {}); assert.equal(v.total.l, 70); assert.equal(v.spend, 16000000);
  assert.ok(Math.abs(v.total.leadToReg - 21 / 70) < 1e-9); assert.ok(Math.abs(v.total.costPerPaid - 16000000 / 13) < 1e-6); assert.ok(v.total.costPerReg != null);
  // học sinh chưa đóng phí chưa có SĐT (như Sheet hiện tại): chưa tính được đăng ký, nhưng đóng phí vẫn tính
  v = M.view(mk({ ext: 100, extWithPhone: 60, paidByProg: { TS6: [30, 30], HB: [20, 19] } }), '', '', sp);
  assert.equal(v.regOk, false);
  for (const row of [v.total, v.programs[0], v.programs[1], v.campaigns[0], v.months[0]]) { assert.equal(row.leadToReg, null); assert.equal(row.regToPaid, null); assert.equal(row.costPerReg, null); }
  assert.ok(v.total.leadToPaid != null && v.total.costPerPaid != null); assert.equal(v.total.p, 13);
  // HB: chỉ 5/20 học sinh đã đóng phí có SĐT → không tính tỷ lệ/chi phí của HB, và HB không nằm trong Tổng, theo tháng và chi tiêu của Tổng
  v = M.view(mk({ ext: 100, extWithPhone: 95, paidByProg: { TS6: [30, 30], HB: [20, 5] } }), '', '', sp);
  assert.deepEqual(v.lowPhone, { HB: [5, 20] }); const hb = v.programs.find(p => p.k === 'HB'), ts6 = v.programs.find(p => p.k === 'TS6');
  assert.equal(hb.lowPhone, true); assert.equal(hb.leadToPaid, null); assert.equal(hb.costPerPaid, null); assert.equal(hb.l, 30); assert.equal(ts6.lowPhone, undefined); assert.ok(ts6.leadToPaid != null);
  assert.equal(v.total.l, 40); assert.equal(v.total.p, 12); assert.equal(v.spend, 10000000); assert.equal(v.total.costPerPaid, 10000000 / 12); assert.equal(v.months[0].l, 40);
  assert.equal(v.campaigns.find(c => c.id === '222222').lowPhone, true); assert.equal(v.campaigns.find(c => c.id === '222222').costPerPaid, null);
  // dưới 5 học sinh đóng phí: mẫu quá nhỏ để kết luận thiếu SĐT
  v = M.view(mk({ ext: 100, extWithPhone: 95, paidByProg: { TS6: [30, 30], HB: [4, 0] } }), '', '', sp); assert.deepEqual(v.lowPhone, {}); assert.equal(v.total.l, 70);
  // tài liệu cũ không có độ phủ: coi là chưa đủ SĐT cho đăng ký, không ném lỗi
  assert.equal(M.view({ v: 1, camps, days }, '', '', sp).regOk, false);
  // summarize(skip) chỉ bỏ khỏi Tổng và theo tháng
  const s = M.summarize(mk({}), '', '', { HB: true }); assert.equal(s.total.l, 40); assert.equal(s.programs.HB.l, 30); assert.equal(s.campaigns['222222'].l, 30); assert.equal(s.months['2026-10'].l, 40);
});

test('attribution và packOf: độ phủ SĐT/ngày; số không đáng tin là null trong gói cho Claude', () => {
  const day = d => A.addDays('2026-11-20', -d), camps = { 111111: { n: 'TS6-LEAD', p: 'TS6' }, 222222: { n: 'HB-LEAD', p: 'HB' } };
  const m = { v: 1, winFrom: day(40), lag: { reg: [0, 0, 0], paid: [0, 0, 0] }, camps, days: { [day(10)]: { 111111: [40, 0, 0, 20, 12, 20, 12], 222222: [30, 0, 0, 1, 1, 1, 1] } },
    cov: { students: 200, withPhone: 120, ext: 100, extWithPhone: 60, extWithRegDate: 30, paidExt: 50, paidExtWithPhone: 25, paidByProg: { TS6: [30, 29], HB: [20, 0] } }, unmatchedPaid: {}, paidNoPhone: { HB: 20 } };
  const at = M.attribution(m); assert.equal(at.regPhoneShare, 0.6); assert.equal(at.regDateShare, 0.3); assert.equal(at.phoneShare, 0.5);
  assert.equal(M.attribution({ v: 1, cov: {} }).regPhoneShare, null);
  const p = M.packOf(m, '2026-11-20', null);
  assert.equal(p.data_quality.registration_stage_reliable, false); assert.deepEqual(p.data_quality.programs_without_paid_phone, ['HB']); assert.equal(p.data_quality.phone_share_of_external_registered, 0.6); assert.equal(p.data_quality.registration_date_share, 0.3);
  const t = p.all_time.total; assert.equal(t.registered, null); assert.equal(t.students_registered, null); assert.equal(t.parent_to_registered, null); assert.equal(t.registered_to_paid, null); assert.equal(t.parents, 40); assert.equal(t.paid, 12);
  const hb = p.all_time.by_program.find(x => x.program === 'HB'); assert.equal(hb.paid, null); assert.equal(hb.students_paid, null); assert.equal(hb.parent_to_paid, null); assert.equal(hb.parents, 30);
  assert.ok(/registration_stage_reliable/.test(p.data_quality.note));
  // độ mới của số liệu cho Claude: ngày cập nhật (giờ Việt Nam), số ngày, kết quả lần chạy gần nhất; tên bước lạ bị bỏ
  assert.deepEqual([p.data_freshness.synced_at, p.data_freshness.age_days, p.data_freshness.last_update_ok, p.data_freshness.last_update_stage], [null, null, null, null]);
  const m2 = Object.assign({}, m, { syncedAt: '2026-11-17T17:30:00.000Z' });                                  // 00:30 ngày 18/11 giờ Việt Nam
  const f1 = M.packOf(m2, '2026-11-20', null, { leadsync: { ok: false, stage: 'sheet', error: 'chi tiết' } }).data_freshness; assert.deepEqual([f1.synced_at, f1.age_days, f1.last_update_ok, f1.last_update_stage], ['2026-11-18', 2, false, 'sheet']); assert.ok(!JSON.stringify(f1).includes('chi tiết') && /age_days >= 2/.test(f1.note));
  const f2 = M.packOf(m2, '2026-11-20', null, { leadsync: { ok: false, stage: '<script>x' } }).data_freshness; assert.equal(f2.last_update_stage, null);
  const f3 = M.packOf(m2, '2026-11-20', null, { leadsync: { ok: true, stage: null } }).data_freshness; assert.deepEqual([f3.last_update_ok, f3.last_update_stage], [true, null]);
});

test('packOf: cửa sổ được cắt theo khoảng lead đọc được (winFrom), chi tiêu cũ hơn không được cộng', () => {
  const camps = { 111111: { n: 'TS6-LEAD', p: 'TS6' } }, asked = [];
  const m = { v: 1, winFrom: '2026-11-01', camps, days: { '2026-11-05': { 111111: [40, 0, 0, 20, 12, 20, 12] } }, lag: { reg: [0, 0, 0], paid: [0, 0, 0] }, cov: { students: 100, withPhone: 100, ext: 100, extWithPhone: 100, extWithRegDate: 100, paidExt: 50, paidExtWithPhone: 50, paidByProg: { TS6: [50, 50] } }, unmatchedPaid: {}, paidNoPhone: {} };
  const spendOf = (since, until) => { asked.push([since, until]); return { byProgram: { TS6: 1000000 }, byCampaign: { 111111: 1000000 } }; };
  const p = M.packOf(m, '2026-11-20', spendOf);
  assert.deepEqual(asked, [['2026-11-01', '2026-11-19']]);              // last_30d bắt đầu 21/10 < winFrom nên cắt về 01/11; prev_30d kết thúc trước winFrom nên không tra chi tiêu
  assert.equal(p.last_30d.from, '2026-11-01'); assert.equal(p.last_30d.total.parents, 40); assert.equal(p.last_30d.total.spend_vnd, 1000000);
  assert.deepEqual([p.prev_30d.from, p.prev_30d.to, p.prev_30d.total.parents, p.prev_30d.total.spend_vnd], [null, null, 0, null]); assert.equal(p.all_time.from, '');
});

test('mergeMatch: số đã chốt cũ hơn một mùa (400 ngày) bị bỏ cùng chiến dịch không còn ngày nào; số trong hạn giữ nguyên', () => {
  const wf = M.windowFrom('2026-11-20'), oldest = A.addDays(wf, -340);
  const cell = n => [n, 0, 0, 0, 0, 0, 0], camps = { 111111: { n: 'A', p: 'TS6' }, 222222: { n: 'B', p: 'TS6' }, 333333: { n: 'C', p: 'TS1' } };
  const prev = { v: 1, season: '2027–28', winFrom: '2026-08-23', camps, days: { [A.addDays(oldest, -1)]: { 111111: cell(1) }, [oldest]: { 222222: cell(2) } } };
  const next = { season: '2027–28', leads: {}, cov: {}, lag: {}, unmatchedPaid: {}, paidNoPhone: {}, days: {}, camps: {}, winFrom: '2026-08-23' };
  const out = M.mergeMatch(prev, next, wf);
  assert.deepEqual(Object.keys(out.days), [oldest]); assert.deepEqual(Object.keys(out.camps), ['222222']); assert.equal(out.from, oldest);
});

test('validate: extWithPhone được giữ lại và không vượt số học sinh ngoài nội bộ', () => {
  const k = phn(5), S = { 1: st('TS6', { paid: true, ph: [k], rd: '2026-10-05', pd: '2026-10-09' }), 2: st('TS6') };
  const r = M.matchLeads([lead('x1', at('2026-10-01'), '111111', FORM, '0' + k)], S); assert.equal(r.cov.extWithPhone, 1); assert.equal(M.validate(r).match.cov.extWithPhone, 1);
  const bad = JSON.parse(JSON.stringify(r)); bad.cov.extWithPhone = bad.cov.ext + 1; assert.equal(M.validate(bad).ok, false);
});

test('khoá "trung tâm": email/SĐT đi cùng từ 4 khoá khác trở lên (chữ giữ chỗ, số dùng chung) không nối các gia đình không liên quan; gia đình thật có nhiều số/email vẫn là một phụ huynh', () => {
  const hubMail = 'thongtin.chung@example.com';
  const mk = (id, day, phone, mail) => M.leadFromGraph({ id, created_time: at(day), campaign_id: '111111', campaign_name: FORM, field_data: [{ name: 'phone_number', values: ['0' + phone] }, ...(mail ? [{ name: 'email', values: [mail] }] : [])] });
  const S = {}; const leads = [];
  for (let i = 0; i < 40; i++) { const k = phn(300 + i); S[i + 1] = st('TS6', { paid: true, ph: [k], rd: '2026-10-20', pd: '2026-10-25' }); leads.push(mk('h' + i, '2026-10-' + String(1 + (i % 9)).padStart(2, '0'), k, i < 10 ? hubMail : '')); }
  let r = M.matchLeads(leads, S); let s = M.summarize(r).total;
  assert.deepEqual([s.l, s.r, s.p, s.ps], [40, 40, 40, 40]); assert.equal(r.leads.parents, 40); assert.equal(r.leads.ambiguous, 0); assert.equal(r.leads.hubKeys, 1);           // 10 người cùng gõ một email không bị gộp làm một
  // ba người dùng chung một email vẫn dưới ngưỡng: coi là một phụ huynh (giới hạn đã biết); bốn người trở lên thì bị bỏ khỏi việc nối
  r = M.matchLeads(leads.slice(0, 3).map((l, i) => mk('t' + i, '2026-10-01', phn(300 + i), hubMail)), S); assert.equal(r.leads.parents, 1);
  r = M.matchLeads(leads.slice(0, 4).map((l, i) => mk('t' + i, '2026-10-01', phn(300 + i), hubMail)), S); assert.equal(r.leads.parents, 4);
  // gia đình thật: bố, mẹ và một email chung qua ba lead vẫn là một phụ huynh
  const [f1, m1] = [phn(400), phn(401)], fam = [mk('f1', '2026-10-01', f1, 'gia.dinh@example.com'), mk('f2', '2026-10-02', m1, 'gia.dinh@example.com'), mk('f3', '2026-10-03', f1, '')];
  assert.equal(M.matchLeads(fam, {}).leads.parents, 1); assert.equal(M.matchLeads(fam, {}).leads.hubKeys, 0);
  // lead chỉ có khoá trung tâm: không xác định được người, tính là không có liên hệ hợp lệ
  const onlyHub = M.matchLeads([...leads.slice(0, 5).map((l, i) => mk('x' + i, '2026-10-01', phn(500 + i), hubMail)), M.leadFromGraph({ id: 'only', created_time: at('2026-10-02'), campaign_id: '111111', campaign_name: FORM, field_data: [{ name: 'email', values: [hubMail] }] })], {});
  assert.ok(onlyHub.leads.noContact >= 1); assert.equal(onlyHub.leads.parents, 5);
});

test('địa chỉ email và số điện thoại giả/giữ chỗ không xác định được người: abc@…, test@…, 9 chữ số liền tăng hoặc giảm', () => {
  for (const e of ['abc@example.com', 'ABC@example.com', 'test@example.com', 'a@example.com', 'none@example.com', 'khongco@example.com', 'email@example.com']) assert.equal(A.emailKey(e), '', e);
  assert.equal(A.emailKey('ten.that@example.com'), 'ten.that@example.com'); assert.equal(A.emailKey('abc.def@example.com'), 'abc.def@example.com');
  const run = (a, n, dir) => Array.from({ length: n }, (_, i) => (a + dir * i + 10) % 10).join('');
  const fakes = ['9' + run(1, 8, 1), '9' + run(8, 8, -1), '90' + run(1, 7, 1)];                 // 9 + 12345678, 9 + 87654321, 90 + 1234567: dựng lúc chạy, không viết liền trong mã nguồn
  for (const k of fakes) { assert.equal(A.phoneKey('0' + k), '', k); assert.equal(A.phoneKey('+84' + k), '', k); assert.deepEqual(M.leadFromGraph({ id: 'f', created_time: at('2026-10-01'), field_data: [{ name: 'phone_number', values: ['0' + k] }] }).ph, []); }
  assert.equal(A.phoneKey('0' + phn(7)), phn(7));                                                // số thật không bị ảnh hưởng
});

test('chương trình của chiến dịch tính từ tên nguyên văn (cùng cách ghép với chi tiêu): gạch ngang dài, khoảng trắng không ngắt, dấu chấm tròn không làm mất chương trình', () => {
  const names = { '120200000000001': 'Lead–TS10 remarketing', '120200000000002': 'Form TS6 học bổng', '120200000000003': 'Form•HB27', '120200000000004': 'Tuyển sinh JS26 | Lạnh' };
  const want = { '120200000000001': 'TS10', '120200000000002': 'TS6', '120200000000003': 'HB', '120200000000004': 'JS' };
  const leads = Object.entries(names).map(([cid, n], i) => M.leadFromGraph({ id: 'p' + i, created_time: at('2026-10-0' + (i + 1)), campaign_id: cid, campaign_name: n, field_data: [{ name: 'phone_number', values: ['0' + phn(600 + i)] }] }));
  const r = M.matchLeads(leads, {});
  for (const [cid, p] of Object.entries(want)) { assert.equal(A.programOf(names[cid]), p, names[cid]); assert.equal(r.camps[cid].p, p, cid); assert.ok(!/[–• ]/.test(r.camps[cid].n), 'tên lưu không còn ký tự lạ: ' + r.camps[cid].n); }
  assert.equal(r.camps['120200000000001'].n, 'Lead TS10 remarketing');
  assert.equal(M.leadFromGraph({ id: 'z', created_time: at('2026-10-01'), campaign_id: '1'.repeat(21), campaign_name: FORM, field_data: [] }).cid, M.NONE);   // mã chiến dịch dài quá 20 chữ số
});

test('maturity: nhóm bị chốt sau 60 ngày nên khi phân vị 90 đã gần mốc đó, số ngày đo được bị cắt (binding); mẫu dưới 10 thì chưa biết', () => {
  assert.equal(M.KEEP_DAYS, 60);
  const mt = lag => M.maturity({ v: 1, lag: { reg: [0, 0, 0], paid: lag } }, '2026-11-20');
  assert.deepEqual([mt([30, 20, 30]).binding, mt([30, 40, 47]).binding, mt([30, 40, 48]).binding, mt([30, 50, 60]).binding, mt([5, 50, 60]).binding], [false, false, true, true, false]);
  assert.equal(mt([30, 20, 30]).closeAfter, 60);
});

test('mô phỏng nhiều ngày (cửa sổ 91 ngày của Meta + mergeMatch thật): phụ huynh điền form hai lần cách nhau 10 ngày vẫn là MỘT phụ huynh và MỘT học sinh; hai lần cách nhau hơn 30 ngày còn bị tính hai lần (giới hạn đã biết)', () => {
  const k = phn(701), D0 = '2026-03-01';
  const simulate = gap => {
    const mkLead = (id, day, cid) => ({ id, day, cid, raw: M.leadFromGraph({ id, created_time: at(day), campaign_id: cid, campaign_name: 'TS6-LEAD | ' + id, field_data: [{ name: 'phone_number', values: ['0' + k] }] }) });
    const leads = [mkLead('a', D0, '111111'), mkLead('b', A.addDays(D0, gap), '222222')], rd = A.addDays(D0, 30), pd = A.addDays(D0, 40);
    let prev = null;
    for (let i = 0; i <= 160; i++) {
      const today = A.addDays(D0, i), S = today >= rd ? { 1: st('TS6', { paid: today >= pd, rd, pd: today >= pd ? pd : '', ph: [k] }) } : {};
      const visible = leads.filter(l => l.day >= A.addDays(today, -91)).map(l => l.raw);                  // Meta chỉ trả lead trong khoảng 91 ngày gần nhất
      const next = Object.assign(M.matchLeads(visible, S), { season: '2026–27' });
      const merged = M.mergeMatch(prev, next, M.windowFrom(today)); assert.ok(M.validate(merged).ok); prev = M.validate(merged).match;
    }
    return M.summarize(prev).total;
  };
  const near = simulate(10); assert.deepEqual([near.l, near.r, near.p, near.rs, near.ps], [1, 1, 1, 1, 1]);
  const far = simulate(40); assert.deepEqual([far.r, far.p, far.rs, far.ps], [1, 1, 1, 1], JSON.stringify(far)); assert.ok(far.l <= 2 && far.i + far.b === far.l - 1 || far.l === 1, JSON.stringify(far));  // lần đầu hết hạn 90 ngày khi lần sau còn trong cửa sổ: số phụ huynh có thể là 2 nhưng học sinh vẫn một lần (em đăng ký trước form sau nên bị xếp "đăng ký trước form", không vào mẫu số) — giới hạn đã ghi ở README
  const base = M.rates(far, 1); assert.equal(base.base, 1);
});

test('bắt các đột biến: loại học sinh đăng ký trước form theo rd (không chỉ pd), ranh giới đóng băng, nối phụ huynh giữ đủ khoá, thứ tự cùng giờ, phân vị 90, ngưỡng số dùng chung gồm cả học sinh nội bộ', () => {
  const [a, b, c] = [801, 802, 803].map(phn);
  // 1. đăng ký trước form nhưng chưa đóng phí (chỉ rd): vẫn bị loại khỏi form
  let r = M.matchLeads([lead('x', at('2026-10-01'), '111111', FORM, '0' + a)], { 1: st('TS6', { ph: [a], rd: '2026-09-20' }) });
  assert.deepEqual(cellOf(r, '2026-10-01', '111111'), [1, 0, 1, 0, 0, 0, 0]);
  // 2. gộp qua lead nối: phụ huynh bị gộp mang một khoá mà chỉ họ có → học sinh chỉ có khoá đó vẫn khớp
  const l1 = M.leadFromGraph({ id: '1', created_time: at('2026-10-01'), campaign_id: '111111', campaign_name: FORM, field_data: [{ name: 'phone_number', values: ['0' + a] }, { name: 'zalo', values: ['0' + b] }] });
  const l2 = lead('2', at('2026-10-02'), '222222', FORM, '0' + c), l3 = M.leadFromGraph({ id: '3', created_time: at('2026-10-03'), campaign_id: '333333', campaign_name: FORM, field_data: [{ name: 'phone_number', values: ['0' + a] }, { name: 'zalo', values: ['0' + c] }] });
  r = M.matchLeads([l1, l2, l3], { 1: st('TS6', { paid: true, ph: [c], rd: '2026-10-09', pd: '2026-10-12' }) });
  assert.equal(r.leads.parents, 1); assert.deepEqual(cellOf(r, '2026-10-01', '111111'), [1, 0, 0, 1, 1, 1, 1]);              // cả ba lead là một người; first touch là lead 1
  // 3. cùng một giờ: lead mã nhỏ hơn là first touch bất kể thứ tự đầu vào
  for (const order of [['m1', 'm2'], ['m2', 'm1']]) { const ls = order.map(id => lead(id, at('2026-10-01', 3), id === 'm1' ? '111111' : '222222', FORM, '0' + a)); const q = M.matchLeads(ls, {}); assert.deepEqual(Object.keys(q.days['2026-10-01']), ['111111'], order.join()); }
  // 4. mergeMatch: ngày đúng bằng mốc dùng số mới, ngày trước mốc giữ số cũ dù lần mới có số khác
  const mkm = (day, v) => ({ v: 1, season: '2027–28', leads: {}, cov: {}, lag: {}, days: { [day]: { 111111: v } }, camps: { 111111: { n: 'x', p: 'TS6' } }, unmatchedPaid: {}, paidNoPhone: {}, winFrom: day });
  const wf = '2026-09-01', prev = { v: 1, days: { '2026-08-31': { 111111: [5, 0, 0, 0, 0, 0, 0] }, [wf]: { 111111: [6, 0, 0, 0, 0, 0, 0] } }, camps: { 111111: { n: 'x', p: 'TS6' } }, winFrom: '2026-08-31' };
  const nx = { v: 1, season: '2027–28', leads: {}, cov: {}, lag: {}, days: { '2026-08-31': { 111111: [9, 0, 0, 0, 0, 0, 0] }, [wf]: { 111111: [7, 0, 0, 0, 0, 0, 0] } }, camps: { 111111: { n: 'x', p: 'TS6' } }, unmatchedPaid: {}, paidNoPhone: {}, winFrom: wf };
  const mm = M.mergeMatch(prev, nx, wf); assert.equal(mm.days['2026-08-31'][111111][0], 5); assert.equal(mm.days[wf][111111][0], 7);
  // 5. phân vị 90 và trung vị với 12 mẫu (1..12 ngày): [12, 6, 11]
  const S12 = {}, L12 = []; for (let i = 0; i < 12; i++) { const k = phn(900 + i); S12[i + 1] = st('TS6', { paid: true, ph: [k], rd: '2026-10-02', pd: A.addDays('2026-10-01', i + 1) }); L12.push(lead('q' + i, at('2026-10-01'), '111111', FORM, '0' + k)); }
  assert.deepEqual(M.matchLeads(L12, S12).lag.paid, [12, 6, 11]);
  // 6. số dùng chung: 7 học sinh (3 nội bộ + 4 ngoài) chung một số → chưa khớp (ngưỡng đếm cả học sinh nội bộ), không ai bị tính
  const shared = phn(950), S7 = {}; for (let i = 0; i < 7; i++) S7[i + 1] = st('TS6', { int: i < 3, paid: true, ph: [shared], rd: '2026-10-05', pd: '2026-10-06' });
  r = M.matchLeads([lead('s', at('2026-10-01'), '111111', FORM, '0' + shared)], S7); assert.deepEqual(cellOf(r, '2026-10-01', '111111'), [1, 0, 0, 0, 0, 0, 0]); assert.equal(r.leads.ambiguous, 1); assert.deepEqual(r.unmatchedPaid, { TS6: 4 });
  // 7. validate: ps lớn hơn rs; attribution không vượt tổng số đã đóng phí
  const bad = JSON.parse(JSON.stringify(Object.assign(M.matchLeads([lead('v', at('2026-10-01'), '111111', FORM, '0' + a)], { 1: st('TS6', { paid: true, ph: [a], rd: '2026-10-05', pd: '2026-10-06' }) }), { season: '2027–28' })));
  bad.days['2026-10-01']['111111'] = [1, 0, 0, 1, 1, 1, 2]; assert.equal(M.validate(bad).ok, false);
  bad.days['2026-10-01']['111111'] = [2, 0, 0, 2, 2, 1, 1]; assert.equal(M.validate(bad).ok, true);                 // bố và mẹ cùng điền form cho một em: r, p lớn hơn rs, ps là hợp lệ
  assert.equal(M.attribution({ v: 1, cov: { paidExt: 5 }, days: { '2026-10-01': { 111111: [9, 0, 0, 9, 9, 9, 9] } } }).fromAds, 5);
});

test('khoá phụ huynh không phụ thuộc thứ tự đầu vào khi có lead cùng giờ và lead hai khoá', () => {
  const ks = Array.from({ length: 12 }, (_, i) => phn(1000 + i)), S = {};
  ks.forEach((k, i) => { S[i + 1] = st(['TS6', 'TS10'][i % 2], { paid: i % 3 === 0, ph: [k], rd: '2026-10-09' }); });
  const mk = (id, a, b) => M.leadFromGraph({ id, created_time: at('2026-10-01', 3), campaign_id: String(100000 + (id.charCodeAt(0) % 3)), campaign_name: 'TS6 ' + id, field_data: [{ name: 'phone_number', values: ['0' + a] }, ...(b ? [{ name: 'zalo', values: ['0' + b] }] : [])] });
  const leads = []; for (let i = 0; i < 12; i++) leads.push(mk('l' + String.fromCharCode(97 + i), ks[i], i % 2 ? ks[(i + 3) % 12] : ''));
  const base = JSON.stringify(M.matchLeads(leads, S)); let seed = 3; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let t = 0; t < 20; t++) assert.equal(JSON.stringify(M.matchLeads(leads.slice().sort(() => rnd() - 0.5), S)), base);
});

test('mergeMatch: lần mới không tra được tên hay chương trình của chiến dịch thì không đè lên mục đã biết; tên mới hợp lệ thì thay', () => {
  const wf = M.windowFrom('2026-11-20');
  const prev = { v: 1, season: '2027–28', winFrom: '2026-08-23', camps: { 111111: { n: 'TS6-LEAD | Form', p: 'TS6' }, 222222: { n: 'TS10-LEAD', p: 'TS10' }, 333333: { n: '', p: 'OTHER' } }, days: { '2026-09-01': { 111111: [1, 0, 0, 0, 0, 0, 0], 222222: [1, 0, 0, 0, 0, 0, 0], 333333: [1, 0, 0, 0, 0, 0, 0] } } };
  const next = { season: '2027–28', leads: {}, cov: {}, lag: {}, unmatchedPaid: {}, paidNoPhone: {}, winFrom: '2026-08-23', days: {}, camps: { 111111: { n: '', p: 'OTHER' }, 222222: { n: 'TS10-LEAD (đổi tên)', p: 'TS10' }, 333333: { n: 'JS-LEAD', p: 'JS' } } };
  const c = M.mergeMatch(prev, next, wf).camps;
  assert.deepEqual(c[111111], { n: 'TS6-LEAD | Form', p: 'TS6' });          // lần mới mất tên: giữ mục cũ
  assert.deepEqual(c[222222], { n: 'TS10-LEAD (đổi tên)', p: 'TS10' });     // tên mới hợp lệ: thay
  assert.deepEqual(c[333333], { n: 'JS-LEAD', p: 'JS' });                   // mục cũ chưa biết: lấy mục mới
});

test('matchLeads: khoá dùng chung tính theo số NGƯỜI — một phụ huynh điền hai lần với Zalo/email khác nhau vẫn khớp bằng số chính; bốn người cùng một email bị bỏ; một lead nhiều khoá không thành khoá dùng chung', () => {
  const p1 = phn(81), z1 = phn(82), z2 = phn(83);
  const S = { 1: st('TS6', { paid: true, ph: [p1], rd: '2026-10-05', pd: '2026-10-09' }) };
  const mk = (id, day, phones, emails) => M.leadFromGraph({ id, created_time: at(day), campaign_id: '111111', campaign_name: FORM, field_data: [...phones.map(p => ({ name: 'phone_number', values: ['0' + p] })), ...emails.map(e => ({ name: 'email', values: [e] }))] });
  let r = M.matchLeads([mk('a', '2026-10-01', [p1, z1], ['me.a@example.com']), mk('b', '2026-10-08', [p1, z2], ['me.b@example.com'])], S);
  assert.equal(r.leads.parents, 1); assert.equal(r.leads.hubKeys, 0); assert.equal(r.leads.matched, 1); assert.deepEqual(r.unmatchedPaid, {});
  r = M.matchLeads([mk('c', '2026-10-01', [p1, phn(84), phn(85)], ['x1@example.com', 'x2@example.com'])], S); assert.equal(r.leads.hubKeys, 0); assert.equal(r.leads.matched, 1);
  const shared = 'cungemail@example.com', L4 = [91, 92, 93, 94].map((n, i) => mk('s' + i, '2026-10-0' + (1 + i), [phn(n)], [shared]));
  r = M.matchLeads(L4, {}); assert.equal(r.leads.parents, 4); assert.equal(r.leads.hubKeys, 1);
  r = M.matchLeads(L4.slice(0, 2), {}); assert.equal(r.leads.parents, 1); assert.equal(r.leads.hubKeys, 0);
});

test('leadFromGraph: mã chiến dịch ngắn hoặc không phải số là "none" (không làm hỏng validate); giá trị ngày giờ trong ô tự đặt tên không thành số điện thoại', () => {
  for (const cid of ['0', '1234', 'abc', '']) assert.equal(M.leadFromGraph({ id: 'x', created_time: at('2026-10-01'), campaign_id: cid, field_data: [] }).cid, M.NONE, JSON.stringify(cid));
  assert.equal(M.leadFromGraph({ id: 'x', created_time: at('2026-10-01'), campaign_id: '12345', field_data: [] }).cid, '12345');
  const base = { id: 'x', created_time: at('2026-10-01'), campaign_id: '123456' };
  assert.deepEqual(M.leadFromGraph(Object.assign({ field_data: [{ name: 'chon_lich', values: ['2021-08-12 07:29'] }, { name: 'khung_gio', values: ['2026-10-12T07:29:00+0700'] }] }, base)).ph, []);
  assert.deepEqual(M.leadFromGraph(Object.assign({ field_data: [{ name: 'tra_loi', values: ['p:+84' + phn(86)] }] }, base)).ph, [phn(86)]);
  const l = M.matchLeads([M.leadFromGraph(Object.assign({ campaign_id: '0', field_data: [{ name: 'phone_number', values: ['0' + phn(87)] }] }, { id: 'y', created_time: at('2026-10-01') }))], {});
  assert.ok(M.validate(Object.assign(l, { season: '2027–28' })).ok);                                          // một lead mã chiến dịch lạ không chặn cả lần cập nhật
});

test('view/packOf: chương trình thiếu SĐT của học sinh đã đóng phí ẩn cả số đăng ký và mọi tỷ lệ, chi phí; chỉ xét năm chương trình có chiến dịch (KHAC không làm hỏng cảnh báo chung)', () => {
  const camps = { 111111: { n: 'TS6-LEAD', p: 'TS6' }, 222222: { n: 'HB-LEAD', p: 'HB' } };
  const m = { v: 1, camps, days: { '2026-10-01': { 111111: [40, 0, 0, 20, 12, 20, 12], 222222: [60, 0, 0, 14, 4, 15, 5] } }, lag: { reg: [0, 0, 0], paid: [0, 0, 0] },
    cov: { students: 200, withPhone: 180, ext: 100, extWithPhone: 95, extWithRegDate: 100, paidExt: 60, paidExtWithPhone: 40, paidByProg: { TS6: [30, 30], HB: [20, 5], KHAC: [10, 2] } }, unmatchedPaid: {}, paidNoPhone: {} };
  const v = M.view(m, '', '', { byProgram: { TS6: 6000000, HB: 6000000 }, byCampaign: { 111111: 6000000, 222222: 6000000 } });
  assert.deepEqual(Object.keys(v.lowPhone), ['HB']);
  const hb = v.programs.find(p => p.k === 'HB'); for (const k of ['leadToReg', 'regToPaid', 'costPerReg', 'leadToPaid', 'costPerPaid']) assert.equal(hb[k], null, k); assert.equal(hb.lowPhone, true);
  const hbc = v.campaigns.find(c => c.id === '222222'); for (const k of ['leadToReg', 'regToPaid', 'costPerReg', 'leadToPaid', 'costPerPaid']) assert.equal(hbc[k], null, 'chiến dịch ' + k);
  const ts6 = v.programs.find(p => p.k === 'TS6'); for (const k of ['leadToReg', 'leadToPaid', 'costPerPaid', 'costPerReg']) assert.ok(ts6[k] != null, k);
  const p = M.packOf(m, '2026-10-20', () => ({ byProgram: { TS6: 6000000, HB: 6000000 }, byCampaign: {} })), pb = p.last_30d.by_program.find(x => x.program === 'HB');
  for (const k of ['registered', 'students_registered', 'parent_to_registered', 'registered_to_paid', 'paid', 'students_paid', 'parent_to_paid', 'cost_per_paid_student_vnd']) assert.equal(pb[k], null, k);
  assert.deepEqual(p.data_quality.programs_without_paid_phone, ['HB']);
});

test('coverageGain: chỉ khi một cổng độ phủ vừa mở (đủ SĐT, đủ ngày, chương trình hết thiếu SĐT); tụt hay không đổi thì không', () => {
  const base = { ext: 100, extWithPhone: 50, extWithRegDate: 0, paidExt: 50, paidExtWithPhone: 40, paidByProg: { TS6: [30, 30], HB: [20, 5] } };
  assert.equal(M.coverageGain(base, base), false);
  assert.equal(M.coverageGain(base, Object.assign({}, base, { extWithPhone: 95 })), true);
  assert.equal(M.coverageGain(base, Object.assign({}, base, { extWithRegDate: 95 })), true);
  assert.equal(M.coverageGain(base, Object.assign({}, base, { paidByProg: { TS6: [30, 30], HB: [20, 19] } })), true);
  assert.equal(M.coverageGain(Object.assign({}, base, { extWithPhone: 95 }), base), false);
  assert.equal(M.coverageGain(null, base), false); assert.equal(M.coverageGain(base, null), false);
});

test('matchLeads: gia đình hai phụ huynh cùng điền form — tỷ lệ Form → ĐP là của phụ huynh (không lệch thấp vì chỉ gia đình đóng phí mới bị gộp); học sinh và chi phí vẫn tính một lần', () => {
  // 100 gia đình, cùng tỷ lệ đóng phí 30% ở cả hai nhóm: 40 gia đình có cả bố lẫn mẹ điền form (12 đóng phí), 60 gia đình chỉ một phụ huynh (18 đóng phí). Tỷ lệ của phụ huynh phải đúng 30%; nếu chỉ gộp bố/mẹ của gia đình đã đóng phí thì tụt xuống 23%
  const S = {}, leads = []; let id = 1, pn = 100;
  for (let f = 0; f < 100; f++) {
    const two = f < 40, paid = two ? f < 12 : f - 40 < 18, a = phn(pn++), b = two ? phn(pn++) : null;
    S[id] = st('TS6', { paid, ph: b ? [a, b] : [a], rd: '2026-10-05', pd: paid ? '2026-10-09' : '' }); id++;
    leads.push(lead('a' + f, at('2026-10-01'), '111111', FORM, '0' + a)); if (b) leads.push(lead('b' + f, at('2026-10-02'), '111111', FORM, '0' + b));
  }
  const r = M.matchLeads(leads, S), c1 = cellOf(r, '2026-10-01', '111111'), c2 = cellOf(r, '2026-10-02', '111111');
  assert.equal(r.leads.dupFamily, 40);
  assert.equal(c1[0] + c2[0], 140); assert.equal(c1[4] + c2[4], 24 + 18);                            // 24 phụ huynh của 12 gia đình hai phụ huynh đóng phí + 18 gia đình một phụ huynh
  assert.equal(c1[6] + c2[6], 30); assert.equal(c1[5] + c2[5], 100);                                 // học sinh: mỗi em một lần (chi phí cho mỗi học sinh không bị nhân đôi)
  assert.ok(Math.abs((c1[4] + c2[4]) / (c1[0] + c2[0]) - 0.3) < 1e-9);
});

test('packOf + prompt: data_quality có low_coverage_before và paid_rows_not_linked_to_registration, và lời nhắc cho Claude nhắc tới cả hai', async () => {
  const m = { v: 1, winFrom: '2026-08-23', lowCovUntil: '2026-10-01', camps: { 111111: { n: 'TS6', p: 'TS6' } }, days: { '2026-11-05': { 111111: [10, 0, 0, 4, 2, 4, 2] } }, lag: { reg: [0, 0, 0], paid: [0, 0, 0] }, cov: { students: 10, ext: 10, extWithPhone: 10, extWithRegDate: 10, paidExt: 5, paidExtWithPhone: 5, unlinkedPaid: 3, paidByProg: {} }, unmatchedPaid: {}, paidNoPhone: {} };
  const p = M.packOf(m, '2026-11-20', null); assert.equal(p.data_quality.low_coverage_before, '2026-10-01'); assert.equal(p.data_quality.paid_rows_not_linked_to_registration, 3);
  assert.match(p.data_quality.note, /low_coverage_before/); assert.match(p.data_quality.note, /paid_rows_not_linked_to_registration/);
  const prompt = (await import('node:fs')).readFileSync(new URL('../server/insights-ai.js', import.meta.url), 'utf8'); assert.match(prompt, /low_coverage_before/); assert.match(prompt, /paid_rows_not_linked_to_registration/);
});
