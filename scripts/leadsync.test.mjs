// Kiểm thử offline cho phần máy chủ của đối chiếu phụ huynh: đọc Google Sheet bằng service account, lấy lead qua Graph API, điều phối và ghi số tổng hợp.
// Google và Meta được thay bằng bản giả (fetch giả); kho số liệu là bộ nhớ. Mọi SĐT, email, họ tên là dữ liệu giả dựng lúc chạy.
import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import '../fbads-core.js';
import '../admissions.js';
import '../leadmatch.js';
import * as G from '../server/gsheets.js';
import * as L from '../server/leads.js';
import { graph, allPages, withDeadline, setDeadline } from '../server/meta.js';
import * as S from '../server/leadsync.js';
import { describeUnknown, scrub } from '../server/safelog.js';
const A = globalThis.FBAdm;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = { project_id: 'proj-test', client_email: 'tester@example.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const SHEET = 'S'.repeat(10) + 'h'.repeat(10) + '_-' + '0'.repeat(22);
const PAGE = ['555', '000', '111'].join('');                    // mã Trang giả (dựng lúc chạy để không có chuỗi 9 chữ số liền trong mã nguồn)
const ENV = { FIREBASE_SERVICE_ACCOUNT: JSON.stringify(SA), ADMISSIONS_SHEET_ID: 'https://docs.google.com/spreadsheets/d/' + SHEET + '/edit#gid=0', META_ACCESS_TOKEN: 'tok-test', META_PAGE_IDS: PAGE, META_AD_ACCOUNTS: '895057262833914' };
const TODAY = '2026-11-20';
const phn = n => '9' + String(12345678 + n * 100003);
const ser = day => Math.round(Date.parse(day + 'T00:00:00Z') / 86400000) + 25569;     // số seri ngày kiểu Excel/Google Sheets
const json = (body, status = 200) => ({ body, status });

function stubFetch(routes) {
  const calls = [], orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url)); calls.push({ u, init });
    for (const r of routes) { const out = await r(u, init, calls); if (out) return new Response(JSON.stringify(out.body == null ? {} : out.body), { status: out.status || 200, headers: { 'content-type': 'application/json' } }); }
    return new Response(JSON.stringify({ error: { message: 'không có route ' + u.host + u.pathname } }), { status: 404 });
  };
  return { calls, restore() { globalThis.fetch = orig; } };
}
const jwtChecks = [];
const googleRoutes = sheet => [
  (u, init) => {
    if (u.host !== 'oauth2.googleapis.com') return;
    const p = new URLSearchParams(String(init.body)), [h, c, s] = String(p.get('assertion')).split('.');
    jwtChecks.push({ grant: p.get('grant_type'), ok: createVerify('RSA-SHA256').update(h + '.' + c).verify(publicKey, Buffer.from(s, 'base64url')), claims: JSON.parse(Buffer.from(c, 'base64url').toString()) });
    return json({ access_token: 'gtok', expires_in: 3600 });
  },
  u => u.host === 'sheets.googleapis.com' && u.pathname === '/v4/spreadsheets/' + SHEET && (sheet.metaError ? json({ error: sheet.metaError.error }, sheet.metaError.status) : json(sheet.meta)),
  u => u.host === 'sheets.googleapis.com' && u.pathname === '/v4/spreadsheets/' + SHEET + '/values:batchGet' && json({ valueRanges: u.searchParams.getAll('ranges').map(r => { const v = sheet.values[r.replace(/^'|'$/g, '').replace(/''/g, "'")]; return v && v.length ? { range: r, values: v } : { range: r }; }) })
];

/* ---- bộ dữ liệu giả: mùa 2027–28, hôm nay 20/11/2026 ---- */
const P = { b1: phn(1), m1: phn(2), m2: phn(3), p3: phn(4), n5: phn(5), x: phn(6) };
const NAMES = ['HỌC SINH MỘT', 'HỌC SINH HAI', 'HỌC SINH BA', 'HỌC SINH BỐN', 'HỌC SINH NĂM'];
const EMAILS = { m1: 'me.mot@example.com' };
function sheetData() {
  const hdr = ['MDT', 'HS nội bộ', 'Họ tên học sinh', 'Khối 27 28', 'Chiến dịch', 'SĐT bố', 'SĐT mẹ', 'Email phụ huynh', 'Ngày đăng ký', 'Ngày đóng phí'];
  return {
    meta: { properties: { title: 'DATA TUYỂN SINH (giả)' }, sheets: [
      { properties: { sheetId: 0, title: 'Danh sách đăng ký' }, merges: [{ startRowIndex: 2, endRowIndex: 4, startColumnIndex: 4, endColumnIndex: 5 }] },
      { properties: { sheetId: 1, title: 'LỚP 6 2728 (ĐP)' } }, { properties: { sheetId: 2, title: 'LỚP 10 2728 (ĐP)' } }, { properties: { sheetId: 3, title: 'Ghi chú' } }, { properties: { sheetId: 4, title: 'LỚP 1 2728 (ĐP) cũ' } }] },
    values: {
      'Danh sách đăng ký': [[], hdr,
        [1, '', NAMES[0], 'Khối 6', 'TS6', '0' + P.b1, Number(P.m1), EMAILS.m1, ser('2026-10-05'), ser('2026-10-12')],   // Chiến dịch TS6 gộp ô với dòng dưới
        [2, '', NAMES[1], 'Khối 6', '', '', '0' + P.p3, '', ser('2026-10-06'), ''],
        [3, '', NAMES[2], 'Khối 10', 'TS10', '', '', '', ser('2026-10-08'), ser('2026-10-15')],
        [4, 20000001, NAMES[3], 'Khối 1', 'JS', '', '+84' + P.n5, '', ser('2026-10-01'), ser('2026-10-02')],
        [5, '', NAMES[4], 'Khối 1', 'TS1', '', '', '', ser('2026-10-09'), ser('2026-10-14')]],
      'LỚP 6 2728 (ĐP)': [[], ['MDT', 'HS nội bộ', 'Họ tên học sinh'], [1], [1, '', NAMES[0]]],
      'LỚP 10 2728 (ĐP)': [[], ['MDT', 'HS nội bộ', 'Họ tên học sinh', 'SĐT ưu tiên'], [1], [3, '', NAMES[2], '0' + P.m2]]
    }
  };
}
const glead = (id, day, cid, cname, phone, extra = {}) => Object.assign({ id, created_time: day + 'T03:00:00+0000', ad_id: 'ad' + id, campaign_id: cid, campaign_name: cname, form_id: 'f1', is_organic: false,
  field_data: [{ name: 'full_name', values: ['Phụ Huynh ' + id] }, { name: 'phone_number', values: [phone] }, { name: 'email', values: [id + '@example.com'] }] }, extra);
const LEADS = [glead('L1', '2026-10-01', '111111', 'TS6-LEAD | Form', '+84' + P.b1), glead('L2', '2026-10-02', '111111', 'TS6-LEAD | Form', '0' + P.p3), glead('L3', '2026-10-06', '222222', 'TS10-LEAD | Form', '0' + P.m2),
  glead('L4', '2026-10-07', '111111', 'TS6-LEAD | Form', '0' + P.n5), glead('L5', '2026-10-09', '222222', 'TS10-LEAD | Form', '0' + P.x), glead('L6', '2026-10-03', '333333', 'TS6 remarketing', '0' + P.m1)];
const graphRoutes = (cfg = {}) => {
  const forms = cfg.forms || [{ id: 'f1', name: 'Form tư vấn', status: 'ACTIVE', leads_count: LEADS.length }, { id: 'f2', name: 'Form cũ', status: 'ARCHIVED', leads_count: 4 }];
  const leads = cfg.leads || LEADS;
  return [
    (u, init) => {
      if (u.host !== 'graph.facebook.com') return;
      const path = u.pathname.replace(/^\/v\d+\.\d+/, '');
      if (path === '/' + PAGE && u.searchParams.get('fields') === 'access_token,name') return cfg.noPageToken ? json({ name: 'Trang thử' }) : json({ access_token: 'ptok', name: 'Trang thử' });
      if (path === '/' + PAGE + '/leadgen_forms') { assert.equal(init.headers.Authorization, 'Bearer ptok'); return json({ data: forms }); }
      if (path === '/f2/leads') return json({ error: { code: 200, message: '(#200) lỗi quyền biểu mẫu cũ' } }, 403);
      if (path === '/f1/leads') {
        assert.equal(init.headers.Authorization, 'Bearer ptok');
        if (cfg.leadsError) return json({ error: cfg.leadsError }, 400);
        if (cfg.onLeads) cfg.onLeads(u);
        const after = u.searchParams.get('after'), half = Math.ceil(leads.length / 2);
        return after ? json({ data: leads.slice(half) }) : json({ data: leads.slice(0, half), paging: { next: 'https://graph.facebook.com/v25.0/f1/leads?after=2&access_token=ptok&limit=100' } });
      }
      if (path === '/me/permissions') return json({ data: (cfg.perms || ['leads_retrieval', 'pages_show_list', 'pages_read_engagement', 'pages_manage_ads', 'ads_read']).map(p => ({ permission: p, status: 'granted' })) });
      if (path === '/' || path === '') return json(cfg.byIds || {});
    }
  ];
};
function memStore(init = {}) {
  const docs = JSON.parse(JSON.stringify(init)), writes = [];
  return { docs, writes, async readDocs(ids) { const o = {}; for (const id of ids) if (docs[id]) o[id] = JSON.parse(JSON.stringify(docs[id])); return o; },
    async writeDocs(d) { for (const [id, v] of Object.entries(d)) { docs[id] = JSON.parse(JSON.stringify(v)); writes.push(id); } return Object.keys(d).length; } };
}
const allText = store => JSON.stringify(store.docs);
const nope = (text, list) => { for (const s of list) assert.ok(!text.includes(s), 'không được chứa: ' + s.slice(0, 6) + '…'); };
const PII = [...Object.values(P), ...NAMES, ...Object.values(EMAILS), 'Phụ Huynh', 'L1@example.com', 'L3@example.com', 'full_name'];

/* ================= Google Sheets ================= */
test('sheetIdFrom và serviceAccountInfo: nhận đường dẫn hoặc ID; không trả khoá riêng', () => {
  assert.equal(G.sheetIdFrom(ENV.ADMISSIONS_SHEET_ID), SHEET); assert.equal(G.sheetIdFrom(SHEET), SHEET); assert.equal(G.sheetIdFrom('  "' + SHEET + '" '), SHEET);
  for (const bad of ['', null, undefined, 'abc', 'https://example.com/x', 'a'.repeat(19), 'x y '.repeat(20)]) assert.equal(G.sheetIdFrom(bad), '', String(bad));
  const info = G.serviceAccountInfo(ENV); assert.deepEqual(info, { email: SA.client_email, projectId: SA.project_id });
  assert.equal(G.serviceAccountInfo({}), null);
});

test('buildJwt + accessToken: JWT RS256 đúng phạm vi chỉ đọc, được Google xác minh; token được nhớ, không xin lại', async () => {
  const jwt = G.buildJwt(SA, 1700000000), [h, c, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.deepEqual(claims, { iss: SA.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', aud: 'https://oauth2.googleapis.com/token', iat: 1700000000, exp: 1700003600 });
  assert.ok(createVerify('RSA-SHA256').update(h + '.' + c).verify(publicKey, Buffer.from(s, 'base64url')));
  G.resetTokenCache(); jwtChecks.length = 0;
  const f = stubFetch(googleRoutes({ meta: {}, values: {} }));
  try {
    assert.equal(await G.accessToken(ENV), 'gtok'); assert.equal(await G.accessToken(ENV), 'gtok');
    assert.equal(jwtChecks.length, 1); assert.ok(jwtChecks[0].ok); assert.equal(jwtChecks[0].grant, 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  } finally { f.restore(); G.resetTokenCache(); }
  const bad = stubFetch([u => u.host === 'oauth2.googleapis.com' && json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, 400)]);
  try { await assert.rejects(() => G.accessToken(ENV), /khoá service account/); } finally { bad.restore(); G.resetTokenCache(); }
  await assert.rejects(() => G.accessToken({}), e => e.status === 501 && /FIREBASE_SERVICE_ACCOUNT/.test(e.message));
});

test('describeSheetsError: nói rõ cần bật API, chia sẻ Sheet, đổi sang Google Sheet; kèm email service account', () => {
  const sa = { email: 'tester@example.com', projectId: 'proj-test' };
  assert.match(G.describeSheetsError(403, { error: { message: 'Google Sheets API has not been used in project 1 before or it is disabled.', details: [{ reason: 'SERVICE_DISABLED' }] } }, sa), /Google Sheets API.*proj-test.*Enable/s);
  assert.match(G.describeSheetsError(403, { error: { message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } }, sa), /tester@example\.com.*Viewer/s);
  assert.match(G.describeSheetsError(404, {}, sa), /tester@example\.com/);
  assert.match(G.describeSheetsError(400, { error: { message: 'This operation is not supported for this document' } }, sa), /Lưu dưới dạng Google Trang tính/);
  assert.match(G.describeSheetsError(429, {}, sa), /giới hạn/); assert.match(G.describeSheetsError(500, null, null), /500/);
});

test('expandMerges: ô gộp lấy giá trị ô trên cùng bên trái, không đè ô đã có, bỏ qua vùng quá lớn', () => {
  const rows = [['a', 'b'], ['x', '', 'k'], []];
  G.expandMerges(rows, [{ startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 1 }, { startRowIndex: 1, endRowIndex: 2, startColumnIndex: 1, endColumnIndex: 3 }]);   // Google bỏ trường bằng 0 (sheetId, startRowIndex…)
  assert.deepEqual(rows[1], ['x', '', 'k']);    // ô A2 đã có 'x' nên giữ; gộp B2:C2 có ô trái trống nên không làm gì
  assert.equal(rows[2][0], 'a');
  const rows2 = [['t', ''], ['', '']]; G.expandMerges(rows2, [{ endRowIndex: 2, endColumnIndex: 2 }]); assert.deepEqual(rows2, [['t', 't'], ['t', 't']]);
  const big = [['t']]; G.expandMerges(big, [{ endRowIndex: 100000, endColumnIndex: 5 }]); assert.equal(big.length, 1);
});

test('readAdmissionsSheet: chọn tab Danh sách đăng ký và tab (ĐP), đọc giá trị gốc, mở rộng ô gộp; tab ĐP tên lạ được báo; tab khác bị bỏ qua', async () => {
  G.resetTokenCache();
  const f = stubFetch(googleRoutes(sheetData()));
  try {
    const b = await G.readAdmissionsSheet(ENV.ADMISSIONS_SHEET_ID, { pickTabs: A.pickTabs, env: ENV });
    assert.equal(b.title, 'DATA TUYỂN SINH (giả)'); assert.deepEqual(b.tabs, ['Danh sách đăng ký', 'LỚP 6 2728 (ĐP)', 'LỚP 10 2728 (ĐP)']); assert.deepEqual(b.skipped, ['LỚP 1 2728 (ĐP) cũ']);
    assert.equal(b.reg[3][4], 'TS6');                                   // dòng 4 cột Chiến dịch trống nhưng thuộc ô gộp với dòng 3
    assert.equal(b.paid.length, 2); assert.equal(typeof b.reg[2][8], 'number');
    const batch = f.calls.find(c => c.u.pathname.endsWith('values:batchGet')).u.searchParams;
    assert.equal(batch.get('valueRenderOption'), 'UNFORMATTED_VALUE'); assert.equal(batch.get('dateTimeRenderOption'), 'SERIAL_NUMBER'); assert.deepEqual(batch.getAll('ranges'), ["'Danh sách đăng ký'"]);              // lần 1: chỉ tab đăng ký, để biết mùa
    const second = f.calls.filter(c => c.u.pathname.endsWith('values:batchGet'))[1].u.searchParams; assert.deepEqual(second.getAll('ranges'), ["'LỚP 6 2728 (ĐP)'", "'LỚP 10 2728 (ĐP)'"]); assert.equal(b.otherSeasonTabs, 0);
    assert.ok(f.calls.every(c => c.u.host !== 'sheets.googleapis.com' || c.init.method == null || c.init.method === 'GET'), 'chỉ đọc');
    assert.ok(f.calls.filter(c => c.u.host === 'sheets.googleapis.com').every(c => c.init.headers.Authorization === 'Bearer gtok'));
  } finally { f.restore(); G.resetTokenCache(); }
});

test('readAdmissionsSheet: sắp hết hạn chót của lần gọi thì dừng ngay với thông báo rõ, không gọi Google; còn thời gian thì đọc bình thường', async () => {
  G.resetTokenCache(); let f = stubFetch(googleRoutes(sheetData()));
  try {
    await withDeadline(async () => { setDeadline(Date.now() + 800); await assert.rejects(() => G.readAdmissionsSheet(SHEET, { pickTabs: A.pickTabs, env: ENV }), e => e.expose === true && /hết thời gian của lần cập nhật/.test(e.message)); });
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); G.resetTokenCache(); }
  f = stubFetch(googleRoutes(sheetData()));
  try { await withDeadline(async () => { setDeadline(Date.now() + 60000); const b = await G.readAdmissionsSheet(SHEET, { pickTabs: A.pickTabs, env: ENV }); assert.equal(b.tabs.length, 3); }); } finally { f.restore(); G.resetTokenCache(); }
});

test('readAdmissionsSheet: lỗi Google thành câu hướng dẫn; thiếu tab đăng ký; ID sai', async () => {
  for (const [status, error, want] of [[403, { message: 'The caller does not have permission', status: 'PERMISSION_DENIED' }, /tester@example\.com.*Viewer/s], [404, { message: 'Requested entity was not found.' }, /chưa chia sẻ/], [403, { message: 'API has not been used', details: [{ reason: 'SERVICE_DISABLED' }] }, /Enable/]]) {
    G.resetTokenCache(); const f = stubFetch(googleRoutes({ metaError: { status, error }, values: {} }));
    try { await assert.rejects(() => G.readAdmissionsSheet(SHEET, { pickTabs: A.pickTabs, env: ENV }), e => want.test(e.message) && e.expose === true); } finally { f.restore(); G.resetTokenCache(); }
  }
  G.resetTokenCache(); const f = stubFetch(googleRoutes({ meta: { properties: { title: 'x' }, sheets: [{ properties: { sheetId: 1, title: 'Ghi chú' } }] }, values: {} }));
  try { await assert.rejects(() => G.readAdmissionsSheet(SHEET, { pickTabs: A.pickTabs, env: ENV }), /Danh sách đăng ký/); } finally { f.restore(); G.resetTokenCache(); }
  await assert.rejects(() => G.readAdmissionsSheet('không phải id', { env: ENV }), /ADMISSIONS_SHEET_ID/);
});

/* ================= Lead Facebook ================= */
test('fetchLeads: Trang → biểu mẫu → lead có phân trang; lọc từ ngày đọc, bỏ trùng; biểu mẫu lưu trữ lỗi thì bỏ qua', async () => {
  let filt = null; const f = stubFetch(graphRoutes({ onLeads: u => { const v = u.searchParams.get('filtering'); if (v) filt = JSON.parse(v); } }));
  try {
    const r = await L.fetchLeads({ token: 'tok-test', accts: ['895057262833914'], sinceDay: '2026-08-22', env: ENV });
    assert.equal(r.leads.length, 6); assert.equal(r.forms, 2); assert.equal(r.skippedForms, 1); assert.equal(r.pages, 1); assert.equal(r.source, 'META_PAGE_IDS');
    assert.deepEqual(filt, [{ field: 'time_created', operator: 'GREATER_THAN', value: Math.floor(Date.parse('2026-08-22T00:00:00+07:00') / 1000) - 86400 }]);
    assert.ok(f.calls.some(c => c.u.searchParams.get('after') === '2'), 'có đọc trang kế tiếp');
    assert.ok(f.calls.every(c => !c.u.searchParams.has('access_token')), 'token chỉ gửi trong header');
  } finally { f.restore(); }
});

test('fetchLeads: không trả một phần — biểu mẫu đang dùng lỗi thì dừng với hướng dẫn quyền; Trang không cấp quyền; không tìm thấy Trang', async () => {
  let f = stubFetch(graphRoutes({ leadsError: { code: 200, message: '(#200) Requires leads_retrieval permission' } }));
  try { await assert.rejects(() => L.fetchLeads({ token: 'tok-test', accts: [], sinceDay: '2026-08-22', env: ENV }), e => /leads_retrieval/.test(e.message) && e.expose === true); } finally { f.restore(); }
  f = stubFetch(graphRoutes({ noPageToken: true }));
  try { await assert.rejects(() => L.fetchLeads({ token: 'tok-test', accts: [], sinceDay: '2026-08-22', env: ENV }), /gán Trang/); } finally { f.restore(); }
  f = stubFetch([u => u.host === 'graph.facebook.com' && u.pathname.endsWith('/promote_pages') && json({ data: [] }), u => u.host === 'graph.facebook.com' && u.pathname.endsWith('/me/accounts') && json({ data: [] })]);
  try { await assert.rejects(() => L.fetchLeads({ token: 'tok-test', accts: ['895057262833914'], sinceDay: '2026-08-22', env: {} }), /Không tìm thấy Trang/); } finally { f.restore(); }
});

test('fetchLeads: Trang lấy từ tài khoản quảng cáo khi không đặt META_PAGE_IDS; trường Graph bị từ chối được bỏ và thử lại; thiếu chiến dịch thì tra theo quảng cáo', async () => {
  const noCamp = LEADS.slice(0, 2).map(l => { const o = Object.assign({}, l); delete o.campaign_id; delete o.campaign_name; return o; });
  let tries = 0;
  const f = stubFetch([
    u => u.host === 'graph.facebook.com' && u.pathname.endsWith('/act_895057262833914/promote_pages') && json({ data: [{ id: PAGE, name: 'Trang thử' }] }),
    ...graphRoutes({ leads: noCamp, forms: [{ id: 'f1', status: 'ACTIVE' }], byIds: { adL1: { campaign_id: '777777', campaign: { id: '777777', name: 'TS6-LEAD | Tra' } }, adL2: { campaign_id: '777777', campaign: { id: '777777', name: 'TS6-LEAD | Tra' } } } })
      .map(r => (u, init) => { if (u.pathname.endsWith('/f1/leads') && !tries++ ) return json({ error: { code: 100, message: '(#100) Tried accessing nonexisting field (is_organic) on node type (Lead)' } }, 400); return r(u, init); })
  ]);
  try {
    const r = await L.fetchLeads({ token: 'tok-test', accts: ['895057262833914'], sinceDay: '2026-08-22', env: {} });
    assert.equal(r.source, 'tài khoản quảng cáo'); assert.equal(r.leads.length, 2);
    const asked = f.calls.filter(c => c.u.pathname.endsWith('/f1/leads')); const withFields = asked.filter(c => c.u.searchParams.has('fields')); assert.ok(withFields.length >= 2); assert.ok(withFields[0].u.searchParams.get('fields').includes('is_organic')); assert.ok(!withFields[withFields.length - 1].u.searchParams.get('fields').includes('is_organic'));
    assert.deepEqual(r.leads.map(l => l.campaign_id), ['777777', '777777']); assert.equal(r.leads[0].campaign_name, 'TS6-LEAD | Tra');
  } finally { f.restore(); }
});

test('fetchLeads: danh sách lead dài quá hạn mức phân trang thì báo lỗi, không trả danh sách cụt', async () => {
  const f = stubFetch([u => u.host === 'graph.facebook.com' && /\/f1\/leads$/.test(u.pathname) && json({ data: [LEADS[0]], paging: { next: 'https://graph.facebook.com/v25.0/f1/leads?after=tiep' } }),
    ...graphRoutes({ forms: [{ id: 'f1', status: 'ACTIVE', leads_count: 5 }] })]);
  try { await assert.rejects(() => L.fetchLeads({ token: 'tok-test', accts: [], sinceDay: '2026-08-22', env: ENV }), e => e.expose === true && /không lấy thiếu/.test(e.message)); } finally { f.restore(); }
  assert.match(L.explainMeta({ meta: { code: 'truncated' } }, 'lead'), /dài bất thường/);
});

test('fetchLeads: một quảng cáo không đọc được (đã xoá) không làm mất chiến dịch của các quảng cáo còn lại; số lần tra có giới hạn', async () => {
  const noCamp = LEADS.slice(0, 4).map(l => { const o = Object.assign({}, l); delete o.campaign_id; delete o.campaign_name; return o; });
  const asked = [];
  const route = isBad => u => {
    if (u.host !== 'graph.facebook.com' || !/^\/v[\d.]+\/?$/.test(u.pathname)) return;
    const ids = u.searchParams.get('ids').split(','); asked.push(ids.length);
    if (ids.some(isBad)) return json({ error: { code: 100, message: '(#803) Some of the aliases you requested do not exist' } }, 400);
    return json(Object.fromEntries(ids.map(id => [id, { campaign_id: '777' + id.slice(-1), campaign: { id: '777' + id.slice(-1), name: 'TS6-LEAD | ' + id } }])));
  };
  let f = stubFetch([route(id => id === 'adL3'), ...graphRoutes({ leads: noCamp, forms: [{ id: 'f1', status: 'ACTIVE', leads_count: 4 }] })]);
  try {
    const r = await L.fetchLeads({ token: 'tok-test', accts: [], sinceDay: '2026-08-22', env: ENV });
    assert.deepEqual(r.leads.map(l => l.campaign_id), ['7771', '7772', undefined, '7774']); assert.equal(asked[0], 4); assert.ok(asked.length <= 8, 'chia đôi lô lỗi: ' + asked.join(','));
  } finally { f.restore(); }
  asked.length = 0;                                                                                  // 200 quảng cáo đều lỗi: dừng ở hạn mức lần gọi (không chia đôi đến cùng ≈ 400 lần), lead vẫn còn (chưa rõ chiến dịch)
  const many = Array.from({ length: 200 }, (_, i) => { const o = glead('Z' + i, '2026-10-01', '', '', '0' + phn(100 + i)); delete o.campaign_id; delete o.campaign_name; return o; });
  f = stubFetch([route(() => true), ...graphRoutes({ leads: many, forms: [{ id: 'f1', status: 'ACTIVE', leads_count: 200 }] })]);
  try { const r = await L.fetchLeads({ token: 'tok-test', accts: [], sinceDay: '2026-08-22', env: ENV }); assert.equal(r.leads.length, 200); assert.ok(r.leads.every(l => !l.campaign_id)); assert.equal(asked.length, 120); } finally { f.restore(); }
});

const RECENT = new Date(Date.now() - 10 * 86400000).toISOString(), OLD = new Date(Date.now() - 200 * 86400000).toISOString();
test('fetchLeads: biểu mẫu đã lưu trữ chỉ được bỏ qua khi Meta chắc chắn không cho đọc (không còn / không quyền); giới hạn tần suất thì dừng cả lần', async () => {
  const archived = (code, message) => u => u.host === 'graph.facebook.com' && /\/f2\/leads$/.test(u.pathname) && json({ error: { code, message } }, 400);
  for (const code of [100, 200]) {
    const f = stubFetch([archived(code, code === 100 ? '(#100) Unsupported get request. Object does not exist' : '(#200) Requires leads_retrieval'), ...graphRoutes()]);
    try { const r = await L.fetchLeads({ token: 'tok-test', accts: [], sinceDay: '2026-08-22', env: ENV }); assert.equal(r.skippedForms, 1); assert.equal(r.leads.length, 6); } finally { f.restore(); }
  }
  const f = stubFetch([archived(80005, '(#80005) There have been too many Leadgen API calls'), ...graphRoutes()]);
  try { await assert.rejects(() => L.fetchLeads({ token: 'tok-test', accts: [], sinceDay: '2026-08-22', env: ENV }), e => e.expose === true && e.meta && e.meta.code === 80005); } finally { f.restore(); }
});

test('fetchLeads: check = số lead các biểu mẫu mới báo có (expected) và số đọc được (got); biểu mẫu cũ không tính', async () => {
  const forms = [{ id: 'f1', status: 'ACTIVE', leads_count: 6, created_time: RECENT }, { id: 'f9', status: 'ACTIVE', leads_count: 50, created_time: OLD }];
  let f = stubFetch([u => u.host === 'graph.facebook.com' && /\/f9\/leads$/.test(u.pathname) && json({ data: [] }), ...graphRoutes({ forms })]);
  try { const r = await L.fetchLeads({ token: 'tok-test', accts: [], sinceDay: '2026-08-22', env: ENV }); assert.deepEqual(r.check, { expected: 6, got: 6 }); } finally { f.restore(); }
  f = stubFetch([u => u.host === 'graph.facebook.com' && /\/f[19]\/leads$/.test(u.pathname) && json({ data: [] }), ...graphRoutes({ forms })]);        // Meta trả rỗng cho mọi biểu mẫu
  try { const r = await L.fetchLeads({ token: 'tok-test', accts: [], sinceDay: '2026-08-22', env: ENV }); assert.deepEqual(r.check, { expected: 6, got: 0 }); assert.equal(r.leads.length, 0); } finally { f.restore(); }
});

test('runLeadSync: Meta báo biểu mẫu mới có lead nhưng không trả lead nào thì dừng (409, ghi đè được), không ghi đè bằng số 0', async () => {
  const forms = [{ id: 'f1', status: 'ACTIVE', leads_count: 6, created_time: RECENT }];
  const routes = () => [...googleRoutes(sheetData()), u => u.host === 'graph.facebook.com' && /\/f1\/leads$/.test(u.pathname) && json({ data: [] }), ...graphRoutes({ forms })];
  G.resetTokenCache(); let store = memStore(), f = stubFetch(routes());
  try {
    await assert.rejects(() => S.runLeadSync({ env: ENV, today: TODAY, store }), e => e.status === 409 && e.canForce === true && /Development/.test(e.message) && /Leads access/.test(e.message) && e.stage === 'meta');
    assert.equal(store.docs.fbmatch, undefined); assert.equal(store.docs.leadsync.ok, false); assert.equal(store.docs.leadsync.stage, 'meta');
  } finally { f.restore(); G.resetTokenCache(); }
  store = memStore(); G.resetTokenCache(); f = stubFetch(routes());
  try { assert.equal((await S.runLeadSync({ env: ENV, today: TODAY, store, force: true })).ok, true); assert.ok(store.docs.fbmatch); } finally { f.restore(); G.resetTokenCache(); }
});

test('runLeadSync: Meta chỉ trả một phần nhỏ lead của các biểu mẫu mới (ứng dụng Development thấy vài lead thử trong hàng trăm) cũng dừng (409, ghi đè được), không làm lần đọc đầu mất các ngày 60–90; bước kiểm tra kết nối cũng đỏ', async () => {
  const forms = [{ id: 'f1', status: 'ACTIVE', leads_count: 454, created_time: RECENT }];
  const routes = () => [...googleRoutes(sheetData()), ...graphRoutes({ forms, leads: LEADS.slice(0, 2) })];
  G.resetTokenCache(); let store = memStore(), f = stubFetch(routes());
  try {
    await assert.rejects(() => S.runLeadSync({ env: ENV, today: TODAY, store }), e => e.status === 409 && e.canForce === true && JSON.stringify(e.guards) === '["empty"]' && /454 lead nhưng chỉ trả 2/.test(e.message) && /Development/.test(e.message));
    assert.equal(store.docs.fbmatch, undefined);
  } finally { f.restore(); G.resetTokenCache(); }
  store = memStore(); G.resetTokenCache(); f = stubFetch(routes());
  try {
    assert.equal((await S.runLeadSync({ env: ENV, today: TODAY, store, force: ['empty'] })).ok, true); assert.ok(store.docs.fbmatch);
    G.resetTokenCache(); assert.equal((await S.runLeadSync({ env: ENV, today: A.addDays(TODAY, 1), store })).ok, true);          // sau đó cron (không ghi đè) không bị chặn mãi: đã có số lưu nên chỉ chốt chặn "drop" còn canh
  } finally { f.restore(); G.resetTokenCache(); }
  // dưới ngưỡng (ít hơn 10 lead theo Meta, hoặc từ một nửa trở lên) thì không dừng
  for (const [count, got] of [[9, 2], [12, 6], [454, 300]]) {
    const fm = [{ id: 'f1', status: 'ACTIVE', leads_count: count, created_time: RECENT }], many = Array.from({ length: got }, (_, i) => Object.assign({}, LEADS[i % LEADS.length], { id: 'M' + i }));
    G.resetTokenCache(); store = memStore(); f = stubFetch([...googleRoutes(sheetData()), ...graphRoutes({ forms: fm, leads: many })]);
    try { assert.equal((await S.runLeadSync({ env: ENV, today: TODAY, store })).ok, true, count + '/' + got); } finally { f.restore(); G.resetTokenCache(); }
  }
  // kiểm tra kết nối: cộng dồn trên mọi biểu mẫu mới như lần đọc thật (không xét từng biểu mẫu); còn trang kế thì trang đầu không cho biết số thật nên coi là đủ
  const many = specs => { const fm = specs.map((s, i) => ({ id: 'q' + i, status: 'ACTIVE', leads_count: s.count, created_time: s.old ? OLD : RECENT })), seen = [];
    const g = stubFetch([u => { const m = /\/q(\d+)\/leads$/.exec(u.host === 'graph.facebook.com' ? u.pathname : ''); if (!m) return; const s = specs[m[1]], lim = Number(u.searchParams.get('limit')) || 25; seen.push(lim);
      const rows = Array.from({ length: Math.min(s.visible, lim) }, (_, i) => ({ id: 'p' + i, created_time: RECENT })); return json(s.visible > lim || s.next ? { data: rows, paging: { next: 'https://graph.facebook.com/v25.0/q' + m[1] + '/leads?after=1&access_token=ptok' } } : { data: rows }); }, ...graphRoutes({ forms: fm })]); g.seen = seen; return g; };
  for (const [specs, ok, label] of [
    [[{ count: 454, visible: 454 }, { count: 12, visible: 3 }], true, 'một biểu mẫu nhỏ thiếu nhưng tổng gần đủ'],
    [Array.from({ length: 10 }, () => ({ count: 9, visible: 2 })), false, 'mười biểu mẫu mỗi cái chỉ thấy 2/9: tổng 20/90'],
    [[{ count: 800, visible: 3, old: true }, { count: 100, visible: 20 }], false, 'biểu mẫu cũ cũng chỉ thấy 3/800: phần thiếu của biểu mẫu mới là đáng kể so với tổng đọc được'],
    [[{ count: 454, visible: 2, next: true }], false, 'trang ngắn mà còn trang kế (Meta lọc bớt lead): chưa chứng minh được là đủ'],
    [[{ count: 454, visible: 0, next: true }], false, 'trang rỗng mà còn trang kế'],
    [[{ count: 800, visible: 800, old: true }, { count: 12, visible: 4 }], true, 'biểu mẫu cũ đọc đủ, biểu mẫu mới nhỏ thiếu: phần thiếu dưới 20% tổng'],
    [[{ count: 454, visible: 2 }, { count: 800, visible: 3, old: true }], false, 'cả hai biểu mẫu gần như không đọc được']]) {
    const g = many(specs);
    try { const s = (await L.checkLeads({ token: 'tok-test', accts: [], env: ENV })).steps.find(x => x.id === 'leads'); assert.equal(s.ok, ok, label + ' ' + JSON.stringify(s)); assert.ok(g.seen.length && g.seen.every(l => l === 25), 'giới hạn đọc thử: ' + g.seen); } finally { g.restore(); }
  }
  // kiểm tra kết nối cũ (một biểu mẫu): cùng điều kiện
  const probe = (count, visible) => { const fm = [{ id: 'f1', status: 'ACTIVE', leads_count: count, created_time: RECENT }];            // Meta chỉ cho thấy `visible` lead; trả theo limit của yêu cầu như Graph thật
    return stubFetch([u => { if (!(u.host === 'graph.facebook.com' && /\/f1\/leads$/.test(u.pathname))) return; const lim = Number(u.searchParams.get('limit')) || 25, all = Array.from({ length: visible }, (_, i) => ({ id: 'p' + i, created_time: RECENT })), rows = all.slice(0, lim);
      return json(visible > lim ? { data: rows, paging: { next: 'https://graph.facebook.com/v25.0/f1/leads?after=1&access_token=ptok' } } : { data: rows }); }, ...graphRoutes({ forms: fm })]); };
  for (const [count, visible, ok] of [[454, 2, false], [454, 454, true], [12, 3, false], [12, 12, true], [9, 2, true], [454, 300, true]]) {
    const g = probe(count, visible);
    try { const s = (await L.checkLeads({ token: 'tok-test', accts: [], env: ENV })).steps.find(x => x.id === 'leads'); assert.equal(s.ok, ok, count + '/' + visible + ' ' + JSON.stringify(s)); if (!ok) assert.match(s.text, /Development/); } finally { g.restore(); }
  }
});

test('runLeadSync: lần trước chỉ đọc được vài lead (Meta Development, biểu mẫu cũ hơn 80 ngày nên chốt chặn không canh) thì lần đọc đủ sau đó dựng lại cả cửa sổ: không mất các ngày 60–90 trước; lần đọc đủ liên tiếp thì vẫn đóng băng', async () => {
  const forms = [{ id: 'f1', status: 'ACTIVE', leads_count: 454, created_time: OLD }];
  const band = Array.from({ length: 12 }, (_, i) => glead('B' + i, A.addDays(TODAY, -80 + i), '111111', 'TS6-LEAD | Form', '0' + phn(3000 + i)));      // 60–90 ngày trước: vùng bị đóng băng
  const recent = Array.from({ length: 12 }, (_, i) => glead('R' + i, A.addDays(TODAY, -20 + i), '111111', 'TS6-LEAD | Form', '0' + phn(3100 + i)));
  const run = async (store, leads, today = TODAY) => { G.resetTokenCache(); const f = stubFetch([...googleRoutes(sheetData()), ...graphRoutes({ forms, leads })]); try { return await S.runLeadSync({ env: ENV, today, store }); } finally { f.restore(); G.resetTokenCache(); } };
  const store = memStore();
  assert.equal((await run(store, recent.slice(0, 2))).ok, true); assert.equal(Object.keys(store.docs.fbmatch.days).length, 2);          // lần đầu đọc dở: chỉ 2 lead, không chốt chặn nào canh được
  assert.equal((await run(store, band.concat(recent))).ok, true);
  const days = Object.keys(store.docs.fbmatch.days); assert.equal(days.length, 24, days.join(','));                                      // dựng lại cả cửa sổ: có đủ các ngày 60–90 trước
  assert.ok(days.includes(A.addDays(TODAY, -80))); assert.ok(globalThis.FBMatch.validate(store.docs.fbmatch).ok);
  // lần đọc đủ tiếp theo, rồi một lần đọc mà Meta đã hết một lead của vùng đóng băng: số đã chốt giữ nguyên (không dựng lại)
  assert.equal((await run(store, band.concat(recent), A.addDays(TODAY, 1))).ok, true);
  assert.equal((await run(store, band.slice(1).concat(recent), A.addDays(TODAY, 2))).ok, true); assert.equal(Object.keys(store.docs.fbmatch.days).length, 24);
});

test('runLeadSync: chốt chặn "Meta chỉ trả dưới một nửa" chỉ canh lần đọc đầu của mùa (mùa khác, số lưu không có ngày), tính theo tổng đọc được; có số lưu thì chốt chặn "drop" canh; dựng lại vì lần trước đọc dở đánh dấu mốc kém tin cậy khi còn ngày cũ', async () => {
  const M = globalThis.FBMatch, day = d => A.addDays(TODAY, -d);
  const prevDays = {}; for (let i = 1; i <= 25; i++) prevDays[day(i)] = { 111111: [1, 0, 0, 0, 0, 0, 0] };
  const prev = { v: 1, season: '2027–28', leads: { rows: 25 }, cov: { students: 5 }, days: prevDays, camps: { 111111: { n: 'TS6-LEAD | Form', p: 'TS6' } }, unmatchedPaid: {}, paidNoPhone: {}, syncedAt: '2026-11-01T00:00:00.000Z' };
  const thinForms = [{ id: 'f1', status: 'ACTIVE', leads_count: 454, created_time: RECENT }], thinRoutes = () => [...googleRoutes(sheetData()), ...graphRoutes({ forms: thinForms, leads: LEADS.slice(0, 2) })];
  const attempt = async (stored, routes = thinRoutes, opts = {}) => { G.resetTokenCache(); const store = memStore(stored), f = stubFetch(routes()); try { return { store, res: await S.runLeadSync(Object.assign({ env: ENV, today: TODAY, store }, opts)).then(r => ({ ok: r.ok }), e => ({ err: e })) }; } finally { f.restore(); G.resetTokenCache(); } };
  // lần đọc đầu của mùa mới (số lưu của mùa khác; số lưu không có ngày nào): bị chặn bởi "empty"
  for (const stored of [{ fbmatch: Object.assign({}, prev, { season: '2026–27' }) }, { fbmatch: Object.assign({}, prev, { days: {}, camps: {} }) }]) { const r = await attempt(stored); assert.ok(r.res.err && r.res.err.status === 409 && JSON.stringify(r.res.err.guards) === '["empty"]', JSON.stringify(r.res.err && r.res.err.message || r.res)); }
  // có số lưu cùng mùa: không còn là lần đọc đầu; số lead tụt thì chốt chặn "drop" canh (không phải "empty")
  const r2 = await attempt({ fbmatch: prev }); assert.ok(r2.res.err && JSON.stringify(r2.res.err.guards) === '["drop"]', JSON.stringify(r2.res.err && r2.res.err.guards));
  // tính theo tổng đọc được: biểu mẫu cũ đọc đủ 120 lead, biểu mẫu mới báo 12 lead nhưng chỉ trả 4 → phần thiếu (8) chưa tới 20% tổng: không dừng
  const gl = (id, d, i) => glead(id, d, '111111', 'TS6-LEAD | Form', '0' + phn(5000 + i)), oldLeads = Array.from({ length: 120 }, (_, i) => gl('O' + i, day(30 + (i % 5)), i)), newLeads = Array.from({ length: 4 }, (_, i) => gl('N' + i, day(3 + i), 200 + i));
  const forms2 = [{ id: 'o1', status: 'ACTIVE', leads_count: 120, created_time: OLD }, { id: 'r1', status: 'ACTIVE', leads_count: 12, created_time: RECENT }];
  const routes2 = () => [u => u.host === 'graph.facebook.com' && /\/o1\/leads$/.test(u.pathname) && json({ data: oldLeads }), u => u.host === 'graph.facebook.com' && /\/r1\/leads$/.test(u.pathname) && json({ data: newLeads }), ...googleRoutes(sheetData()), ...graphRoutes({ forms: forms2 })];
  const r3 = await attempt({}, routes2); assert.equal(r3.res.ok, true, JSON.stringify(r3.res.err && r3.res.err.message));
  // dựng lại vì lần trước đọc dở và còn một ngày cũ hơn cửa sổ lần này: ngày đó giữ, các ngày sau dựng lại, có mốc kém tin cậy (30 ngày đầu của cửa sổ không có vùng nhận ra)
  const band = Array.from({ length: 12 }, (_, i) => glead('B' + i, A.addDays(TODAY, -80 + i), '111111', 'TS6-LEAD | Form', '0' + phn(6000 + i))), recent = Array.from({ length: 12 }, (_, i) => glead('R' + i, A.addDays(TODAY, -20 + i), '111111', 'TS6-LEAD | Form', '0' + phn(6100 + i)));
  const oldForms = [{ id: 'f1', status: 'ACTIVE', leads_count: 454, created_time: OLD }];
  const run = async (store, leads, today) => { G.resetTokenCache(); const f = stubFetch([...googleRoutes(sheetData()), ...graphRoutes({ forms: oldForms, leads })]); try { return await S.runLeadSync({ env: ENV, today, store }); } finally { f.restore(); G.resetTokenCache(); } };
  const store = memStore();
  assert.equal((await run(store, [glead('X0', A.addDays(TODAY, -125), '111111', 'TS6-LEAD | Form', '0' + phn(6200)), glead('X1', A.addDays(TODAY, -45), '111111', 'TS6-LEAD | Form', '0' + phn(6201))], A.addDays(TODAY, -40))).ok, true);
  assert.equal((await run(store, band.concat(recent), TODAY)).ok, true);
  const m = store.docs.fbmatch; assert.ok(Object.keys(m.days).includes(A.addDays(TODAY, -125)) && Object.keys(m.days).includes(A.addDays(TODAY, -80))); assert.equal(m.lowCovUntil, A.addDays(TODAY, -50)); assert.ok(M.validate(m).ok);
});

test('maybeLeadSync: lỗi không rõ khi cron chạy (đọc Firestore, ghi khoá) được ghi log qua describeUnknown thay vì chỉ "xem log"', async () => {
  const lines = [], orig = console.error; console.error = (...a) => lines.push(a.join(' '));
  try {
    const store = { readDocs: async () => { throw Object.assign(new Error('14 UNAVAILABLE: No connection established'), { code: 14, name: 'FirestoreError' }); }, writeDocs: async () => {} };
    const r = await S.maybeLeadSync({ env: ENV, store }); assert.equal(r.ok, false); assert.equal(r.error, 'lỗi');
  } finally { console.error = orig; }
  assert.ok(lines.some(l => /\[leadsync\] cập nhật tự động lỗi:/.test(l) && /FirestoreError/.test(l) && /UNAVAILABLE/.test(l)), lines.join('\n')); assert.ok(!lines.some(l => /xem log/.test(l)));
});

test('checkLeads: biểu mẫu mới báo có lead mà Meta không trả lead nào thì báo đỏ kèm gợi ý chế độ Live / Leads access', async () => {
  const forms = [{ id: 'f1', status: 'ACTIVE', leads_count: 6, created_time: RECENT }];
  const f = stubFetch([u => u.host === 'graph.facebook.com' && /\/f1\/leads$/.test(u.pathname) && json({ data: [] }), ...graphRoutes({ forms })]);
  try { const s = (await L.checkLeads({ token: 'tok-test', accts: [], env: ENV })).steps.find(x => x.id === 'leads'); assert.equal(s.ok, false); assert.match(s.text, /Live/); assert.match(s.text, /Leads access/); } finally { f.restore(); }
});

test('fetchLeads: lead có campaign_id nhưng thiếu tên chiến dịch thì tra tên theo quảng cáo (chỉ khi cùng mã chiến dịch)', async () => {
  const noName = LEADS.slice(0, 2).map(l => { const o = Object.assign({}, l); delete o.campaign_name; return o; });
  const f = stubFetch([u => u.host === 'graph.facebook.com' && /^\/v[\d.]+\/?$/.test(u.pathname) && json({ adL1: { campaign_id: '111111', campaign: { id: '111111', name: 'TS6-LEAD | Tên tra' } }, adL2: { campaign_id: '999999', campaign: { id: '999999', name: 'Chiến dịch khác' } } }),
    ...graphRoutes({ leads: noName, forms: [{ id: 'f1', status: 'ACTIVE', leads_count: 2 }] })]);
  try { const r = await L.fetchLeads({ token: 'tok-test', accts: [], sinceDay: '2026-08-22', env: ENV }); assert.equal(r.leads[0].campaign_name, 'TS6-LEAD | Tên tra'); assert.equal(r.leads[1].campaign_name, undefined); assert.deepEqual(r.leads.map(l => l.campaign_id), ['111111', '111111']); } finally { f.restore(); }
});

test('graph/allPages: token có ký tự lạ bị chặn trước khi gọi và không lọt vào lỗi; thân rỗng là lỗi; allPages strict đòi mảng data', async () => {
  let called = 0; let f = stubFetch([() => { called++; return null; }]);
  try { await assert.rejects(() => graph('x', {}, 'tok\nbi-mat-xyz'), e => e.expose === true && e.meta.code === 'badtoken' && !/bi-mat-xyz/.test(e.message) && /META_ACCESS_TOKEN/.test(L.explainMeta(e, 'x'))); assert.equal(called, 0); } finally { f.restore(); }
  f = stubFetch([() => json({})]);
  try { await assert.rejects(() => allPages('x/leads', {}, 'tok-test', 5, { strict: true }), e => e.meta.code === 'badshape'); assert.deepEqual(await allPages('x/leads', {}, 'tok-test', 5), []); } finally { f.restore(); }
  const orig = globalThis.fetch; globalThis.fetch = async () => new Response('', { status: 200 });               // thân rỗng: thử lại rồi báo lỗi (không phải kết quả rỗng)
  try { await assert.rejects(() => graph('x', {}, 'tok-test'), e => e.expose === true && e.meta.code === 'timeout'); } finally { globalThis.fetch = orig; }
});

test('explainMeta và checkLeads: thiếu quyền, token hết hạn; kiểm tra từng bước không in nội dung lead', async () => {
  assert.match(L.explainMeta({ meta: { code: 190 } }, 'x'), /META_ACCESS_TOKEN/); assert.match(L.explainMeta({ meta: { code: 200, message: '(#200)' } }, 'lead'), /leads_retrieval/); assert.match(L.explainMeta({ meta: { code: 4 } }, 'lead'), /mã 4/);
  let f = stubFetch(graphRoutes());
  try {
    const r = await L.checkLeads({ token: 'tok-test', accts: [], env: ENV });
    assert.ok(r.steps.every(s => s.ok), JSON.stringify(r.steps)); assert.deepEqual(r.pages, [{ id: PAGE, name: 'Trang thử', forms: 2, leads: 10 }]);
    assert.ok(r.steps.some(s => s.id === 'leads' && /thành công/.test(s.text))); nope(JSON.stringify(r), PII);
  } finally { f.restore(); }
  f = stubFetch(graphRoutes({ perms: ['ads_read'], leadsError: { code: 200, message: '(#200) Requires leads_retrieval' } }));
  try {
    const r = await L.checkLeads({ token: 'tok-test', accts: [], env: ENV });
    assert.ok(r.steps.some(s => s.id === 'permissions' && !s.ok && /leads_retrieval/.test(s.text))); assert.ok(r.steps.some(s => s.id === 'leads' && !s.ok));
  } finally { f.restore(); }
  assert.deepEqual((await L.checkLeads({ token: '', accts: [], env: {} })).steps.map(s => s.ok), [false]);
});

/* ================= Điều phối ================= */
test('leadSyncConfig: cần cả ADMISSIONS_SHEET_ID và META_ACCESS_TOKEN', () => {
  assert.deepEqual(S.leadSyncConfig(ENV), { sheet: true, sheetSet: true, meta: true, ready: true });
  assert.deepEqual(S.leadSyncConfig({ META_ACCESS_TOKEN: 'x' }), { sheet: false, sheetSet: false, meta: true, ready: false });
  assert.deepEqual(S.leadSyncConfig({ ADMISSIONS_SHEET_ID: SHEET, META_ACCESS_TOKEN: '  ' }), { sheet: true, sheetSet: true, meta: false, ready: false });
  assert.deepEqual(S.leadSyncConfig({ ADMISSIONS_SHEET_ID: 'https://docs.google.com/khong-phai-sheet', META_ACCESS_TOKEN: 'x' }), { sheet: false, sheetSet: true, meta: true, ready: false });   // đã đặt nhưng sai dạng: khác với chưa đặt
});

test('runLeadSync: từ Google Sheet và lead đến số tổng hợp; chỉ ghi số, không có SĐT/email/họ tên; trạng thái ghi lại', async () => {
  G.resetTokenCache(); const store = memStore(), f = stubFetch([...googleRoutes(sheetData()), ...graphRoutes()]);
  try {
    const r = await S.runLeadSync({ by: 'admin', env: ENV, today: TODAY, store });
    assert.equal(r.ok, true); assert.deepEqual(r.stats, { rows: 6, parents: 6, matched: 4, students: 5, studentsWithPhone: 4, paidExt: 3, paidExtWithPhone: 2, forms: 2, pages: 1, skippedForms: 1, from: '2026-10-01' });
    const m = store.docs.fbmatch;
    assert.equal(m.season, '2027–28'); assert.equal(m.leads.dupFamily, 1); assert.equal(m.leads.internalOnly, 1); assert.ok(typeof m.syncedAt === 'string');
    assert.deepEqual(m.days['2026-10-01']['111111'], [1, 0, 0, 1, 1, 1, 1]); assert.deepEqual(m.days['2026-10-02']['111111'], [1, 0, 0, 1, 0, 1, 0]); assert.deepEqual(m.days['2026-10-06']['222222'], [1, 0, 0, 1, 1, 1, 1]);
    assert.deepEqual(m.days['2026-10-07']['111111'], [1, 1, 0, 0, 0, 0, 0]); assert.deepEqual(m.days['2026-10-09']['222222'], [1, 0, 0, 0, 0, 0, 0]); assert.deepEqual(m.days['2026-10-03']['333333'], [1, 0, 0, 1, 1, 0, 0]);          // lead của mẹ em 1: cũng là phụ huynh có con đã đóng phí, không thêm học sinh
    assert.deepEqual(m.paidNoPhone, { TS1: 1 }); assert.deepEqual(m.unmatchedPaid, {});
    assert.equal(store.docs.admissions.source, 'sheet'); assert.equal(store.docs.admissions.by, null); assert.equal(store.docs.admissions.total.reg, 5); assert.equal(store.docs.admissions.season, '2027–50'.replace('50', '28'));
    assert.equal(store.docs.leadsync.ok, true); assert.equal(store.docs.leadsync.runningUntil, null); assert.equal(store.docs.leadsync.by, 'admin');
    assert.ok(A.validate(store.docs.admissions).ok); assert.ok(globalThis.FBMatch.validate(m).ok);
    nope(allText(store), PII); nope(allText(store), ['0' + P.b1, '+84' + P.b1]);
    assert.ok(f.calls.every(c => c.init.method !== 'POST' || c.u.host === 'oauth2.googleapis.com'), 'không ghi gì lên Google/Meta');
    // chạy lại với cùng dữ liệu: cùng kết quả (ổn định, không cộng dồn)
    const before = JSON.stringify(Object.assign({}, m, { syncedAt: '' })); await S.runLeadSync({ by: 'cron', env: ENV, today: TODAY, store });
    assert.equal(JSON.stringify(Object.assign({}, store.docs.fbmatch, { syncedAt: '' })), before);
  } finally { f.restore(); G.resetTokenCache(); }
});

test('runLeadSync: lỗi ở bước nào thì ghi trạng thái lỗi đúng bước, giữ nguyên số liệu cũ; chưa cấu hình thì báo rõ', async () => {
  const old = { v: 1, season: '2027–28', leads: {}, cov: {}, days: {}, camps: {}, unmatchedPaid: {}, paidNoPhone: {}, syncedAt: '2026-11-01T00:00:00.000Z' };
  G.resetTokenCache(); let store = memStore({ fbmatch: old }), f = stubFetch([...googleRoutes({ metaError: { status: 403, error: { message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } }, values: {} }), ...graphRoutes()]);
  try {
    await assert.rejects(() => S.runLeadSync({ env: ENV, today: TODAY, store }), e => e.stage === 'sheet' && /Viewer/.test(e.message));
    assert.deepEqual(store.docs.fbmatch, old); assert.equal(store.docs.leadsync.ok, false); assert.equal(store.docs.leadsync.stage, 'sheet'); assert.match(store.docs.leadsync.error, /Viewer/); assert.equal(store.docs.leadsync.runningUntil, null);
  } finally { f.restore(); G.resetTokenCache(); }
  store = memStore({ fbmatch: old }); f = stubFetch([...googleRoutes(sheetData()), ...graphRoutes({ leadsError: { code: 200, message: '(#200) Requires leads_retrieval' } })]);
  try {
    await assert.rejects(() => S.runLeadSync({ env: ENV, today: TODAY, store }), e => e.stage === 'meta' && /leads_retrieval/.test(e.message));
    assert.deepEqual(store.docs.fbmatch, old); assert.equal(store.docs.leadsync.stage, 'meta'); assert.equal(store.docs.admissions, undefined);
  } finally { f.restore(); G.resetTokenCache(); }
  await assert.rejects(() => S.runLeadSync({ env: { META_ACCESS_TOKEN: 'x' }, today: TODAY, store: memStore() }), e => e.status === 501 && /ADMISSIONS_SHEET_ID/.test(e.message));
  await assert.rejects(() => S.runLeadSync({ env: { ADMISSIONS_SHEET_ID: SHEET }, today: TODAY, store: memStore() }), e => e.status === 501 && /META_ACCESS_TOKEN/.test(e.message));
});

test('runLeadSync: không ghi đè khi Meta trả ít lead hơn hẳn lần trước (trừ khi quản trị chọn ghi đè); đang chạy thì không chạy lần hai; khác mùa thì không gộp', async () => {
  const M = globalThis.FBMatch, day = d => A.addDays(TODAY, -d);
  const prevDays = {}; for (let i = 1; i <= 25; i++) prevDays[day(i)] = { 111111: [1, 0, 0, 0, 0, 0, 0] };
  const prev = { v: 1, season: '2027–28', leads: { rows: 25 }, cov: { students: 5 }, days: prevDays, camps: { 111111: { n: 'TS6-LEAD | Form', p: 'TS6' } }, unmatchedPaid: {}, paidNoPhone: {}, syncedAt: '2026-11-01T00:00:00.000Z' };
  assert.ok(M.validate(prev).ok, M.validate(prev).error);
  G.resetTokenCache(); let store = memStore({ fbmatch: prev }); const routes = () => [...googleRoutes(sheetData()), ...graphRoutes()];
  let f = stubFetch(routes());
  try {
    await assert.rejects(() => S.runLeadSync({ env: ENV, today: TODAY, store }), e => e.status === 409 && /thấp hơn hẳn/.test(e.message));
    assert.deepEqual(store.docs.fbmatch.days, prevDays);
    const r = await S.runLeadSync({ env: ENV, today: TODAY, store, force: true }); assert.equal(r.ok, true);
    assert.ok(store.docs.fbmatch.days['2026-10-01'] && Object.keys(store.docs.fbmatch.days).length >= 5);
  } finally { f.restore(); G.resetTokenCache(); }
  // khoá: đang có lần chạy khác
  store = memStore({ leadsync: { v: 1, runningUntil: new Date(Date.now() + 60000).toISOString() } }); f = stubFetch(routes());
  try { await assert.rejects(() => S.runLeadSync({ env: ENV, today: TODAY, store }), e => e.status === 409 && e.busy === true); assert.equal(f.calls.length, 0); assert.deepEqual(store.writes, []); } finally { f.restore(); }
  // khoá vô lý (năm 2100) là dữ liệu hỏng: không chặn mãi
  store = memStore({ leadsync: { v: 1, runningUntil: '2100-01-01T00:00:00.000Z' } }); G.resetTokenCache(); f = stubFetch(routes());
  try { assert.equal((await S.runLeadSync({ env: ENV, today: TODAY, store })).ok, true); } finally { f.restore(); G.resetTokenCache(); }
  // khoá đã quá hạn thì chạy được
  store = memStore({ leadsync: { v: 1, runningUntil: new Date(Date.now() - 60000).toISOString() } }); G.resetTokenCache(); f = stubFetch(routes());
  try { assert.equal((await S.runLeadSync({ env: ENV, today: TODAY, store })).ok, true); } finally { f.restore(); G.resetTokenCache(); }
  // khác mùa: không gộp số của mùa cũ
  store = memStore({ fbmatch: Object.assign({}, prev, { season: '2026–27' }) }); G.resetTokenCache(); f = stubFetch(routes());
  try { await S.runLeadSync({ env: ENV, today: TODAY, store }); assert.ok(!Object.keys(store.docs.fbmatch.days).some(d => d === day(25))); assert.equal(store.docs.fbmatch.season, '2027–28'); } finally { f.restore(); G.resetTokenCache(); }
  // hai mùa hợp lệ nhưng mùa mới KHÔNG phải mùa sau (cùng năm bắt đầu, gõ nhầm năm thứ hai): dừng, giữ số đã chốt; ghi đè thì có bản sao
  const stored = Object.assign({}, prev, { season: '2027–29' });
  store = memStore({ fbmatch: stored }); G.resetTokenCache(); f = stubFetch(routes());
  try {
    await assert.rejects(() => S.runLeadSync({ env: ENV, today: TODAY, store }), e => e.status === 409 && e.canForce === true && /không phải mùa sau/.test(e.message) && e.stage === 'sheet');
    assert.deepEqual(store.docs.fbmatch, stored); assert.equal(store.docs.fbmatch_prev, undefined);
    assert.equal((await S.runLeadSync({ env: ENV, today: TODAY, store, force: true })).ok, true); assert.equal(store.docs.fbmatch.season, '2027–28'); assert.deepEqual(store.docs.fbmatch_prev, stored);
  } finally { f.restore(); G.resetTokenCache(); }
});

test('maybeLeadSync (cho cron): bỏ qua khi chưa cấu hình hoặc còn mới; chạy khi đã cũ; lỗi không ném ra ngoài', async () => {
  assert.deepEqual(await S.maybeLeadSync({ env: {}, store: memStore() }), { skipped: 'chưa cấu hình' });
  const fresh = memStore({ leadsync: { v: 1, ok: true, at: new Date().toISOString() } });
  assert.deepEqual(await S.maybeLeadSync({ env: ENV, store: fresh }), { skipped: 'còn mới' }); assert.deepEqual(fresh.writes, []);
  const origErr = console.error; console.error = () => {};
  G.resetTokenCache(); const f = stubFetch([...googleRoutes({ metaError: { status: 404, error: { message: 'x' } }, values: {} })]);
  try {
    const stale = memStore({ leadsync: { v: 1, ok: true, at: '2026-01-01T00:00:00.000Z' } });
    const r = await S.maybeLeadSync({ env: ENV, store: stale }); assert.equal(r.ok, false); assert.match(r.error, /chưa chia sẻ/); assert.equal(r.stage, 'sheet');
  } finally { f.restore(); G.resetTokenCache(); console.error = origErr; }
});

test('checkSetup: báo từng bước cho quản trị — cột SĐT, độ phủ SĐT, Trang và quyền; không có nội dung dữ liệu', async () => {
  G.resetTokenCache(); const f = stubFetch([...googleRoutes(sheetData()), ...graphRoutes()]);
  try {
    const r = await S.checkSetup({ env: ENV, today: TODAY });
    assert.deepEqual(r.serviceAccount, { email: SA.client_email, projectId: SA.project_id }); assert.deepEqual(r.config, { sheet: true, sheetSet: true, meta: true, ready: true });
    const by = id => r.sheet.steps.find(s => s.id === id);
    assert.ok(by('read').ok && /DATA TUYỂN SINH/.test(by('read').text)); assert.ok(by('reg').ok); assert.ok(by('phones-reg').ok && /2 cột SĐT \("SĐT bố", "SĐT mẹ"\), 1 cột email \("Email phụ huynh"\)/.test(by('phones-reg').text), by('phones-reg').text);
    assert.equal(by('dates').ok, true); assert.match(by('dates').text, /4\/4 học sinh ngoài nội bộ \(100%\)/);
    assert.ok(by('paid-LỚP 10 2728 (ĐP)').ok && /1 cột SĐT/.test(by('paid-LỚP 10 2728 (ĐP)').text)); assert.equal(by('skipped').ok, false);
    assert.equal(by('coverage').ok, false); assert.match(by('coverage').text, /đã đóng phí có SĐT\/email: 2\/3 \(67%\)/);   // dưới 90%: chưa đáng tin
    assert.ok(r.meta.steps.some(s => s.id === 'pages' && s.ok)); nope(JSON.stringify(r), PII);
  } finally { f.restore(); G.resetTokenCache(); }
  const none = await S.checkSetup({ env: {}, today: TODAY });
  assert.equal(none.sheet.steps[0].ok, false); assert.equal(none.serviceAccount, null); assert.equal(none.meta.steps[0].ok, false);
});

test('runLeadSync: mùa tuyển sinh ghi nhầm trong Sheet (xa hôm nay, hoặc mất chữ mùa) không làm mất số đã gộp; sang mùa mới hợp lệ thì bắt đầu lại', async () => {
  const old = { v: 1, season: '2027–28', leads: {}, cov: {}, days: {}, camps: {}, unmatchedPaid: {}, paidNoPhone: {}, syncedAt: '2026-11-01T00:00:00.000Z' };
  const withHeader = h => { const d = sheetData(); d.values['Danh sách đăng ký'][1][3] = h; return d; };
  for (const [header, want] of [['Khối 31 32', /không khớp với ngày hôm nay/], ['Khối', /Không đọc được mùa tuyển sinh/]]) {
    G.resetTokenCache(); const store = memStore({ fbmatch: old }), f = stubFetch([...googleRoutes(withHeader(header)), ...graphRoutes()]);
    try {
      await assert.rejects(() => S.runLeadSync({ env: ENV, today: TODAY, store }), e => want.test(e.message) && e.stage === 'sheet' && e.status === 422);
      assert.deepEqual(store.docs.fbmatch, old); assert.equal(store.docs.admissions, undefined); assert.equal(store.docs.leadsync.ok, false); assert.equal(f.calls.filter(c => c.u.host === 'graph.facebook.com').length, 0, 'chưa gọi Meta khi Sheet sai mùa');
    } finally { f.restore(); G.resetTokenCache(); }
  }
  // lần đầu (chưa có số cũ) mà Sheet chưa ghi mùa: vẫn chạy được
  G.resetTokenCache(); let store = memStore(), f = stubFetch([...googleRoutes(withHeader('Khối')), ...graphRoutes()]);
  try { assert.equal((await S.runLeadSync({ env: ENV, today: TODAY, store })).ok, true); assert.equal(store.docs.fbmatch.season, ''); } finally { f.restore(); G.resetTokenCache(); }
  // sang mùa mới hợp lệ (đầu tháng 8/2027: mùa 2028–29): không gộp số mùa cũ
  G.resetTokenCache(); const prev = Object.assign({}, old, { season: '2027–28', days: { '2027-07-20': { 111111: [3, 0, 0, 0, 0, 0, 0] } }, camps: { 111111: { n: 'TS6-LEAD | Form', p: 'TS6' } }, from: '2027-07-20', to: '2027-07-20' });
  store = memStore({ fbmatch: prev }); f = stubFetch([...googleRoutes(withHeader('Khối 28 29')), ...graphRoutes()]);
  try { await S.runLeadSync({ env: ENV, today: '2027-08-05', store }); assert.equal(store.docs.fbmatch.season, '2028–29'); assert.equal(store.docs.fbmatch.days['2027-07-20'], undefined); } finally { f.restore(); G.resetTokenCache(); }
});

test('fetchLeads: một tài khoản quảng cáo không liệt kê được Trang thì dừng (không đọc lead của một phần các Trang); có META_PAGE_IDS thì không phụ thuộc bước này', async () => {
  const route = (u) => u.host === 'graph.facebook.com' && /\/act_(\d+)\/promote_pages$/.test(u.pathname) && (u.pathname.includes('895057262833914') ? json({ data: [{ id: PAGE, name: 'Trang thử' }] }) : json({ error: { code: 200, message: '(#200) Requires pages_show_list permission' } }, 403));
  let f = stubFetch([route, ...graphRoutes()]);
  try {
    await assert.rejects(() => L.fetchLeads({ token: 'tok-test', accts: ['895057262833914', '1870132100153072'], sinceDay: '2026-08-22', env: {} }), e => /pages_show_list/.test(e.message) && /META_PAGE_IDS/.test(e.message) && /1870132100153072/.test(e.message) && e.expose === true);
    assert.ok(f.calls.every(c => !/\/leads$/.test(c.u.pathname)), 'chưa đọc lead khi danh sách Trang chưa đủ');
    const chk = await L.checkLeads({ token: 'tok-test', accts: ['895057262833914', '1870132100153072'], env: {} });
    assert.ok(chk.steps.some(s => s.id === 'pages' && !s.ok && /META_PAGE_IDS/.test(s.text)));
    const ok = await L.fetchLeads({ token: 'tok-test', accts: ['895057262833914', '1870132100153072'], sinceDay: '2026-08-22', env: { META_PAGE_IDS: PAGE } }); assert.equal(ok.source, 'META_PAGE_IDS'); assert.equal(ok.leads.length, 6);
  } finally { f.restore(); }
});

test('readAdmissionsSheet: tab (ĐP) của mùa cũ để lại trong file không bị tải về (vẫn được báo là tab của mùa khác); giới hạn tab chỉ tính tab cùng mùa; tên tab có dấu nháy được rào đúng', async () => {
  const d = sheetData(); const old = ['LỚP 6 2627 (ĐP)', 'LỚP 10 2526 (ĐP)', "LỚP 1 2627 (ĐP)'x"]; for (const n of old) { d.meta.sheets.push({ properties: { sheetId: 50 + old.indexOf(n), title: n } }); d.values[n] = [[], ['MDT', 'HS nội bộ', 'Họ tên học sinh'], [1, '', NAMES[0]]]; }
  for (let i = 0; i < 40; i++) { const a = [25, 26, 29, 30, 31][i % 5]; d.meta.sheets.push({ properties: { sheetId: 100 + i, title: 'HB ' + a + (a + 1) + ' nhóm ' + i + ' (ĐP)' } }); }   // 40 tab ĐP của các mùa khác (2526, 2627, 2930…): trước đây vượt giới hạn 30 và làm hỏng cả lần cập nhật
  G.resetTokenCache(); let f = stubFetch(googleRoutes(d));
  try {
    const b = await G.readAdmissionsSheet(SHEET, { pickTabs: A.pickTabs, env: ENV });
    const asked = f.calls.filter(c => c.u.pathname.endsWith('values:batchGet')).flatMap(c => c.u.searchParams.getAll('ranges'));
    assert.deepEqual(asked, ["'Danh sách đăng ký'", "'LỚP 6 2728 (ĐP)'", "'LỚP 10 2728 (ĐP)'"]);
    const other = 2 + 40; assert.equal(b.otherSeasonTabs, other);
    assert.equal(b.paid.length, 2 + other); assert.equal(b.paid.filter(p => !p.rows.length).length, other);
    const ag = A.aggregate({ reg: b.reg, paid: b.paid, skipped: b.skipped, today: TODAY }); assert.ok(ag.ok); assert.equal(ag.summary.total.paid, 4);                  // 4 = 2 em ở tab ĐP + 2 em có Ngày đóng phí
    assert.ok(ag.summary.checks.paidTabsSkipped.length > 0);                                                                                           // aggregate vẫn báo có tab của mùa khác
  } finally { f.restore(); G.resetTokenCache(); }
  // tên tab có dấu nháy: nháy đơn được nhân đôi trong A1
  const d2 = sheetData(); d2.meta.sheets.push({ properties: { sheetId: 7, title: "LỚP 1 2728 (ĐP)" } }); d2.meta.sheets[1].properties.title = "LỚP 6 2728 (ĐP)";
  G.resetTokenCache(); f = stubFetch(googleRoutes(d2));
  try { await G.readAdmissionsSheet(SHEET, { pickTabs: n => ({ regName: 'Danh sách đăng ký', paidNames: ["O'Brien 2728 (ĐP)"], skipped: [] }), env: ENV }); const q = f.calls.filter(c => c.u.pathname.endsWith('values:batchGet')).flatMap(c => c.u.searchParams.getAll('ranges')); assert.ok(q.includes("'O''Brien 2728 (ĐP)'")); } finally { f.restore(); G.resetTokenCache(); }
});

test('Google: lấy token thử lại khi 429/5xx/mất kết nối rồi báo đúng loại lỗi; đọc Sheet thử lại 5xx và làm mới token khi 401; hết lượt thì báo lỗi rõ', async t => {
  G.setRetryScale(0.001); t.after(() => G.setRetryScale(1));                              // thu ngắn các lần chờ giữa các lần thử lại
  const tokenOk = { access_token: 'gtok', expires_in: 3600 };
  let n = 0; G.resetTokenCache();
  let f = stubFetch([u => u.host === 'oauth2.googleapis.com' && (++n < 3 ? json({ error: { code: 503, status: 'UNAVAILABLE' } }, 503) : json(tokenOk))]);
  try { assert.equal(await G.accessToken(ENV), 'gtok'); assert.equal(n, 3); } finally { f.restore(); G.resetTokenCache(); }
  n = 0; f = stubFetch([u => u.host === 'oauth2.googleapis.com' && (++n, json({ error: { code: 503, status: 'UNAVAILABLE' } }, 503))]);
  try { await assert.rejects(() => G.accessToken(ENV), e => /tạm thời lỗi/.test(e.message) && !/object Object/.test(e.message) && e.expose === true); assert.equal(n, 3); } finally { f.restore(); G.resetTokenCache(); }
  f = stubFetch([u => u.host === 'oauth2.googleapis.com' && json({ error: 'invalid_grant' }, 400)]);
  try { await assert.rejects(() => G.accessToken(ENV), /khoá service account/); } finally { f.restore(); G.resetTokenCache(); }
  await assert.rejects(() => G.accessToken({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify(Object.assign({}, SA, { private_key: 'khong phai khoa' })) }), e => /private_key/.test(e.message) && e.status === 501);
  // đọc Sheet: 401 một lần thì xin token mới rồi đọc lại
  G.resetTokenCache(); let tokens = 0, metaCalls = 0;
  f = stubFetch([u => u.host === 'oauth2.googleapis.com' && (++tokens, json(tokenOk)), u => u.host === 'sheets.googleapis.com' && u.pathname === '/v4/spreadsheets/' + SHEET && (++metaCalls === 1 ? json({ error: { code: 401, message: 'expired' } }, 401) : json({ properties: { title: 'x' }, sheets: [{ properties: { sheetId: 1, title: 'Ghi chú' } }] }))]);
  try { await assert.rejects(() => G.readAdmissionsSheet(SHEET, { pickTabs: A.pickTabs, env: ENV }), /Danh sách đăng ký/); assert.equal(tokens, 2); assert.equal(metaCalls, 2); } finally { f.restore(); G.resetTokenCache(); }
  // 500 hai lần rồi đọc được
  G.resetTokenCache(); metaCalls = 0;
  f = stubFetch([u => u.host === 'oauth2.googleapis.com' && json(tokenOk), u => u.host === 'sheets.googleapis.com' && (++metaCalls < 3 ? json({ error: { code: 500 } }, 500) : json({ properties: { title: 'x' }, sheets: [{ properties: { sheetId: 1, title: 'Ghi chú' } }] }))]);
  try { await assert.rejects(() => G.readAdmissionsSheet(SHEET, { pickTabs: A.pickTabs, env: ENV }), /Danh sách đăng ký/); assert.equal(metaCalls, 3); } finally { f.restore(); G.resetTokenCache(); }
  // 429 liên tục: báo giới hạn
  G.resetTokenCache(); f = stubFetch([u => u.host === 'oauth2.googleapis.com' && json(tokenOk), u => u.host === 'sheets.googleapis.com' && json({ error: { code: 429 } }, 429)]);
  try { await assert.rejects(() => G.readAdmissionsSheet(SHEET, { pickTabs: A.pickTabs, env: ENV }), e => /giới hạn/.test(e.message) && e.status === 429); } finally { f.restore(); G.resetTokenCache(); }
});

test('expandMerges không tạo dòng ảo dưới dòng dữ liệu cuối; sheetIdFrom nhận cả đường dẫn /u/1/d/', () => {
  const rows = [[], ['MDT', 'Chiến dịch'], [1, 'TS6'], [2, '']];
  G.expandMerges(rows, [{ startRowIndex: 2, endRowIndex: 40, startColumnIndex: 1, endColumnIndex: 2 }]);
  assert.equal(rows.length, 4); assert.equal(rows[3][1], 'TS6');
  assert.equal(G.sheetIdFrom('https://docs.google.com/spreadsheets/u/1/d/' + SHEET + '/edit'), SHEET); assert.equal(G.sheetIdFrom('https://docs.google.com/spreadsheets/d/' + SHEET), SHEET);
  const r = A.aggregate({ reg: [[], ['MDT', 'HS nội bộ', 'Họ tên học sinh', 'Khối 27 28', 'Chiến dịch'], [1, '', 'A', 'Khối 6', 'TS6']], paid: [{ name: 'X 2728 (ĐP)', rows: [[], ['MDT', 'HS nội bộ', 'Họ tên học sinh'], [1, '', 'A']] }], today: TODAY }); assert.equal(r.summary.checks.skippedReg, 0);
});

test('runLeadSync: Sheet đọc kém hẳn lần trước (mất tab ĐP, số học sinh tụt, phủ SĐT tụt, tỷ lệ nội bộ nhảy) thì không ghi đè và không đóng băng số hụt; ghi đè được khi quản trị xác nhận', async () => {
  // lần chạy khoẻ: lấy số đã gộp làm "lần trước"
  G.resetTokenCache(); let store = memStore(), f = stubFetch([...googleRoutes(sheetData()), ...graphRoutes()]);
  try { await S.runLeadSync({ env: ENV, today: TODAY, store }); } finally { f.restore(); G.resetTokenCache(); }
  const healthy = JSON.parse(JSON.stringify(store.docs)), tabKey = 'LỚP 6 2728 (ĐP)';
  assert.ok(healthy.admissions.paidSheets[tabKey] > 0);
  const degrade = {
    'tab ĐP bị xoá trống': d => { d.values[tabKey] = []; },
    'tab ĐP bị đổi tên': d => { d.meta.sheets[1].properties.title = 'Bản sao của ' + tabKey; d.values['Bản sao của ' + tabKey] = d.values[tabKey]; delete d.values[tabKey]; },
    'cột SĐT mất tiêu đề': d => { d.values['LỚP 10 2728 (ĐP)'][1][3] = 'Liên hệ'; d.values['Danh sách đăng ký'][1][5] = 'A'; d.values['Danh sách đăng ký'][1][6] = 'B'; d.values['Danh sách đăng ký'][1][7] = 'C'; }
  };
  for (const [name, fn] of Object.entries(degrade)) {
    const d = sheetData(); fn(d); G.resetTokenCache(); store = memStore(healthy); f = stubFetch([...googleRoutes(d), ...graphRoutes()]);
    try {
      await assert.rejects(() => S.runLeadSync({ env: ENV, today: TODAY, store }), e => e.status === 409 && e.canForce === true && /khác hẳn lần trước|không thấy số điện thoại/i.test(e.message) || e.status === 422, name);
      assert.deepEqual(store.docs.fbmatch, healthy.fbmatch, name); assert.deepEqual(store.docs.admissions, healthy.admissions, name); assert.equal(store.docs.leadsync.ok, false, name);
    } finally { f.restore(); G.resetTokenCache(); }
  }
  // quản trị xác nhận ghi đè: chạy được
  const d = sheetData(); degrade['tab ĐP bị xoá trống'](d); G.resetTokenCache(); store = memStore(healthy); f = stubFetch([...googleRoutes(d), ...graphRoutes()]);
  try { const r = await S.runLeadSync({ env: ENV, today: TODAY, store, force: true }); assert.equal(r.ok, true); assert.ok(!(tabKey in store.docs.admissions.paidSheets)); } finally { f.restore(); G.resetTokenCache(); }
});

test('runLeadSync: không có SĐT/email nào trong Sheet thì dừng với hướng dẫn (không ghi số 0); ID Sheet đã đặt nhưng sai dạng được báo đúng', async () => {
  const noPhone = sheetData(); noPhone.values['LỚP 10 2728 (ĐP)'][1][3] = 'Liên hệ'; noPhone.values['Danh sách đăng ký'][1][5] = 'A'; noPhone.values['Danh sách đăng ký'][1][6] = 'B'; noPhone.values['Danh sách đăng ký'][1][7] = 'C';
  G.resetTokenCache(); let store = memStore(), f = stubFetch([...googleRoutes(noPhone), ...graphRoutes()]);
  try { await assert.rejects(() => S.runLeadSync({ env: ENV, today: TODAY, store }), e => e.status === 422 && /Không thấy số điện thoại hay email/.test(e.message) && e.stage === 'sheet'); assert.equal(store.docs.fbmatch, undefined); assert.equal(f.calls.filter(c => c.u.host === 'graph.facebook.com').length, 0); } finally { f.restore(); G.resetTokenCache(); }
  await assert.rejects(() => S.runLeadSync({ env: Object.assign({}, ENV, { ADMISSIONS_SHEET_ID: 'khong phai sheet' }), today: TODAY, store: memStore() }), e => e.status === 501 && /không đúng dạng/.test(e.message));
});

test('degradedReasons: ngưỡng so với lần trước — tab ĐP mất, đăng ký/đóng phí giảm trên 30%, tỷ lệ nội bộ đổi trên 20 điểm, phủ SĐT giảm trên 20 điểm; mẫu nhỏ (dưới 20) không kết luận', () => {
  const sum = (reg, regInt, paid, sheets) => ({ total: { reg, regInt, paid, paidInt: 0 }, paidSheets: Object.fromEntries(sheets.map(s => [s, 1])) });
  const cov = (ext, extWithPhone, paidExt, paidExtWithPhone) => ({ ext, extWithPhone, paidExt, paidExtWithPhone });
  const base = sum(1000, 300, 800, ['LỚP 1 (ĐP)', 'LỚP 6 (ĐP)']), bc = cov(700, 600, 560, 540);
  assert.deepEqual(S.degradedReasons(base, sum(1000, 300, 800, ['LỚP 1 (ĐP)', 'LỚP 6 (ĐP)']), bc, cov(700, 600, 560, 540)), []);
  assert.deepEqual(S.degradedReasons(base, sum(1010, 290, 790, ['LỚP 1 (ĐP)', 'LỚP 6 (ĐP)', 'LỚP 10 (ĐP)']), bc, cov(705, 640, 560, 545)), []);                 // thêm tab, biến động nhỏ: ổn
  assert.match(S.degradedReasons(base, sum(1000, 300, 600, ['LỚP 1 (ĐP)']), bc, bc).join(';'), /không còn đọc được tab ĐP "LỚP 6 \(ĐP\)"/);
  assert.match(S.degradedReasons(base, sum(600, 180, 800, ['LỚP 1 (ĐP)', 'LỚP 6 (ĐP)']), bc, bc).join(';'), /đăng ký giảm từ 1000 xuống 600/);
  assert.match(S.degradedReasons(base, sum(1000, 300, 500, ['LỚP 1 (ĐP)', 'LỚP 6 (ĐP)']), bc, bc).join(';'), /đã đóng phí giảm từ 800 xuống 500/);
  assert.match(S.degradedReasons(base, sum(1000, 950, 800, ['LỚP 1 (ĐP)', 'LỚP 6 (ĐP)']), bc, bc).join(';'), /nội bộ đổi từ 30% sang 95%/);                           // cả cột HS nội bộ bỗng có giá trị
  assert.match(S.degradedReasons(base, sum(1000, 300, 800, ['LỚP 1 (ĐP)', 'LỚP 6 (ĐP)']), bc, cov(700, 100, 560, 540)).join(';'), /có SĐT\/email giảm từ 86% xuống 14%/);
  assert.match(S.degradedReasons(base, sum(1000, 300, 800, ['LỚP 1 (ĐP)', 'LỚP 6 (ĐP)']), bc, cov(700, 600, 560, 100)).join(';'), /đã đóng phí có SĐT\/email giảm/);
  assert.deepEqual(S.degradedReasons(sum(10, 2, 8, ['A (ĐP)']), sum(3, 3, 1, []), cov(10, 9, 8, 8), cov(3, 0, 1, 0)), [S.degradedReasons(sum(10, 2, 8, ['A (ĐP)']), sum(3, 3, 1, []), null, null)[0]]);   // mẫu dưới 20: chỉ còn lý do mất tab
  assert.deepEqual(S.degradedReasons(null, sum(1, 0, 1, []), null, cov(1, 1, 1, 1)), []);                                                           // chưa có số cũ: không so
  // cột ngày bị đổi tên/xoá: số cũ có cột ngày mà số mới không có, hoặc tỷ lệ học sinh có Ngày đăng ký tụt
  const dated = Object.assign({}, base, { hasRegDate: true, hasPaidDate: true }), same = Object.assign({}, sum(1000, 300, 800, ['LỚP 1 (ĐP)', 'LỚP 6 (ĐP)']), { hasRegDate: true, hasPaidDate: true });
  assert.deepEqual(S.degradedReasons(dated, same, bc, bc), []);
  assert.match(S.degradedReasons(dated, Object.assign({}, same, { hasRegDate: false }), bc, bc).join(';'), /cột Ngày đăng ký không còn đọc được/);
  assert.match(S.degradedReasons(dated, Object.assign({}, same, { hasPaidDate: false }), bc, bc).join(';'), /cột Ngày đóng phí không còn đọc được/);
  const dc = Object.assign({}, bc, { extWithRegDate: 690 });
  assert.match(S.degradedReasons(dated, same, dc, Object.assign({}, bc, { extWithRegDate: 100 })).join(';'), /có Ngày đăng ký giảm từ 99% xuống 14%/); assert.deepEqual(S.degradedReasons(dated, same, dc, Object.assign({}, bc, { extWithRegDate: 650 })), []);
});

test('maybeLeadSync: còn mới trong 12 giờ thì bỏ qua, quá 12 giờ hoặc lần trước lỗi thì chạy; chưa cấu hình thì bỏ qua êm', async () => {
  const hoursAgo = h => new Date(Date.now() - h * 3600000).toISOString();
  assert.deepEqual(await S.maybeLeadSync({ env: {}, store: memStore() }), { skipped: 'chưa cấu hình' });
  let store = memStore({ leadsync: { v: 1, ok: true, at: hoursAgo(11) } }), f = stubFetch([]);
  try { assert.deepEqual(await S.maybeLeadSync({ env: ENV, store }), { skipped: 'còn mới' }); assert.equal(f.calls.length, 0); } finally { f.restore(); }
  for (const prev of [{ v: 1, ok: true, at: hoursAgo(13) }, { v: 1, ok: false, at: hoursAgo(1) }]) {
    G.resetTokenCache(); store = memStore({ leadsync: prev }); f = stubFetch([...googleRoutes(sheetData()), ...graphRoutes()]);
    try { const r = await S.maybeLeadSync({ env: ENV, store, by: 'cron' }); assert.equal(r.ok, true); assert.equal(store.docs.leadsync.by, 'cron'); } finally { f.restore(); G.resetTokenCache(); }
  }
});

test('runLeadSync: lỗi bất ngờ được ghi log (tên, mã, thông điệp đã xoá dãy số dài và email) và trạng thái chỉ nói chung; dữ liệu cũ không bị ghi đè', async () => {
  G.resetTokenCache();
  const store = memStore(), realWrite = store.writeDocs;
  store.writeDocs = async d => { if (d.fbmatch) throw Object.assign(new TypeError('Cannot write ' + phn(9) + ' for ten.phu.huynh@example.com'), { code: 'RESOURCE_EXHAUSTED' }); return realWrite(d); };
  const logs = [], orig = console.error; console.error = (...a) => logs.push(a.join(' '));
  const f = stubFetch([...googleRoutes(sheetData()), ...graphRoutes()]);
  try { await assert.rejects(() => S.runLeadSync({ env: ENV, today: TODAY, store }), e => e instanceof TypeError); } finally { console.error = orig; f.restore(); G.resetTokenCache(); }
  assert.equal(logs.length, 1); assert.match(logs[0], /TypeError/); assert.match(logs[0], /RESOURCE_EXHAUSTED/); assert.match(logs[0], /bước write/);
  assert.ok(!/\d{6,}/.test(logs[0]) && !/example\.com|ten\.phu\.huynh/.test(logs[0]), logs[0]);
  assert.equal(store.docs.fbmatch, undefined); assert.equal(store.docs.leadsync.ok, false); assert.equal(store.docs.leadsync.stage, 'write'); assert.match(store.docs.leadsync.error, /Xem log/);
  nope(allText(store), PII);
});

test('readAdmissionsSheet: tab biểu đồ (sheetType OBJECT) có chữ ĐP không bị đọc; bộ lọc trường có sheetType', async () => {
  G.resetTokenCache(); const data = sheetData(); data.meta.sheets.push({ properties: { sheetId: 9, title: 'Biểu đồ ĐP', sheetType: 'OBJECT' } });
  const f = stubFetch(googleRoutes(data));
  try {
    const b = await G.readAdmissionsSheet(ENV.ADMISSIONS_SHEET_ID, { pickTabs: A.pickTabs, env: ENV });
    assert.ok(!b.tabs.includes('Biểu đồ ĐP')); assert.ok(!b.paid.some(p => p.name === 'Biểu đồ ĐP'));
    const asked = f.calls.filter(c => c.u.pathname.endsWith('values:batchGet')).flatMap(c => c.u.searchParams.getAll('ranges')); assert.ok(!asked.some(r => /Biểu đồ/.test(r)));
    assert.match(f.calls.find(c => c.u.pathname === '/v4/spreadsheets/' + SHEET).u.searchParams.get('fields'), /sheetType/);
  } finally { f.restore(); G.resetTokenCache(); }
});

test('runLeadSync: dòng ở tab ĐP không nối được với Danh sách đăng ký được đếm vào cov.unlinkedPaid (không có nội dung)', async () => {
  G.resetTokenCache(); const data = sheetData(); data.values['LỚP 6 2728 (ĐP)'].push([99, '', 'HỌC SINH CHƯA ĐĂNG KÝ']);
  const store = memStore(), f = stubFetch([...googleRoutes(data), ...graphRoutes()]);
  try { assert.equal((await S.runLeadSync({ env: ENV, today: TODAY, store })).ok, true); } finally { f.restore(); G.resetTokenCache(); }
  assert.equal(store.docs.fbmatch.cov.unlinkedPaid, 1); assert.ok(globalThis.FBMatch.validate(store.docs.fbmatch).ok); assert.equal(globalThis.FBMatch.attribution(store.docs.fbmatch).unlinkedPaid, 1);
  nope(allText(store), ['CHƯA ĐĂNG KÝ']);
});

test('checkSetup: tab (ĐP) của mùa khác bị bỏ qua có chủ ý thì không hiện ✗', async () => {
  G.resetTokenCache(); const data = sheetData(); data.meta.sheets.push({ properties: { sheetId: 8, title: 'LỚP 6 2627 (ĐP)' } }); data.values['LỚP 6 2627 (ĐP)'] = [[], ['MDT', 'Họ tên học sinh'], [1, 'X']];
  const f = stubFetch([...googleRoutes(data), ...graphRoutes()]);
  try {
    const r = await S.checkSetup({ env: ENV, today: TODAY }), old = r.sheet.steps.find(s => s.id === 'paid-LỚP 6 2627 (ĐP)');
    assert.ok(old && old.ok === true && /mùa khác/.test(old.text), JSON.stringify(old));
  } finally { f.restore(); G.resetTokenCache(); }
});

test('runLeadSync: nhiều chốt chặn cùng lúc được báo một lần đủ lý do (cờ ghi đè bỏ qua tất cả); lead không tra được chiến dịch thì dừng; đổi mùa thì giữ bản của mùa cũ', async () => {
  const M = globalThis.FBMatch, day = d => A.addDays(TODAY, -d);
  const prevDays = {}; for (let i = 1; i <= 25; i++) prevDays[day(i)] = { 111111: [1, 0, 0, 0, 0, 0, 0] };
  const prev = { v: 1, season: '2027–28', leads: { rows: 25 }, cov: { students: 5, ext: 5, extWithPhone: 5, paidExt: 3, paidExtWithPhone: 3, withPhone: 5, extWithRegDate: 5 }, days: prevDays, camps: { 111111: { n: 'TS6-LEAD | Form', p: 'TS6' } }, unmatchedPaid: {}, paidNoPhone: {}, syncedAt: '2026-11-01T00:00:00.000Z' };
  assert.ok(M.validate(prev).ok, M.validate(prev).error);
  // admissions cũ (40 học sinh, 3 tab ĐP) dựng bằng aggregate để hợp lệ: lần đọc này chỉ có 5 học sinh và 2 tab nên vừa ít lead hơn hẳn vừa mất tab
  const regRows = [[], ['MDT', 'HS nội bộ', 'Họ tên học sinh', 'Khối 27 28', 'Chiến dịch'], ...Array.from({ length: 40 }, (_, i) => [i + 1, i % 4 === 0 ? 7 : '', 'HS ' + i, 'Khối 6', 'TS6'])];
  const tab = (name, ids) => ({ name, rows: [[], ['MDT', 'HS nội bộ', 'Họ tên học sinh'], ...ids.map(i => [i, '', 'HS ' + (i - 1)])] });
  const ag = A.aggregate({ reg: regRows, paid: [tab('LỚP 6 2728 (ĐP)', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), tab('LỚP 10 2728 (ĐP)', [11, 12, 13, 14, 15]), tab('LỚP 99 2728 (ĐP)', [16, 17, 18, 19, 20, 21])], today: TODAY }); assert.ok(ag.ok, ag.error);
  const okAdm = A.validate(Object.assign({}, ag.summary, { uploadedAt: '2026-11-01T00:00:00.000Z', source: 'sheet', by: null })); assert.ok(okAdm.ok, okAdm.error);
  G.resetTokenCache(); let store = memStore({ fbmatch: prev, admissions: okAdm.summary }), f = stubFetch([...googleRoutes(sheetData()), ...graphRoutes()]);
  try {
    await assert.rejects(() => S.runLeadSync({ env: ENV, today: TODAY, store }), e => e.status === 409 && e.canForce === true && /thấp hơn hẳn lần trước/.test(e.message) && /Google Sheet đọc lần này khác hẳn/.test(e.message) && /không còn đọc được tab ĐP/.test(e.message));
  } finally { f.restore(); G.resetTokenCache(); }
});

test('runLeadSync: lead quảng cáo không tra được chiến dịch (Meta lỗi) thì dừng thay vì ghi vào "chưa rõ chiến dịch"; ghi đè được', async () => {
  const noCamp = Array.from({ length: 12 }, (_, i) => { const o = glead('Y' + i, '2026-10-0' + (1 + i % 5), '', '', '0' + phn(200 + i)); delete o.campaign_id; delete o.campaign_name; return o; });
  const routes = () => [u => u.host === 'graph.facebook.com' && /^\/v[\d.]+\/?$/.test(u.pathname) && json({ error: { code: 100, message: '(#100) lỗi tra cứu' } }, 400), ...googleRoutes(sheetData()), ...graphRoutes({ leads: noCamp, forms: [{ id: 'f1', status: 'ACTIVE', leads_count: 12 }] })];
  G.resetTokenCache(); let store = memStore(), f = stubFetch(routes());
  try {
    await assert.rejects(() => S.runLeadSync({ env: ENV, today: TODAY, store }), e => e.status === 409 && e.canForce === true && /Không tra được chiến dịch của 12\/12 lead/.test(e.message) && e.stage === 'meta');
    assert.equal(store.docs.fbmatch, undefined);
  } finally { f.restore(); G.resetTokenCache(); }
  store = memStore(); G.resetTokenCache(); f = stubFetch(routes());
  try { assert.equal((await S.runLeadSync({ env: ENV, today: TODAY, store, force: true })).ok, true); assert.ok(store.docs.fbmatch.days); } finally { f.restore(); G.resetTokenCache(); }
});

test('runLeadSync: đổi sang mùa sau thì số của mùa cũ được giữ ở fbmatch_<mùa> (và /api/data không trả ra)', async () => {
  const M = globalThis.FBMatch, old = { v: 1, season: '2026–27', leads: { rows: 3 }, cov: { students: 5 }, days: { '2026-06-10': { 111111: [3, 0, 0, 1, 1, 1, 1] } }, camps: { 111111: { n: 'TS6-LEAD | Form', p: 'TS6' } }, unmatchedPaid: {}, paidNoPhone: {}, syncedAt: '2026-07-01T00:00:00.000Z' };
  assert.ok(M.validate(old).ok, M.validate(old).error);
  G.resetTokenCache(); const store = memStore({ fbmatch: old }), f = stubFetch([...googleRoutes(sheetData()), ...graphRoutes()]);
  try {
    assert.equal((await S.runLeadSync({ env: ENV, today: TODAY, store })).ok, true);
    assert.equal(store.docs.fbmatch.season, '2027–28'); assert.deepEqual(store.docs.fbmatch_202627, old); assert.deepEqual(store.docs.fbmatch_prev, old);
    const { checkedMatchDocs } = await import('../server/scope.js'); const out = await checkedMatchDocs(JSON.parse(JSON.stringify(store.docs))); assert.equal(out.fbmatch_202627, undefined); assert.equal(out.fbmatch_prev, undefined); assert.ok(out.fbmatch);
  } finally { f.restore(); G.resetTokenCache(); }
});

test('fetchLeads: biểu mẫu có leads_count rỗng hoặc thiếu vẫn được đọc; chỉ bỏ khi báo đúng 0', async () => {
  for (const [cnt, reads] of [[null, true], ['', true], [undefined, true], [0, false], ['0', false], [5, true]]) {
    const forms = [{ id: 'f1', status: 'ACTIVE', leads_count: cnt }]; let read = false;
    const f = stubFetch([u => { if (u.host === 'graph.facebook.com' && /\/f1\/leads$/.test(u.pathname)) read = true; return null; }, ...graphRoutes({ forms })]);
    try { await L.fetchLeads({ token: 'tok-test', accts: [], sinceDay: '2026-08-22', env: ENV }); } finally { f.restore(); }
    assert.equal(read, reads, 'leads_count = ' + JSON.stringify(cnt));
  }
});

test('runLeadSync: khi Sheet vừa đủ SĐT (cổng độ phủ mở) thì các ngày đã chốt trong khoảng lead đọc được được tính lại, ngày cũ hơn giữ nguyên kèm mốc lowCovUntil; không cải thiện thì số đã chốt giữ nguyên', async () => {
  const M = globalThis.FBMatch, TODAY2 = '2026-12-20';                                  // mốc chốt = 21/10: các ngày lead 01–09/10 nằm trong vùng đã chốt
  const prevCov = { students: 5, withPhone: 3, ext: 4, extWithPhone: 2, extWithRegDate: 4, paidExt: 3, paidExtWithPhone: 1, paidByProg: {} };
  const prev = { v: 1, season: '2027–28', leads: { rows: 3 }, cov: prevCov, days: { '2026-08-25': { 111111: [7, 0, 0, 2, 1, 2, 1] }, '2026-10-01': { 111111: [9, 0, 0, 1, 0, 1, 0] } }, camps: { 111111: { n: 'TS6-LEAD | Form', p: 'TS6' } }, unmatchedPaid: {}, paidNoPhone: {}, winFrom: '2026-08-25', syncedAt: '2026-12-19T00:00:00.000Z' };
  assert.ok(M.validate(prev).ok, M.validate(prev).error);
  const improved = sheetData(); improved.values['Danh sách đăng ký'][6][5] = '0' + phn(40);              // học sinh 5 có SĐT: 4/4 học sinh ngoài nội bộ có SĐT
  let store = memStore({ fbmatch: prev }); G.resetTokenCache(); let f = stubFetch([...googleRoutes(improved), ...graphRoutes()]);
  try {
    assert.equal((await S.runLeadSync({ env: ENV, today: TODAY2, store })).ok, true);
    const m = store.docs.fbmatch;
    assert.deepEqual(m.days['2026-10-01']['111111'], [1, 0, 0, 1, 1, 1, 1]);          // tính lại theo Sheet mới (trước đó là số hụt [9,…])
    assert.deepEqual(m.days['2026-08-25']['111111'], [7, 0, 0, 2, 1, 2, 1]);           // cũ hơn khoảng lead đọc được: giữ nguyên
    assert.equal(m.lowCovUntil, '2026-10-31'); assert.ok(M.validate(m).ok);                // 30 ngày đầu cửa sổ đọc chưa có vùng nhận ra phụ huynh từ trước
  } finally { f.restore(); G.resetTokenCache(); }
  // Sheet không đổi (vẫn thiếu SĐT như lần trước): không tính lại, số đã chốt giữ nguyên, không có mốc
  store = memStore({ fbmatch: prev }); G.resetTokenCache(); f = stubFetch([...googleRoutes(sheetData()), ...graphRoutes()]);
  try {
    assert.equal((await S.runLeadSync({ env: ENV, today: TODAY2, store })).ok, true);
    assert.deepEqual(store.docs.fbmatch.days['2026-10-01']['111111'], [9, 0, 0, 1, 0, 1, 0]); assert.equal(store.docs.fbmatch.lowCovUntil, undefined);
  } finally { f.restore(); G.resetTokenCache(); }
});

test('checkSetup: tab (ĐP) của mùa hiện tại bị trống vẫn báo ✗ (chỉ tab của mùa khác mới được miễn); bước độ phủ chỉ xanh khi cả học sinh ngoài nội bộ lẫn học sinh đã đóng phí đủ 90% SĐT/email', async () => {
  G.resetTokenCache(); const data = sheetData(); data.meta.sheets.push({ properties: { sheetId: 8, title: 'LỚP 6 2627 (ĐP)' } }, { properties: { sheetId: 9, title: 'LỚP 7 2728 (ĐP)' } });
  data.values['LỚP 6 2627 (ĐP)'] = [[], ['MDT', 'Họ tên học sinh'], [1, 'X']]; data.values['LỚP 7 2728 (ĐP)'] = [];                      // tab mùa này nhưng trống
  const f = stubFetch([...googleRoutes(data), ...graphRoutes()]);
  try {
    const r = await S.checkSetup({ env: ENV, today: TODAY }), by = id => r.sheet.steps.find(s => s.id === id);
    assert.equal(by('paid-LỚP 6 2627 (ĐP)').ok, true); assert.equal(by('paid-LỚP 7 2728 (ĐP)').ok, false);
    assert.equal(by('coverage').ok, false);
  } finally { f.restore(); G.resetTokenCache(); }
  // học sinh đã đóng phí đủ 100% SĐT nhưng học sinh ngoài nội bộ chỉ 80% (một em chưa đóng phí thiếu SĐT): số đăng ký bị ẩn nên bước độ phủ chưa đạt; đủ cả hai thì đạt
  const mk = withGap => { const d = sheetData(); d.values['Danh sách đăng ký'][6][5] = '0' + phn(40); if (withGap) d.values['Danh sách đăng ký'].push([6, '', 'HỌC SINH SÁU', 'Khối 1', 'TS1', '', '', '', ser('2026-10-10'), '']); else d.values['Danh sách đăng ký'].push([6, '', 'HỌC SINH SÁU', 'Khối 1', 'TS1', '0' + phn(41), '', '', ser('2026-10-10'), '']); return d; };
  for (const [gap, want] of [[true, false], [false, true]]) {
    G.resetTokenCache(); const g = stubFetch([...googleRoutes(mk(gap)), ...graphRoutes()]);
    try { const r = await S.checkSetup({ env: ENV, today: TODAY }); assert.equal(r.sheet.steps.find(s => s.id === 'coverage').ok, want, JSON.stringify(r.sheet.steps.find(s => s.id === 'coverage'))); } finally { g.restore(); G.resetTokenCache(); }
  }
});

test('runLeadSync: ghi đè theo mã chốt chặn — chỉ chốt chặn đã xác nhận mới bị bỏ qua, chốt chặn khác vẫn dừng; true là tất cả', async () => {
  const M = globalThis.FBMatch, day = d => A.addDays(TODAY, -d);
  const prevDays = {}; for (let i = 1; i <= 25; i++) prevDays[day(i)] = { 111111: [1, 0, 0, 0, 0, 0, 0] };
  const prev = { v: 1, season: '2027–28', leads: { rows: 25 }, cov: { students: 5 }, days: prevDays, camps: { 111111: { n: 'TS6-LEAD | Form', p: 'TS6' } }, unmatchedPaid: {}, paidNoPhone: {}, syncedAt: '2026-11-01T00:00:00.000Z' };
  assert.ok(M.validate(prev).ok, M.validate(prev).error);
  const forms = [{ id: 'f1', status: 'ACTIVE', leads_count: 6, created_time: RECENT }];
  const routes = empty => [...googleRoutes(sheetData()), ...(empty ? [u => u.host === 'graph.facebook.com' && /\/f1\/leads$/.test(u.pathname) && json({ data: [] })] : []), ...graphRoutes({ forms })];
  const run = async (force, empty) => { G.resetTokenCache(); const store = memStore({ fbmatch: prev }), f = stubFetch(routes(empty)); try { return await S.runLeadSync({ env: ENV, today: TODAY, store, force }).then(r => ({ ok: r.ok, store }), e => ({ err: e, store })); } finally { f.restore(); G.resetTokenCache(); } };
  // đọc ít lead hơn hẳn: chốt chặn "drop"
  let r = await run(undefined, false); assert.deepEqual(r.err.guards, ['drop']); assert.equal(r.err.canForce, true);
  r = await run(['sheet'], false); assert.deepEqual(r.err.guards, ['drop']);                      // xác nhận chốt chặn khác thì vẫn dừng
  r = await run(['drop'], false); assert.equal(r.ok, true);
  r = await run(true, false); assert.equal(r.ok, true);
  r = await run(['not-a-guard', 5, null], false); assert.deepEqual(r.err.guards, ['drop']);       // mã lạ bị bỏ
  // Meta không trả lead nào dù biểu mẫu mới báo có: chốt chặn "empty" đứng trước, xác nhận "drop" không đủ
  r = await run(['drop'], true); assert.deepEqual(r.err.guards, ['empty']);
  r = await run(['empty'], true); assert.deepEqual(r.err.guards, ['drop']);                       // qua "empty" thì gặp tiếp "drop" (số lead tụt vì đọc rỗng)
  r = await run(['empty', 'drop'], true); assert.equal(r.ok, true);
});

test('runLeadSync: lần trước không có ngày nào (đọc rỗng) không chốt lịch sử — lần sau vẫn giữ các ngày 60–90 còn đọc được; số lưu không đọc được được ghi đè thì giữ một bản ở fbmatch_invalid', async () => {
  const M = globalThis.FBMatch, TODAY2 = '2026-12-20';                                              // 01–09/10 đã nằm ngoài 60 ngày
  const empty = { v: 1, season: '2027–28', leads: {}, cov: { students: 5, withPhone: 3, ext: 4, extWithPhone: 3, extWithRegDate: 4, paidExt: 3, paidExtWithPhone: 2, paidByProg: {} }, days: {}, camps: {}, unmatchedPaid: {}, paidNoPhone: {}, syncedAt: '2026-12-19T00:00:00.000Z' };   // cùng độ phủ với lần đọc sau: không có "độ phủ tăng" để tính lại thay
  assert.ok(M.validate(empty).ok, M.validate(empty).error);
  G.resetTokenCache(); let store = memStore({ fbmatch: empty }), f = stubFetch([...googleRoutes(sheetData()), ...graphRoutes()]);
  try { assert.equal((await S.runLeadSync({ env: ENV, today: TODAY2, store })).ok, true); assert.ok(store.docs.fbmatch.days['2026-10-01'], 'phải còn ngày 01/10'); } finally { f.restore(); G.resetTokenCache(); }
  const bad = { v: 1, season: '2027–28', days: { '2026-10-01': { 111111: [1, 5, 5, 5, 5, 5, 5] } }, camps: { 111111: { n: 'x', p: 'TS6' } }, marker: 'ban-cu' };
  assert.equal(M.validate(bad).ok, false);
  store = memStore({ fbmatch: bad }); G.resetTokenCache(); f = stubFetch([...googleRoutes(sheetData()), ...graphRoutes()]);
  try {
    await assert.rejects(() => S.runLeadSync({ env: ENV, today: TODAY, store }), e => e.status === 409 && e.canForce === true && JSON.stringify(e.guards) === '["stored"]');
    assert.equal(store.docs.fbmatch_invalid, undefined);
    assert.equal((await S.runLeadSync({ env: ENV, today: TODAY, store, force: ['stored'] })).ok, true); assert.deepEqual(store.docs.fbmatch_invalid, bad); assert.ok(M.validate(store.docs.fbmatch).ok);
  } finally { f.restore(); G.resetTokenCache(); }
});

test('fetchLeads/checkLeads: Trang tự tìm ra mà token không đọc được thì nói cách loại ra bằng META_PAGE_IDS; kiểm tra kết nối đọc thử mọi biểu mẫu có lead và bỏ qua biểu mẫu lưu trữ chắc chắn không đọc được như lần cập nhật thật', async () => {
  const PAGE2 = ['777', '000', '222'].join('');
  const routes = [u => u.host === 'graph.facebook.com' && /\/act_895057262833914\/promote_pages$/.test(u.pathname) && json({ data: [{ id: PAGE, name: 'Trang trường' }, { id: PAGE2, name: 'Trang khác' }] }),
    u => u.host === 'graph.facebook.com' && u.pathname.endsWith('/' + PAGE2) && json({ error: { code: 100, message: '(#100) Unsupported get request' } }, 400), ...graphRoutes()];
  let f = stubFetch(routes);
  try {
    await assert.rejects(() => L.fetchLeads({ token: 'tok-test', accts: ['895057262833914'], sinceDay: '2026-08-22', env: {} }), e => e.expose === true && /META_PAGE_IDS/.test(e.message));
    const chk = await L.checkLeads({ token: 'tok-test', accts: ['895057262833914'], env: {} }); assert.match(chk.steps.find(s => s.id === 'page-' + PAGE2).text, /META_PAGE_IDS/);
  } finally { f.restore(); }
  // META_PAGE_IDS đã đặt: không thêm gợi ý (lỗi Trang là lỗi thật)
  f = stubFetch([u => u.host === 'graph.facebook.com' && u.pathname.endsWith('/' + PAGE) && json({ error: { code: 100, message: '(#100) Unsupported get request' } }, 400)]);
  try { await assert.rejects(() => L.fetchLeads({ token: 'tok-test', accts: [], sinceDay: '2026-08-22', env: ENV }), e => !/đặt biến META_PAGE_IDS/.test(e.message)); } finally { f.restore(); }
  // kiểm tra kết nối: biểu mẫu mới (không phải biểu mẫu đầu tiên) bị Meta trả rỗng cũng báo đỏ; biểu mẫu lưu trữ đọc lỗi (#200) không làm đỏ
  const forms = [{ id: 'f2', status: 'ARCHIVED', leads_count: 4, created_time: OLD }, { id: 'f9', status: 'ACTIVE', leads_count: 50, created_time: OLD }, { id: 'f1', status: 'ACTIVE', leads_count: 6, created_time: RECENT }];
  f = stubFetch([u => u.host === 'graph.facebook.com' && /\/f9\/leads$/.test(u.pathname) && json({ data: [] }), ...graphRoutes({ forms })]);
  try { const s = (await L.checkLeads({ token: 'tok-test', accts: [], env: ENV })).steps.find(x => x.id === 'leads'); assert.equal(s.ok, true, JSON.stringify(s)); } finally { f.restore(); }
  f = stubFetch([u => u.host === 'graph.facebook.com' && /\/f1\/leads$/.test(u.pathname) && json({ data: [] }), u => u.host === 'graph.facebook.com' && /\/f9\/leads$/.test(u.pathname) && json({ data: [] }), ...graphRoutes({ forms })]);
  try { const s = (await L.checkLeads({ token: 'tok-test', accts: [], env: ENV })).steps.find(x => x.id === 'leads'); assert.equal(s.ok, false); assert.match(s.text, /Live/); } finally { f.restore(); }
});

test('safelog: log lỗi bất ngờ không còn dãy chữ số, ngày, số điện thoại viết cách, email hay chuỗi trong ngoặc kép; api/leadsync.js dùng nó thay vì in nguyên lỗi', async () => {
  const k = phn(5), grouped = '0' + k.slice(0, 2) + ' ' + k.slice(2, 5) + ' ' + k.slice(5);                                 // số điện thoại giả viết cách nhóm, dựng lúc chạy
  const e = new TypeError('cannot write record "Nguyen Van A" ' + grouped + ' sinh 12/03/2015 ten.phu.huynh@example.com id 20260001'); e.code = 'EWRITE';
  const line = describeUnknown(e);
  assert.match(line, /TypeError \| EWRITE/); assert.ok(!/Nguyen|12\/03|2015|example\.com|20260001/.test(line) && !line.includes(k.slice(2, 5)) && !line.includes(grouped.slice(0, 5)), line);
  assert.equal(scrub('lỗi tại hàng (reading \'x\')'), 'lỗi tại hàng (reading \'x\')');                          // thông báo kỹ thuật không chứa dữ liệu vẫn đọc được
  const src = fs.readFileSync(new URL('../api/leadsync.js', import.meta.url), 'utf8'); assert.match(src, /describeUnknown\(e\)/); assert.ok(!/console\.error\('\[leadsync\]', e && e\.expose \? e\.message : e\)/.test(src));
});

test('runLeadSync: sau một đợt gián đoạn, các ngày còn sống ở lần chạy tốt cuối được tính lại (giữ 14 ngày đầu cửa sổ làm vùng nhận ra); không gián đoạn thì số đã chốt giữ nguyên', async () => {
  const M = globalThis.FBMatch, TODAY2 = '2026-12-20', L16 = glead('G1', '2026-10-16', '111111', 'TS6-LEAD | Form', '0' + P.p3);               // 16/10: nằm giữa "mốc chốt hôm nay" (21/10) và mốc chốt của lần chạy tốt cuối (11/09 → bị chặn ở 15/10 vì vùng nhận ra)
  const cov = { students: 5, withPhone: 3, ext: 4, extWithPhone: 3, extWithRegDate: 4, paidExt: 3, paidExtWithPhone: 2, paidByProg: {} };
  const mkPrev = syncedAt => ({ v: 1, season: '2027–28', leads: { rows: 3 }, cov, days: { '2026-10-16': { 111111: [9, 0, 0, 0, 0, 0, 0] } }, camps: { 111111: { n: 'TS6-LEAD | Form', p: 'TS6' } }, unmatchedPaid: {}, paidNoPhone: {}, winFrom: '2026-10-01', syncedAt });
  const run = async syncedAt => { const prev = mkPrev(syncedAt); assert.ok(M.validate(prev).ok, M.validate(prev).error); G.resetTokenCache(); const store = memStore({ fbmatch: prev }), f = stubFetch([...googleRoutes(sheetData()), ...graphRoutes({ leads: [LEADS[0], L16], forms: [{ id: 'f1', status: 'ACTIVE', leads_count: 2 }] })]);
    try { await S.runLeadSync({ env: ENV, today: TODAY2, store }); return store.docs.fbmatch; } finally { f.restore(); G.resetTokenCache(); } };
  assert.notDeepEqual((await run('2026-11-10T00:00:00.000Z')).days['2026-10-16']['111111'], [9, 0, 0, 0, 0, 0, 0]);          // gián đoạn 40 ngày: tính lại
  assert.deepEqual((await run('2026-12-19T00:00:00.000Z')).days['2026-10-16']['111111'], [9, 0, 0, 0, 0, 0, 0]);          // chạy hằng ngày: giữ số đã chốt
});

/* ---- bộ kiểm thử bổ sung cho logic prev/next/độ phủ tăng/mốc/lưu trữ (bắt các đột biến mà bộ trên bỏ sót) ---- */
{
  const M = globalThis.FBMatch, TODAY2 = '2026-12-20', dayOf = (base, n) => A.addDays(base, n);
  const run = (store, o = {}) => S.runLeadSync(Object.assign({ env: ENV, today: TODAY, store }, o));
  const withNet = async (sheet, graphCfg, fn) => { G.resetTokenCache(); const f = stubFetch([...googleRoutes(sheet), ...graphRoutes(graphCfg)]); try { return await fn(); } finally { f.restore(); G.resetTokenCache(); } };
  const prevCov = { students: 5, withPhone: 3, ext: 4, extWithPhone: 2, extWithRegDate: 4, paidExt: 3, paidExtWithPhone: 1, paidByProg: {} };
  const mkPrev = (extra = {}) => Object.assign({ v: 1, season: '2027–28', leads: { rows: 3 }, cov: prevCov, days: { '2026-08-25': { 111111: [7, 0, 0, 2, 1, 2, 1] }, '2026-10-01': { 111111: [9, 0, 0, 1, 0, 1, 0] } }, camps: { 111111: { n: 'TS6-LEAD | Form', p: 'TS6' } }, unmatchedPaid: {}, paidNoPhone: {}, winFrom: '2026-08-25', syncedAt: '2026-12-19T00:00:00.000Z' }, extra);
  const improved = () => { const d = sheetData(); d.values['Danh sách đăng ký'][6][5] = '0' + phn(40); return d; };

  test('mốc lowCovUntil: còn nguyên ở lần chạy thường kế tiếp; không có mốc khi không còn ngày cũ nào được giữ; lần tăng độ phủ sau đẩy mốc tới, không lùi', async () => {
    let store = memStore({ fbmatch: mkPrev() });
    await withNet(improved(), {}, async () => { await run(store, { today: TODAY2 }); assert.equal(store.docs.fbmatch.lowCovUntil, '2026-10-31'); await run(store, { today: dayOf(TODAY2, 1) }); });
    assert.equal(store.docs.fbmatch.lowCovUntil, '2026-10-31'); assert.ok(M.validate(store.docs.fbmatch).ok);
    store = memStore({ fbmatch: mkPrev({ days: { '2026-10-01': { 111111: [9, 0, 0, 1, 0, 1, 0] } }, winFrom: '2026-10-01' }) });
    await withNet(improved(), {}, async () => { await run(store, { today: TODAY2 }); }); assert.equal(store.docs.fbmatch.lowCovUntil, undefined);
    store = memStore({ fbmatch: mkPrev({ lowCovUntil: '2026-12-01' }) }); await withNet(improved(), {}, async () => { await run(store, { today: TODAY2 }); }); assert.equal(store.docs.fbmatch.lowCovUntil, '2026-12-01');
    store = memStore({ fbmatch: mkPrev({ lowCovUntil: '2026-09-01' }) }); await withNet(improved(), {}, async () => { await run(store, { today: TODAY2 }); }); assert.equal(store.docs.fbmatch.lowCovUntil, '2026-10-31');
  });
  test('số lưu không có mùa vẫn được gộp; không ghi fbmatch_<mùa> khi mùa không đổi; có syncedAt; admissions của mùa khác không dùng để so', async () => {
    let store = memStore({ fbmatch: mkPrev({ season: '' }) });
    await withNet(sheetData(), {}, async () => { await run(store, { today: TODAY2 }); });
    assert.deepEqual(store.docs.fbmatch.days['2026-08-25']['111111'], [7, 0, 0, 2, 1, 2, 1]);
    assert.equal(Object.keys(store.docs).filter(k => /^fbmatch_\d/.test(k)).length, 0); assert.ok(store.docs.fbmatch_prev); assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(store.docs.fbmatch.syncedAt));
    const s0 = memStore(); await withNet(sheetData(), {}, async () => { await run(s0); });
    const adm = JSON.parse(JSON.stringify(s0.docs.admissions)); adm.season = '2026–27'; adm.total = { reg: 500, regInt: 0, paid: 400, paidInt: 0 }; adm.programs = { TS6: adm.total }; adm.khoi = { 'Khối 6': adm.total }; adm.paidSheets = { GHOST: 1 };
    assert.ok(A.validate(adm).ok, A.validate(adm).error);
    store = memStore({ admissions: adm }); await withNet(sheetData(), {}, async () => { assert.equal((await run(store)).ok, true); });
  });
  test('số lưu không còn hợp lệ: dừng (409, ghi đè được), không đè lên bản sao lưu hợp lệ cũ hơn; ghi đè thì giữ bản hỏng ở fbmatch_invalid', async () => {
    const older = mkPrev({ syncedAt: '2026-12-01T00:00:00.000Z' }), broken = { v: 7, season: '2027–28', days: 'x' };
    const store = memStore({ fbmatch: broken, fbmatch_prev: older });
    await withNet(sheetData(), {}, async () => {
      await assert.rejects(() => run(store, { today: TODAY2 }), e => e.status === 409 && e.canForce === true && /không đọc được theo cấu trúc hiện tại/.test(e.message)); assert.deepEqual(store.docs.fbmatch, broken);
      assert.equal((await run(store, { today: TODAY2, force: true })).ok, true);
    });
    assert.deepEqual(store.docs.fbmatch_prev, older); assert.deepEqual(store.docs.fbmatch_invalid, broken);
  });
  test('chốt chặn số lead tụt: tụt 45% bị chặn, tụt nhẹ thì không; dưới 20 lead đã lưu thì không chặn', async () => {
    const mk = n => { const d = {}; for (let i = 1; i <= n; i++) d[dayOf(TODAY, -i)] = { 111111: [1, 0, 0, 0, 0, 0, 0] }; return mkPrev({ days: d, winFrom: dayOf(TODAY, -n) }); };
    await withNet(sheetData(), {}, async () => { await assert.rejects(() => run(memStore({ fbmatch: mk(25) })), e => e.status === 409 && /thấp hơn hẳn/.test(e.message)); });
    await withNet(sheetData(), {}, async () => { assert.equal((await run(memStore({ fbmatch: mk(8) }))).ok, true); });
  });
}

test('safelog: lỗi phân tích JSON không để lọt đoạn của đầu vào, chữ số Unicode bị lọc, chuỗi rất dài xử lý nhanh', () => {
  const l1 = describeUnknown(new SyntaxError('Unexpected token \'N\', ..."a","name":Nguyen Van"... is not valid JSON')), l2 = describeUnknown(new SyntaxError('Unexpected token \'N\', "Nguyen Van A" is not valid JSON'));
  assert.ok(!/Nguyen|Van/.test(l1) && !/Nguyen|Van/.test(l2), l1 + ' || ' + l2); assert.match(l1, /^SyntaxError \| Unexpected token/);
  const wide = [...String(phn(3))].map(c => String.fromCharCode(c.charCodeAt(0) + 0xFEE0)).join('');          // cùng dãy số nhưng viết bằng chữ số toàn chiều rộng
  assert.ok(!/[０-９]{4}/.test(scrub('so ' + wide + ' het')), scrub('so ' + wide + ' het'));
  const arab = [...String(phn(4))].map(c => String.fromCharCode(0x0660 + Number(c))).join(''), sep = wide.slice(0, 3) + ' ' + wide.slice(3, 6) + ' ' + wide.slice(6);        // chữ số Ả Rập và số toàn chiều rộng viết cách nhau
  assert.ok(!/\p{Nd}{3}/u.test(scrub('tel ' + sep + ' x ' + arab + ' y')), scrub('tel ' + sep + ' x ' + arab + ' y'));
  const longQuote = scrub('Invalid value "' + 'Nguyen Van An '.repeat(60) + '" at row 5'), openQuote = describeUnknown(new Error('Cannot parse "' + 'Tran Thi B '.repeat(80)));   // chuỗi trong ngoặc kép dài quá 600 ký tự hay bị cắt dở vẫn được che
  assert.ok(!/Nguyen|Van An/.test(longQuote) && !/Tran|Thi B/.test(openQuote), longQuote + ' || ' + openQuote);
  const t0 = performance.now(); scrub('x'.repeat(100000)); describeUnknown(Object.assign(new Error('y'.repeat(100000)), { code: 'z'.repeat(100000) })); assert.ok(performance.now() - t0 < 500, String(performance.now() - t0));
});

test('safelog: chuỗi trong ngoặc kép kéo dài qua nhiều dòng không lọt vào log qua phần ngăn xếp; tên và mã lỗi cũng qua bộ lọc', () => {
  const k = phn(7), e = new Error('ghi that bai "Nguyen\nVan A" ' + k + '\nten.phu.huynh@example.com'); e.code = 'ten.phu.huynh@example.com'; e.name = 'Loi "Tran Thi B"';
  const line = describeUnknown(e);
  assert.ok(!/Nguyen|Van A|Tran|Thi B|example\.com/.test(line) && !line.includes(k), line);
  assert.match(line, /^Loi "…" \| @ \| ghi that bai "…"/); assert.match(line, / @ \s*at /);
  const frames = line.slice(line.lastIndexOf(' @ ') + 3); assert.ok(frames === '' || /^at /.test(frames), frames);
  const e2 = new Error('x'); e2.stack = 'Error: x\n    at ham (/srv/' + k + '/a.js:1:2)\n    at khac (ten.phu.huynh@example.com:3:4)';                    // số hay email nằm trong khung gọi cũng bị lọc
  const l2 = describeUnknown(e2); assert.ok(!l2.includes(k) && !/example\.com/.test(l2), l2);
});

test('checkLeads: dừng giữa chừng vì hết giờ thì báo đỏ "Mới đọc thử k/n" (không bao giờ xanh khi còn biểu mẫu chưa thử); đọc thử cả Trang thứ bảy; đúng MAX_FORMS biểu mẫu vẫn đọc được; biểu mẫu lưu trữ không đọc được không tính vào giới hạn; leads_count thiếu không làm báo đỏ', async () => {
  const mkForms = n => Array.from({ length: n }, (_, i) => ({ id: 'q' + i, status: 'ACTIVE', leads_count: 3, created_time: OLD }));
  const base = (forms, leadsRoute) => [u => u.host === 'graph.facebook.com' && /\/q\d+\/leads$/.test(u.pathname) ? leadsRoute(u) : undefined, ...graphRoutes({ forms })];
  const run = async (forms, leadsRoute, fn) => { const f = stubFetch(base(forms, leadsRoute)); try { return await fn(); } finally { f.restore(); } };
  const checkStep = async () => (await L.checkLeads({ token: 'tok-test', accts: [], env: ENV })).steps.find(x => x.id === 'leads');
  // 1) giờ chạy nhanh theo từng lần đọc thử: ngân sách 15 giây, mỗi lần đọc thử tốn 2 giây, dừng khi còn dưới 8 giây → thử được 4/5
  const realNow = Date.now; let off = 0; Date.now = () => realNow() + off;
  try {
    const s = await run(mkForms(5), () => { off += 2000; return json({ data: [] }); }, () => withDeadline(async () => { setDeadline(Date.now() + 15000); return checkStep(); }));
    assert.equal(s.ok, false, JSON.stringify(s)); assert.match(s.text, /Mới đọc thử 4\/5 biểu mẫu/);
  } finally { Date.now = realNow; }
  // 2) nhiều Trang: biểu mẫu không đọc được của Trang thứ bảy vẫn bị phát hiện
  const ids = Array.from({ length: 7 }, (_, i) => '1' + String(1000000000 + i)), env7 = Object.assign({}, ENV, { META_PAGE_IDS: ids.join(',') });
  const f7 = stubFetch([(u) => {
    if (u.host !== 'graph.facebook.com') return; const path = u.pathname.replace(/^\/v\d+\.\d+/, ''); let m;
    if ((m = path.match(/^\/(\d+)$/)) && u.searchParams.get('fields') === 'access_token,name') return json({ access_token: 'pt' + m[1], name: 'Trang ' + m[1] });
    if ((m = path.match(/^\/(\d+)\/leadgen_forms$/))) return json({ data: [{ id: 'g' + m[1], status: 'ACTIVE', leads_count: 3, created_time: OLD }] });
    if ((m = path.match(/^\/g(\d+)\/leads$/))) return m[1] === ids[6] ? json({ error: { code: 200, message: '(#200) quyền' } }, 403) : json({ data: [] });
    if (path === '/me/permissions') return json({ data: ['leads_retrieval', 'pages_show_list', 'pages_read_engagement', 'pages_manage_ads'].map(p => ({ permission: p, status: 'granted' })) });
  }]);
  try { const s = (await L.checkLeads({ token: 'tok-test', accts: [], env: env7 })).steps.find(x => x.id === 'leads'); assert.equal(s.ok, false, JSON.stringify(s)); } finally { f7.restore(); }
  // 3) đúng MAX_FORMS biểu mẫu: lần đọc thật chạy được; vượt thì báo kèm cách xử lý
  assert.ok((await run(mkForms(L.MAX_FORMS), () => json({ data: [] }), () => L.fetchLeads({ token: 'tok-test', accts: [], sinceDay: '2026-08-22', env: ENV }))).forms === L.MAX_FORMS);
  const over = await run(mkForms(L.MAX_FORMS + 1), () => json({ data: [] }), checkStep); assert.equal(over.ok, false); assert.match(over.text, /Xoá các biểu mẫu cũ/);
  // 4) biểu mẫu LƯU TRỮ mà Meta báo không còn (mã 100) bị bỏ qua và không tính vào giới hạn: 61 biểu mẫu, 40 trong số đó lưu trữ không đọc được
  const forms61 = mkForms(61).map((f, i) => i < 40 ? Object.assign(f, { status: 'ARCHIVED' }) : f), gone = u => (/\/q(\d+)\/leads$/.exec(u.pathname) || [])[1] < 40 ? json({ error: { code: 100, message: 'Unsupported get request' } }, 400) : json({ data: [] });
  const got = await run(forms61, gone, () => L.fetchLeads({ token: 'tok-test', accts: [], sinceDay: '2026-08-22', env: ENV })); assert.equal(got.skippedForms, 40); assert.equal(got.forms, 61);
  const st = await run(forms61, gone, checkStep); assert.equal(st.ok, true, JSON.stringify(st));
  // 5) biểu mẫu mới tạo thiếu leads_count và chưa có lead: lần đọc thật chạy được nên bước kiểm tra cũng không được đỏ
  const recent = [{ id: 'q0', status: 'ACTIVE', created_time: new Date(Date.now() - 5 * 86400000).toISOString() }];
  assert.equal((await run(recent, () => json({ data: [] }), checkStep)).ok, true);
  // 6) biểu mẫu lưu trữ không còn nằm SAU biểu mẫu thứ 60 cũng không tính vào giới hạn (đếm sau khi đọc, không đếm trước)
  const goneAfter = from => u => (/\/q(\d+)\/leads$/.exec(u.pathname) || [])[1] >= from ? json({ error: { code: 100, message: 'Unsupported get request' } }, 400) : json({ data: [] });
  const forms62 = mkForms(62).map((f, i) => i >= 60 ? Object.assign(f, { status: 'ARCHIVED' }) : f);
  const g62 = await run(forms62, goneAfter(60), () => L.fetchLeads({ token: 'tok-test', accts: [], sinceDay: '2026-08-22', env: ENV })); assert.equal(g62.skippedForms, 2); assert.equal(g62.forms, 62);
  assert.equal((await run(forms62, goneAfter(60), checkStep)).ok, true);
  // 7) 61 biểu mẫu đọc được: dừng sau khi đọc biểu mẫu thứ 61, kể cả khi đứng cuối danh sách; kiểm tra kết nối đỏ cùng lý do
  const r61 = mkForms(61); await run(r61, () => json({ data: [] }), async () => { await assert.rejects(() => L.fetchLeads({ token: 'tok-test', accts: [], sinceDay: '2026-08-22', env: ENV }), e => e.expose === true && /hơn 60 biểu mẫu có lead đọc được/.test(e.message)); });
  const c61 = await run(r61, () => json({ data: [] }), checkStep); assert.equal(c61.ok, false); assert.match(c61.text, /hơn 60 biểu mẫu có lead đọc được/);
  // 8) quá nhiều biểu mẫu lưu trữ không đọc được (mỗi cái tốn một yêu cầu): giới hạn theo thời gian, dừng với thông báo rõ thay vì chạy đến hết giờ; có thời gian thì đọc hết (nhiều biểu mẫu lưu trữ không còn không phải là lỗi)
  const forms150 = mkForms(150).map((f, i) => i >= 20 ? Object.assign(f, { status: 'ARCHIVED' }) : f);
  await run(forms150, goneAfter(20), async () => { const g = await L.fetchLeads({ token: 'tok-test', accts: [], sinceDay: '2026-08-22', env: ENV }); assert.equal(g.skippedForms, 130); });      // không đặt hạn chót: đọc hết
  const realNow2 = Date.now; let off2 = 0; Date.now = () => realNow2() + off2;
  try {
    const slow = u => { off2 += 1000; return goneAfter(20)(u); };
    await run(forms150, slow, () => withDeadline(async () => { setDeadline(Date.now() + 40000); await assert.rejects(() => L.fetchLeads({ token: 'tok-test', accts: [], sinceDay: '2026-08-22', env: ENV }), e => e.expose === true && /Chưa đọc hết các biểu mẫu trong thời gian cho phép/.test(e.message) && /Xoá các biểu mẫu cũ/.test(e.message)); }));
    off2 = 0; const c150 = await run(forms150, slow, () => withDeadline(async () => { setDeadline(Date.now() + 40000); return checkStep(); })); assert.equal(c150.ok, false); assert.match(c150.text, /Mới đọc thử/);
  } finally { Date.now = realNow2; }
});

test('checkLeads: đọc thử mọi biểu mẫu có lead (không chỉ 8 đầu), báo đỏ khi một biểu mẫu thứ chín không đọc được hoặc khi vượt giới hạn số biểu mẫu của lần đọc thật', async () => {
  const mkForms = n => Array.from({ length: n }, (_, i) => ({ id: 'q' + i, status: 'ACTIVE', leads_count: 3, created_time: OLD }));
  const routes = (forms, badId) => [u => u.host === 'graph.facebook.com' && /\/q\d+\/leads$/.test(u.pathname) && (u.pathname.endsWith('/' + badId + '/leads') ? json({ error: { code: 200, message: '(#200) quyền' } }, 403) : json({ data: [] })), ...graphRoutes({ forms })];
  let f = stubFetch(routes(mkForms(12), 'q9'));
  try { const s = (await L.checkLeads({ token: 'tok-test', accts: [], env: ENV })).steps.find(x => x.id === 'leads'); assert.equal(s.ok, false, JSON.stringify(s)); } finally { f.restore(); }
  f = stubFetch(routes(mkForms(L.MAX_FORMS + 1), 'khong-co'));
  try { const s = (await L.checkLeads({ token: 'tok-test', accts: [], env: ENV })).steps.find(x => x.id === 'leads'); assert.equal(s.ok, false); assert.match(s.text, /vượt giới hạn/); assert.ok(!/Mới đọc thử/.test(s.text), s.text); } finally { f.restore(); }
  f = stubFetch(routes(mkForms(L.MAX_FORMS), 'khong-co'));                                                           // đúng 60 biểu mẫu: đọc thử đủ cả 60 và báo xanh
  try { const s = (await L.checkLeads({ token: 'tok-test', accts: [], env: ENV })).steps.find(x => x.id === 'leads'); assert.equal(s.ok, true, JSON.stringify(s)); assert.match(s.text, new RegExp('ở ' + L.MAX_FORMS + ' biểu mẫu')); } finally { f.restore(); }
  f = stubFetch(routes(mkForms(5), 'khong-co'));                                                                       // sắp hết giờ: không báo xanh khi chưa đọc thử được biểu mẫu nào
  try { const s = (await withDeadline(async () => { setDeadline(Date.now() + 6000); return L.checkLeads({ token: 'tok-test', accts: [], env: ENV }); })).steps.find(x => x.id === 'leads'); assert.equal(s.ok, false, JSON.stringify(s)); assert.match(s.text, /Mới đọc thử 0\/5 biểu mẫu/); } finally { f.restore(); }
  f = stubFetch(routes(mkForms(L.MAX_FORMS + 1), 'khong-co'));
  try { await assert.rejects(() => L.fetchLeads({ token: 'tok-test', accts: [], sinceDay: '2026-08-22', env: ENV }), e => e.expose === true && /Xoá các biểu mẫu cũ/.test(e.message)); } finally { f.restore(); }
});
