import test from 'node:test';
import assert from 'node:assert/strict';
import { authorize, roleOf } from '../server/auth.js';
import { redactForViewer } from '../server/scope.js';
import { readJson } from '../server/http.js';
const env = { FBADS_ADMINS: 'admin@example.edu', FBADS_VIEWERS: 'viewer1@example.edu, viewer2@example.edu', CRON_SECRET: 'c'.repeat(40), INGEST_SECRET: 'i'.repeat(40) };
const ms = email => async () => ({ email, firebase: { sign_in_provider: 'microsoft.com' } });
test('roles', () => {
  assert.equal(roleOf('ADMIN@example.edu', env), 'admin');
  assert.equal(roleOf('viewer1@example.edu', env), 'viewer');
  assert.equal(roleOf('other@example.edu', env), null);
  assert.equal(roleOf('a@b@example.edu', env), null);
  assert.equal(roleOf('x@example.edu', { ...env, FBADS_VIEWER_DOMAINS: '@example.edu' }), 'viewer');
});
test('authorize users and secrets', async () => {
  assert.equal((await authorize({ authorization: 'Bearer t', env, verifyIdToken: ms('viewer1@example.edu') })).role, 'viewer');
  assert.equal((await authorize({ authorization: 'Bearer t', env, verifyIdToken: ms('x@example.edu') })).status, 403);
  assert.equal((await authorize({ authorization: 'Bearer t', env, verifyIdToken: async () => ({ email: 'admin@example.edu', firebase: { sign_in_provider: 'google.com' } }) })).status, 403);
  assert.equal((await authorize({ authorization: 'Bearer ' + 'c'.repeat(40), env, verifyIdToken: ms(''), allowSecrets: ['cron'] })).kind, 'cron');
  assert.equal((await authorize({ authorization: 'Bearer ' + 'c'.repeat(40), env, verifyIdToken: async () => { throw new Error('bad'); } })).status, 401, 'cron secret not accepted where not allowed');
  assert.equal((await authorize({ authorization: 'Bearer ' + 'i'.repeat(40), env, verifyIdToken: ms(''), allowSecrets: ['ingest'] })).kind, 'ingest');
  assert.equal((await authorize({ authorization: '', env, verifyIdToken: ms('') })).status, 401);
});

test('redactForViewer: người chỉ xem không thấy email của quản trị hay lỗi thô của Meta; bản gốc dùng chung không bị sửa', () => {
  const docs = { meta: { syncedBy: 'vercel:admin@example.edu', perAccount: { a: { error: 'lỗi thô', ok: 1 } } }, admissions: { by: 'admin@example.edu', total: {} }, insights: { by: 'admin@example.edu' }, other: { x: 1 } };
  const v = redactForViewer(docs);
  assert.equal(JSON.stringify(v).includes('@'), false);
  assert.deepEqual([v.meta.perAccount.a.error, v.meta.perAccount.a.ok, v.other], [null, 1, docs.other]);
  assert.equal(docs.meta.syncedBy, 'vercel:admin@example.edu'); assert.equal(docs.admissions.by, 'admin@example.edu');   // bộ nhớ đệm dùng chung với quản trị
  assert.equal(redactForViewer({ meta: { syncedBy: 'vercel:admin@example.edu' } }).meta.syncedBy, null);               // meta không có perAccount vẫn được ẩn
  assert.equal(redactForViewer({ meta: { syncedBy: 'vercel-cron' } }).meta.syncedBy, 'vercel-cron');
  assert.deepEqual(redactForViewer({}), {}); assert.equal(redactForViewer(null), null); assert.deepEqual(redactForViewer({ meta: 'x', insights: null }), { meta: 'x', insights: null });
});

test('readJson: mức giới hạn áp cả khi Vercel đã đọc sẵn JSON', async () => {
  await assert.rejects(readJson({ body: { a: 'x'.repeat(2000) } }, 1000), e => e.status === 413 && e.expose === true);
  assert.deepEqual(await readJson({ body: { a: 1 } }, 1000), { a: 1 });
});
