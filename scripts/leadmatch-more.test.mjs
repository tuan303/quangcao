// Kiểm thử bổ sung cho lõi đối chiếu (leadmatch.js): các khẳng định bắt những đột biến mà bộ kiểm thử chính bỏ sót (ranh giới ngưỡng, thứ tự cùng ngày, nối phụ huynh, gộp lần mới/cũ, định dạng kiểm tra).
// Dữ liệu là số giả dựng lúc chạy.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../fbads-core.js';
import '../admissions.js';
import '../leadmatch.js';
const A = globalThis.FBAdm, M = globalThis.FBMatch;
const phn = n => '9' + String(10000000 + (n * 7919 + 12345) % 89999999);
const st = (p, o = {}) => Object.assign({ p, k: 'Khối 6', int: false, paid: false, rd: '', pd: '', ph: [], em: [] }, o);
const at = (day, hh = 3, mm = 0) => day + 'T' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':00+0000';
const raw = (id, t, cid, name, phones, extra = {}) => M.leadFromGraph(Object.assign({ id, created_time: t, campaign_id: cid, campaign_name: name, field_data: phones.map((p, i) => ({ name: i ? 'zalo' : 'phone_number', values: ['0' + p] })) }, extra));

test('K1: lowPhone hides costPerPaid even when >= 3 students and spend exist (program row and campaign row)', () => {
  const camps = { 111111: { n: 'HB-LEAD', p: 'HB' }, 222222: { n: 'TS6', p: 'TS6' } };
  const m = M.validate({ v: 1, camps, days: { '2026-10-01': { 111111: [60, 0, 0, 20, 12, 22, 14], 222222: [40, 0, 0, 10, 6, 10, 6] } }, cov: { ext: 100, extWithPhone: 100, paidByProg: { HB: [20, 5], TS6: [10, 10] } }, winFrom: '2026-10-01', unmatchedPaid: {}, paidNoPhone: {}, lag: {} }).match;
  const v = M.view(m, '', '', { byProgram: { HB: 7000000, TS6: 3000000 }, byCampaign: { 111111: 7000000, 222222: 3000000 } });
  const hb = v.programs.find(p => p.k === 'HB'); assert.equal(hb.lowPhone, true); assert.equal(hb.costPerPaid, null); assert.equal(v.campaigns.find(c => c.id === '111111').costPerPaid, null);
  assert.equal(v.total.costPerPaid, 3000000 / 6);     // the Total excludes HB spend and students
});
test('K2: first touch within the same day is decided by the time (at), not by lead id', () => {
  const k = phn(1);
  const early = raw('9', at('2026-10-01', 1), '111111', 'TS6 A', [k]), late = raw('1', at('2026-10-01', 5), '222222', 'TS6 B', [k]);   // later lead has the smaller id
  const r = M.matchLeads([late, early], {}); assert.deepEqual(Object.keys(r.days['2026-10-01']), ['111111']);
});
test('K3: bridge: keys of the absorbed parent that are not on the bridging lead still match students', () => {
  const [a, b, c, d] = [11, 12, 13, 14].map(phn);
  const L = [raw('1', at('2026-10-01'), '111111', 'TS6', [a, b]), raw('2', at('2026-10-02'), '111111', 'TS6', [c, d]), raw('3', at('2026-10-03'), '111111', 'TS6', [a, c])];   // lead 3 bridges {a,b} and {c,d}
  const r = M.matchLeads(L, { 1: st('TS6', { paid: true, ph: [d], rd: '2026-10-06', pd: '2026-10-09' }) });
  assert.equal(r.leads.parents, 1); assert.deepEqual(r.days['2026-10-01']['111111'], [1, 0, 0, 1, 1, 1, 1]);
  const L2 = [raw('1', at('2026-10-01'), '111111', 'TS6', [a, b]), raw('2', at('2026-10-02'), '111111', 'TS6', [c]), raw('3', at('2026-10-03'), '111111', 'TS6', [a, c])];
  const r2 = M.matchLeads(L2, { 1: st('TS6', { paid: true, ph: [b], rd: '2026-10-06', pd: '2026-10-09' }) }); assert.deepEqual(r2.days['2026-10-01']['111111'], [1, 0, 0, 1, 1, 1, 1]);
  const mail = 'only.here@example.com', withMail = (id, day, phones, emails) => M.leadFromGraph({ id, created_time: at(day), campaign_id: '111111', campaign_name: 'TS6', field_data: [...phones.map((p, i) => ({ name: i ? 'zalo' : 'phone_number', values: ['0' + p] })), ...emails.map(e => ({ name: 'email', values: [e] }))] });
  const r3 = M.matchLeads([withMail('1', '2026-10-01', [a], []), withMail('2', '2026-10-02', [c], [mail]), withMail('3', '2026-10-03', [a, c], [])], { 1: st('TS6', { paid: true, em: [mail], rd: '2026-10-06', pd: '2026-10-09' }) });
  assert.equal(r3.leads.parents, 1); assert.deepEqual(r3.days['2026-10-01']['111111'], [1, 0, 0, 1, 1, 1, 1]);   // e-mail only on the absorbed parent
});
test('K4: mergeMatch: campaign metadata and statistics come from the NEWER read', () => {
  const mk = (n, p, tag) => ({ v: 1, season: '2027–28', leads: { rows: tag }, cov: { students: tag }, lag: { reg: [tag, tag, tag], paid: [tag, tag, tag] }, unmatchedPaid: { TS6: tag }, paidNoPhone: { HB: tag }, days: { '2026-10-05': { 111111: [1, 0, 0, 0, 0, 0, 0] } }, camps: { 111111: { n, p } }, winFrom: '2026-10-05' });
  const prev = mk('old name', 'TS6', 1), next = mk('new name', 'TS10', 2);
  const m = M.mergeMatch(prev, next, '2026-09-01');
  assert.deepEqual(m.camps['111111'], { n: 'new name', p: 'TS10' }); assert.equal(m.leads.rows, 2); assert.equal(m.cov.students, 2); assert.deepEqual(m.lag.paid, [2, 2, 2]); assert.deepEqual(m.unmatchedPaid, { TS6: 2 });
  const old = { v: 1, days: { '2026-08-01': { 222222: [3, 0, 0, 0, 0, 0, 0] } }, camps: {}, winFrom: '2026-08-01' };      // prev day without a camps entry -> placeholder, not a crash/reject
  assert.ok(M.validate(M.mergeMatch(old, next, '2026-09-01')).ok);
});
test('K5: packOf: previous-30-day window is [today-60, today-31] and does not overlap the last 30 days', () => {
  const calls = []; M.packOf({ v: 1, camps: {}, days: {}, cov: {} }, '2026-11-20', (s, u) => { calls.push([s, u]); return null; });
  assert.deepEqual(calls, [['2026-10-21', '2026-11-19'], ['2026-09-21', '2026-10-20']]);
});
test('K6: thresholds at the boundary: 10 parents, 90% phones, 5 paid students, 3 students for cost', () => {
  assert.equal(M.rates({ l: 10, i: 0, b: 0, r: 5, p: 2, rs: 5, ps: 2 }).leadToPaid, 0.2); assert.equal(M.rates({ l: 10, i: 0, b: 0, r: 10, p: 5, rs: 10, ps: 5 }).regToPaid, 0.5);
  const camps = { 111111: { n: 'HB', p: 'HB' } }, days = { '2026-10-01': { 111111: [30, 0, 0, 12, 3, 12, 3] } };
  const mk = (cov) => M.validate({ v: 1, camps, days, cov, winFrom: '2026-10-01', unmatchedPaid: {}, paidNoPhone: {}, lag: {} }).match;
  assert.deepEqual(M.view(mk({ ext: 100, extWithPhone: 90, paidByProg: { HB: [10, 9] } }), '', '', null).lowPhone, {});      // exactly 90%: not low
  assert.deepEqual(M.view(mk({ ext: 100, extWithPhone: 90, paidByProg: { HB: [5, 4] } }), '', '', null).lowPhone, { HB: [4, 5] });   // 5 paid students and 80%: low
  assert.equal(M.view(mk({ ext: 100, extWithPhone: 90, paidByProg: {} }), '', '', null).regOk, true);                          // exactly 90%: reliable
  const vv = M.view(mk({ ext: 100, extWithPhone: 100, paidByProg: {} }), '', '', { byProgram: { HB: 9000000 }, byCampaign: { 111111: 9000000 } });
  assert.equal(vv.total.costPerPaid, 3000000); assert.equal(vv.programs.find(p => p.k === 'HB').costPerPaid, 3000000); assert.equal(vv.campaigns[0].costPerPaid, 3000000); assert.equal(vv.programs.find(p => p.k === 'HB').costPerReg, 750000);   // exactly 3 paid students
  assert.equal(M.maturity({ v: 1, lag: { reg: [0, 0, 0], paid: [10, 5, 9] } }, '2026-11-20').known, true);                     // exactly 10 samples
});
test('K7: validate: campaign key format, caps on days and cells, paidExt <= ext', () => {
  const base = () => ({ v: 1, season: '2027–28', camps: { 111111: { n: 'a', p: 'TS6' } }, days: { '2026-10-01': { 111111: [1, 0, 0, 0, 0, 0, 0] } }, cov: {}, unmatchedPaid: {}, paidNoPhone: {}, lag: {} });
  let m = base(); m.camps['<img src=x>'] = { n: '', p: 'TS6' }; assert.equal(M.validate(m).ok, false);
  m = base(); m.camps['1234'] = { n: '', p: 'TS6' }; assert.equal(M.validate(m).ok, false);
  m = base(); m.days = {}; for (let i = 0; i < 801; i++) m.days[A.addDays('2026-01-01', i)] = { 111111: [1, 0, 0, 0, 0, 0, 0] }; assert.equal(M.validate(m).ok, false);
  m = base(); m.camps = {}; m.days = {}; for (let c = 0; c < 300; c++) m.camps[String(100000 + c)] = { n: '', p: 'TS6' }; for (let i = 0; i < 28; i++) { m.days[A.addDays('2026-01-01', i)] = {}; for (let c = 0; c < 300; c++) m.days[A.addDays('2026-01-01', i)][String(100000 + c)] = [1, 0, 0, 0, 0, 0, 0]; } assert.equal(M.validate(m).ok, false);   // 8400 cells
  m = base(); m.cov = { ext: 5, paidExt: 6 }; assert.equal(M.validate(m).ok, false);
});
test('K8: leadFromGraph: phone-named field with text around the number, number-typed value, e-mail in an odd field', () => {
  const k = phn(5), one = fd => M.leadFromGraph({ id: 'a', created_time: at('2026-10-01'), field_data: fd });
  assert.deepEqual(one([{ name: 'zalo', values: ['Zalo: 0' + k] }]).ph, [k]);              // phone-named field, text around the number (value pattern alone would not match)
  assert.deepEqual(one([{ name: 'so_dien_thoai', values: ['SĐT: 0' + k] }]).ph, [k]);
  assert.deepEqual(one([{ name: 'phone', values: [Number(k)] }]).ph, [k]);                  // number-typed value (leading 0 lost)
  assert.deepEqual(one([{ name: 'lien_he', values: ['Mail: PH@Example.com'] }]).em, ['ph@example.com']);
  const long = 'TS6 ' + 'x'.repeat(300); assert.ok(M.leadFromGraph({ id: 'b', created_time: at('2026-10-01'), campaign_id: '123456', campaign_name: long, field_data: [] }).cname.length <= 120);
});
test('K9: unmatchedPaid vs paidNoPhone for an e-mail-only student; blank campaign name filled by a later lead', () => {
  const S = { 1: st('TS6', { paid: true, em: ['x@example.com'], rd: '2026-10-05', pd: '2026-10-06' }) };
  const r = M.matchLeads([raw('1', at('2026-10-01'), '111111', 'TS6 A', [phn(1)])], S); assert.deepEqual(r.unmatchedPaid, { TS6: 1 }); assert.deepEqual(r.paidNoPhone, {});
  const r2 = M.matchLeads([M.leadFromGraph({ id: '1', created_time: at('2026-10-01'), campaign_id: '111111', field_data: [{ name: 'phone_number', values: ['0' + phn(2)] }] }), raw('2', at('2026-10-02'), '111111', 'TS6 A', [phn(3)])], {});
  assert.deepEqual(r2.camps['111111'], { n: 'TS6 A', p: 'TS6' });
});
test('K10: formats of one number written in several ways all count: the lead is not silently dropped as noContact', () => {
  const k = phn(5), mk = (id, t, cid, name, v) => M.leadFromGraph({ id, created_time: t, campaign_id: cid, campaign_name: name, field_data: [{ name: 'phone_number', values: [v] }] });
  const ls = [mk('z3', at('2026-10-03'), '222222', 'TS6 remarketing', '+84' + k), mk('z1', at('2026-10-01'), '111111', 'TS6 A', '0' + k), mk('z2', at('2026-10-02'), '111111', 'TS6 A', '(0' + k.slice(0, 2) + ') ' + k.slice(2))];
  const r = M.matchLeads(ls, {}); assert.equal(r.leads.noContact, 0); assert.equal(r.leads.parents, 1);
});
test('K11: mobile numbers that themselves start with 84 (084x, 0 lost by Excel) are kept; only an 84 country code in front of a full number is stripped', () => {
  const k = ['849', '123', '456'].join('');                                                                  // dựng lúc chạy: không có số điện thoại nào trong mã nguồn
  for (const v of [Number(k), k, '0' + k, '+84' + k, '84' + k]) assert.deepEqual(A.phoneKeys(v), [k], String(v));
});
test('K12: packOf: by_program lists only programmes with parents (spend alone does not create a row); top_campaigns only campaigns with >= 5 parents', () => {
  const m = M.validate({ v: 1, camps: { 111111: { n: 'TS6 big', p: 'TS6' }, 222222: { n: 'TS6 tiny', p: 'TS6' } }, days: { '2026-11-10': { 111111: [20, 0, 0, 5, 3, 5, 3], 222222: [4, 0, 0, 1, 0, 1, 0] } }, cov: { ext: 50, extWithPhone: 50 }, winFrom: '2026-10-01', unmatchedPaid: {}, paidNoPhone: {}, lag: {} }).match;
  const p = M.packOf(m, '2026-11-20', () => ({ byProgram: { TS6: 5000000, JS: 4000000 }, byCampaign: {} }));
  assert.deepEqual(p.last_30d.by_program.map(x => x.program), ['TS6']); assert.deepEqual(p.last_30d.top_campaigns.map(x => x.campaign), ['TS6 big']);
});
