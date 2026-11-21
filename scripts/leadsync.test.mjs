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
  assert.deepEqual(S.leadSyncConfig(ENV), { sheet: true, sheetSet: true, meta: true, ready: true });
  assert.deepEqual(S.leadSyncConfig({ META_ACCESS_TOKEN: 'x' }), { sheet: false, sheetSet: false, meta: true, ready: false });
  assert.deepEqual(S.leadSyncConfig({ ADMISSIONS_SHEET_ID: SHEET, META_ACCESS_TOKEN: '  ' }), { sheet: true, sheetSet: true, meta: false, ready: false });
  assert.deepEqual(S.leadSyncConfig({ ADMISSIONS_SHEET_ID: 'https://docs.google.com/khong-phai-sheet', META_ACCESS_TOKEN: 'x' }), { sheet: false, sheetSet: true, meta: true, ready: false });   // đã đặt nhưng sai dạng: khác với chưa đặt
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
    assert.deepEqual(r.serviceAccount, { email: SA.client_email, projectId: SA.project_id }); assert.deepEqual(r.config, { sheet: true, sheetSet: true, meta: true, ready: true });
    const by = id => r.sheet.steps.find(s => s.id === id);
    assert.ok(by('read').ok && /DATA TUYỂN SINH/.test(by('read').text)); assert.ok(by('reg').ok); assert.ok(by('phones-reg').ok && /2 cột SĐT, 1 cột email/.test(by('phones-reg').text));
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
});
