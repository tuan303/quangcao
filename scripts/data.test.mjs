// Kiểm thử phần kiểm tra và che dữ liệu trước khi /api/data trả ra trang: tài liệu tuyển sinh, đối chiếu phụ huynh (fbmatch) và trạng thái cập nhật (leadsync).
// Dữ liệu là dữ liệu giả dựng lúc chạy (kho mã công khai).
import test from 'node:test';
import assert from 'node:assert/strict';
import '../fbads-core.js';
import '../admissions.js';
import '../leadmatch.js';
import { checkedAdmissionsDocs, checkedMatchDocs, redactForViewer } from '../server/scope.js';
const A = globalThis.FBAdm, M = globalThis.FBMatch;

const phn = n => '9' + String(12345678 + n * 100003);
const quiet = async fn => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };
function matchDoc() {
  const k = phn(1), S = { 1: { p: 'TS6', k: 'Khối 6', int: false, paid: true, rd: '2026-10-05', pd: '2026-10-09', ph: [k], em: [] } };
  const l = M.leadFromGraph({ id: 'a', created_time: '2026-10-01T03:00:00+0000', campaign_id: '111111', campaign_name: 'TS6-LEAD | Form', field_data: [{ name: 'phone_number', values: ['0' + k] }] });
  return Object.assign(M.matchLeads([l], S), { season: '2027–28', syncedAt: '2026-10-20T00:00:00.000Z' });
}

test('checkedMatchDocs: fbmatch hợp lệ ra trang đúng cấu trúc; trường lạ (tên, SĐT…) bị loại; tài liệu sai cấu trúc bị bỏ', async () => {
  const good = matchDoc(), k = phn(1);
  const dirty = Object.assign(JSON.parse(JSON.stringify(good)), { secret: '0' + k, phones: [k] }); dirty.leads.email = 'ten@example.com'; dirty.camps['111111'].phone = '0' + k;
  const out = await checkedMatchDocs({ fbmatch: dirty, other: { x: 1 } });
  assert.deepEqual(out.other, { x: 1 }); assert.equal(out.fbmatch.secret, undefined); assert.equal(out.fbmatch.phones, undefined); assert.equal(out.fbmatch.leads.email, undefined); assert.equal(out.fbmatch.camps['111111'].phone, undefined);
  assert.ok(!JSON.stringify(out).includes(k)); assert.deepEqual(out.fbmatch.days['2026-10-01']['111111'], good.days['2026-10-01']['111111']); assert.equal(out.fbmatch.season, '2027–28'); assert.equal(out.fbmatch.syncedAt, '2026-10-20T00:00:00.000Z');
  const bad = JSON.parse(JSON.stringify(good)); bad.days['2026-10-01']['111111'][0] = 'Nguyễn Văn A';
  const out2 = await quiet(() => checkedMatchDocs({ fbmatch: bad, keep: 1 })); assert.equal(out2.fbmatch, undefined); assert.equal(out2.keep, 1);
  assert.equal((await quiet(() => checkedMatchDocs({ fbmatch: 'x' }))).fbmatch, undefined);
  assert.deepEqual(await checkedMatchDocs({ a: 1 }), { a: 1 });                                  // không có tài liệu nào của đối chiếu: để nguyên
});

test('checkedMatchDocs: leadsync chỉ giữ trạng thái đã biết — giờ ISO, bước, người chạy, số nguyên; lỗi cắt 400 ký tự; không có khoá lạ', async () => {
  const soon = new Date(Date.now() + 60000).toISOString(), past = new Date(Date.now() - 60000).toISOString();
  const raw = { v: 9, at: '2026-10-20T00:00:00.000Z', ok: false, stage: 'meta', error: 'x'.repeat(900), ms: 1234, by: 'admin', runningUntil: soon, stats: { rows: 10, parents: 9, matched: 3, students: 5, studentsWithPhone: 4, paidExt: 3, paidExtWithPhone: 2, forms: 1, pages: 1, skippedForms: 0, from: '2026-08-23', email: 'ten@example.com', phone: 123 }, token: 'khong-duoc-ra' };
  const o = (await checkedMatchDocs({ leadsync: raw })).leadsync;
  assert.equal(o.v, 1); assert.equal(o.ok, false); assert.equal(o.stage, 'meta'); assert.equal(o.error.length, 400); assert.equal(o.by, 'admin'); assert.equal(o.running, true); assert.equal(o.ms, 1234);
  assert.deepEqual(Object.keys(o.stats).sort(), ['forms', 'matched', 'pages', 'paidExt', 'paidExtWithPhone', 'parents', 'rows', 'skippedForms', 'students', 'studentsWithPhone']); assert.equal(o.stats.rows, 10);
  assert.ok(!('token' in o) && !JSON.stringify(o).includes('khong-duoc-ra') && !JSON.stringify(o).includes('example.com'));
  const odd = (await checkedMatchDocs({ leadsync: { at: 'hôm qua', ok: 'true', stage: '<script>', error: 5, ms: -1, by: 'someone@example.com', runningUntil: past, stats: { rows: 1.5, parents: '9', matched: null } } })).leadsync;
  assert.deepEqual([odd.at, odd.ok, odd.stage, odd.error, odd.ms, odd.by, odd.running], [null, false, null, null, null, null, false]); assert.deepEqual(odd.stats, { rows: null, parents: null, matched: null, students: null, studentsWithPhone: null, paidExt: null, paidExtWithPhone: null, forms: null, pages: null, skippedForms: null });
  assert.equal((await checkedMatchDocs({ leadsync: 'x' })).leadsync, undefined); assert.equal((await checkedMatchDocs({ leadsync: { ok: true } })).leadsync.stats, null);
});

test('checkedAdmissionsDocs: nguồn chỉ là sheet hoặc upload; người tải chỉ là một địa chỉ email ngắn; tài liệu sai cấu trúc bị bỏ', async () => {
  const ag = A.aggregate({ reg: [[], ['MDT', 'HS nội bộ', 'Họ tên học sinh', 'Khối 27 28', 'Chiến dịch'], [1, '', 'A', 'Khối 6', 'TS6']], paid: [{ name: 'LỚP 6 2728 (ĐP)', rows: [[], ['MDT', 'HS nội bộ', 'Họ tên học sinh'], [1, '', 'A']] }], today: '2026-11-20' });
  assert.ok(ag.ok);
  const doc = (extra) => Object.assign({}, ag.summary, { uploadedAt: '2026-10-20T01:02:03.000Z' }, extra);
  assert.equal((await checkedAdmissionsDocs({ admissions: doc({ source: 'sheet', by: null }) })).admissions.source, 'sheet');
  const up = (await checkedAdmissionsDocs({ admissions: doc({ source: 'upload', by: 'quan.tri@example.com' }) })).admissions; assert.equal(up.source, 'upload'); assert.equal(up.by, 'quan.tri@example.com');
  const weird = (await checkedAdmissionsDocs({ admissions: doc({ source: 'hack', by: '<b>x</b> y@z', uploadedAt: 'hôm qua' }) })).admissions; assert.deepEqual([weird.source, weird.by, weird.uploadedAt], [null, null, null]);
  assert.equal((await quiet(() => checkedAdmissionsDocs({ admissions: { v: 1, total: 'x' } }))).admissions, undefined);
  assert.deepEqual(await checkedAdmissionsDocs({ a: 1 }), { a: 1 });
});

test('redactForViewer: người chỉ xem không thấy lỗi chi tiết của Google/Meta, email quản trị, người chạy cập nhật', () => {
  const docs = { meta: { syncedBy: 'quan.tri@example.com', perAccount: { 1: { error: 'Meta API: chi tiết' } } }, admissions: { by: 'quan.tri@example.com', total: {} }, insights: { by: 'vercel:quan.tri@example.com' },
    leadsync: { ok: false, error: 'Service account x@example.com chưa có quyền', by: 'admin', stage: 'sheet', at: '2026-10-20T00:00:00.000Z' }, fbmatch: { v: 1 } };
  const v = redactForViewer(docs);
  assert.equal(v.leadsync.error, null); assert.equal(v.leadsync.by, null); assert.equal(v.leadsync.ok, false); assert.equal(v.leadsync.stage, 'sheet'); assert.equal(v.leadsync.at, '2026-10-20T00:00:00.000Z');
  assert.equal(v.meta.syncedBy, null); assert.equal(v.meta.perAccount[1].error, null); assert.equal(v.admissions.by, null); assert.equal(v.insights.by, null); assert.deepEqual(v.fbmatch, { v: 1 });
  assert.ok(!JSON.stringify(v).includes('example.com'));
  assert.equal(docs.leadsync.error, 'Service account x@example.com chưa có quyền');                // bản gốc không bị sửa (quản trị vẫn thấy)
  assert.deepEqual(redactForViewer({ a: 1 }), { a: 1 });
});
