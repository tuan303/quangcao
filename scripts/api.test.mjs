// Kiểm thử mức hàm /api (như Vercel gọi): quyền truy cập, đường cron, và việc /api/ingest không cho ghi các tài liệu do máy chủ tự tính.
// Không có Firestore, Google hay Meta: chỉ những đường đi không chạm tới chúng (bí mật cron, thiếu cấu hình, từ chối sớm).
import test from 'node:test';
import assert from 'node:assert/strict';

const SECRETS = { CRON_SECRET: 'cron-test-secret-' + 'x'.repeat(24), INGEST_SECRET: 'ingest-test-secret-' + 'y'.repeat(24) };
async function call(name, { method = 'GET', token, body, query, env = {} } = {}) {
  const saved = {}; const all = Object.assign({ ADMISSIONS_SHEET_ID: '', META_ACCESS_TOKEN: '', ANTHROPIC_API_KEY: '', FIREBASE_SERVICE_ACCOUNT: '' }, SECRETS, env);
  for (const [k, v] of Object.entries(all)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const mod = await import('../api/' + name + '.js');
    let out = { status: 0, body: null }, headers = {};
    const res = { statusCode: 200, setHeader(k, v) { headers[k] = v; }, end(b) { out = { status: this.statusCode, body: b ? JSON.parse(b) : null, headers }; } };
    const req = { method, headers: token ? { authorization: 'Bearer ' + token } : {}, query: query || {}, body: body || undefined };
    const log = console.error; console.error = () => {};
    try { await mod.default(req, res); } finally { console.error = log; }
    return out;
  } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test('/api/leadsync: cron dùng GET với CRON_SECRET; chưa cấu hình thì bỏ qua êm; POST hoặc sai bí mật thì từ chối', async () => {
  const ok = await call('leadsync', { token: SECRETS.CRON_SECRET });
  assert.equal(ok.status, 200); assert.deepEqual([ok.body.ok, ok.body.skipped], [true, 'chưa cấu hình']);
  assert.equal(ok.headers['Cache-Control'], 'private, no-store');
  assert.equal((await call('leadsync', { token: SECRETS.CRON_SECRET, method: 'POST', body: { action: 'run' } })).status, 405);        // cron chỉ dùng GET
  assert.notEqual((await call('leadsync', { token: 'sai-bi-mat' })).status, 200);                                                    // không phải bí mật cron cũng không phải phiên đăng nhập hợp lệ
  assert.equal((await call('leadsync', {})).status, 401);                                                                            // không có thông tin xác thực
  assert.equal((await call('leadsync', { token: SECRETS.INGEST_SECRET })).status === 200, false);                                    // bí mật ingest không mở được endpoint này
});

test('/api/insights: cron cập nhật đối chiếu TRƯỚC kiểm tra khoá Anthropic (chưa có khoá vẫn báo trạng thái cập nhật); POST từ cron bị từ chối', async () => {
  const r = await call('insights', { token: SECRETS.CRON_SECRET });
  assert.equal(r.status, 501); assert.match(r.body.error, /ANTHROPIC_API_KEY/); assert.deepEqual(r.body.leadsync, { skipped: 'chưa cấu hình' });
  const dry = await call('insights', { token: SECRETS.CRON_SECRET, query: { dry: '1' } });          // ?dry=1 chỉ xem thử: không cập nhật đối chiếu
  assert.equal(dry.status, 501); assert.equal(dry.body.leadsync, null);
  assert.equal((await call('insights', { token: SECRETS.CRON_SECRET, method: 'POST' })).status, 405);
  assert.equal((await call('insights', {})).status, 401);
});

test('/api/ingest: tài liệu admissions, fbmatch, leadsync (mọi cách viết hoa, dấu cách) chỉ do máy chủ ghi: bị từ chối cả lô', async () => {
  for (const key of ['admissions', ' Admissions ', 'fbmatch', 'FBMatch', ' leadsync', 'LEADSYNC ']) {
    const r = await call('ingest', { method: 'POST', token: SECRETS.INGEST_SECRET, body: { docs: { 'acct-1': { v: 1 }, [key]: { v: 1 } } } });
    assert.equal(r.status, 400, JSON.stringify(key)); assert.match(r.body.error, /chỉ do máy chủ ghi/);
  }
  assert.equal((await call('ingest', { method: 'POST', token: 'sai', body: { docs: { a: {} } } })).status, 401);
  assert.equal((await call('ingest', { method: 'POST', token: SECRETS.INGEST_SECRET, body: { docs: {} } })).status, 400);              // thiếu docs
});

test('/api/data và /api/admissions: chưa đăng nhập thì 401; bí mật cron không đọc được số liệu', async () => {
  assert.equal((await call('data', {})).status, 401);
  assert.notEqual((await call('data', { token: SECRETS.CRON_SECRET })).status, 200);
  assert.equal((await call('admissions', { method: 'POST', body: { summary: {} } })).status, 401);
  assert.equal((await call('data', { method: 'POST' })).status, 405);
});
