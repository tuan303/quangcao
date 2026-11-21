// Kiểm thử offline cho phần máy chủ của đối chiếu phụ huynh: đọc Google Sheet bằng service account, lấy lead qua Graph API, điều phối và ghi số tổng hợp.
// Google và Meta được thay bằng bản giả (fetch giả); kho số liệu là bộ nhớ. Mọi SĐT, email, họ tên là dữ liệu giả dựng lúc chạy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import '../fbads-core.js';
import '../admissions.js';
import '../leadmatch.js';
import * as G from '../server/gsheets.js';
import * as L from '../server/leads.js';
import * as S from '../server/leadsync.js';
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
  u => u.host === 'sheets.googleapis.com' && u.pathname === '/v4/spreadsheets/' + SHEET + '/values:batchGet' && json({ valueRanges: u.searchParams.getAll('ranges').map(r => ({ range: r, values: sheet.values[r.replace(/^'|'$/g, '').replace(/''/g, "'")] || [] })) })
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
    assert.equal(batch.get('valueRenderOption'), 'UNFORMATTED_VALUE'); assert.equal(batch.get('dateTimeRenderOption'), 'SERIAL_NUMBER'); assert.deepEqual(batch.getAll('ranges'), ["'Danh sách đăng ký'", "'LỚP 6 2728 (ĐP)'", "'LỚP 10 2728 (ĐP)'"]);
    assert.ok(f.calls.every(c => c.u.host !== 'sheets.googleapis.com' || c.init.method == null || c.init.method === 'GET'), 'chỉ đọc');
    assert.ok(f.calls.filter(c => c.u.host === 'sheets.googleapis.com').every(c => c.init.headers.Authorization === 'Bearer gtok'));
  } finally { f.restore(); G.resetTokenCache(); }
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
  assert.deepEqual(S.leadSyncConfig(ENV), { sheet: true, meta: true, ready: true });
  assert.deepEqual(S.leadSyncConfig({ META_ACCESS_TOKEN: 'x' }), { sheet: false, meta: true, ready: false });
  assert.deepEqual(S.leadSyncConfig({ ADMISSIONS_SHEET_ID: SHEET, META_ACCESS_TOKEN: '  ' }), { sheet: true, meta: false, ready: false });
});

test('runLeadSync: từ Google Sheet và lead đến số tổng hợp; chỉ ghi số, không có SĐT/email/họ tên; trạng thái ghi lại', async () => {
  G.resetTokenCache(); const store = memStore(), f = stubFetch([...googleRoutes(sheetData()), ...graphRoutes()]);
  try {
    const r = await S.runLeadSync({ by: 'admin', env: ENV, today: TODAY, store });
    assert.equal(r.ok, true); assert.deepEqual(r.stats, { rows: 6, parents: 6, matched: 3, students: 5, studentsWithPhone: 4, paidExt: 3, paidExtWithPhone: 2, forms: 2, pages: 1, skippedForms: 1, from: '2026-10-01' });
    const m = store.docs.fbmatch;
    assert.equal(m.season, '2027–28'); assert.equal(m.leads.dupFamily, 1); assert.equal(m.leads.internalOnly, 1); assert.ok(typeof m.syncedAt === 'string');
    assert.deepEqual(m.days['2026-10-01']['111111'], [1, 0, 0, 1, 1, 1, 1]); assert.deepEqual(m.days['2026-10-02']['111111'], [1, 0, 0, 1, 0, 1, 0]); assert.deepEqual(m.days['2026-10-06']['222222'], [1, 0, 0, 1, 1, 1, 1]);
    assert.deepEqual(m.days['2026-10-07']['111111'], [1, 1, 0, 0, 0, 0, 0]); assert.deepEqual(m.days['2026-10-09']['222222'], [1, 0, 0, 0, 0, 0, 0]); assert.equal(m.days['2026-10-03'], undefined);
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
  // khoá đã quá hạn thì chạy được
  store = memStore({ leadsync: { v: 1, runningUntil: new Date(Date.now() - 60000).toISOString() } }); G.resetTokenCache(); f = stubFetch(routes());
  try { assert.equal((await S.runLeadSync({ env: ENV, today: TODAY, store })).ok, true); } finally { f.restore(); G.resetTokenCache(); }
  // khác mùa: không gộp số của mùa cũ
  store = memStore({ fbmatch: Object.assign({}, prev, { season: '2026–27' }) }); G.resetTokenCache(); f = stubFetch(routes());
  try { await S.runLeadSync({ env: ENV, today: TODAY, store }); assert.ok(!Object.keys(store.docs.fbmatch.days).some(d => d === day(25))); assert.equal(store.docs.fbmatch.season, '2027–28'); } finally { f.restore(); G.resetTokenCache(); }
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
    assert.deepEqual(r.serviceAccount, { email: SA.client_email, projectId: SA.project_id }); assert.deepEqual(r.config, { sheet: true, meta: true, ready: true });
    const by = id => r.sheet.steps.find(s => s.id === id);
    assert.ok(by('read').ok && /DATA TUYỂN SINH/.test(by('read').text)); assert.ok(by('reg').ok); assert.ok(by('phones-reg').ok && /2 cột SĐT, 1 cột email/.test(by('phones-reg').text));
    assert.ok(by('paid-LỚP 10 2728 (ĐP)').ok && /1 cột SĐT/.test(by('paid-LỚP 10 2728 (ĐP)').text)); assert.equal(by('skipped').ok, false);
    assert.equal(by('coverage').ok, false); assert.match(by('coverage').text, /đã đóng phí có SĐT\/email: 2\/3 \(67%\)/);   // dưới 90%: chưa đáng tin
    assert.ok(r.meta.steps.some(s => s.id === 'pages' && s.ok)); nope(JSON.stringify(r), PII);
  } finally { f.restore(); G.resetTokenCache(); }
  const none = await S.checkSetup({ env: {}, today: TODAY });
  assert.equal(none.sheet.steps[0].ok, false); assert.equal(none.serviceAccount, null); assert.equal(none.meta.steps[0].ok, false);
});
