import test from 'node:test';
import assert from 'node:assert/strict';
import { authorize, roleOf } from '../server/auth.js';
const env = { FBADS_ADMINS: 'it@hoangmaistarschool.edu.vn', FBADS_VIEWERS: 'nga@hoangmaistarschool.edu.vn, mkt@hoangmaistarschool.edu.vn', CRON_SECRET: 'c'.repeat(40), INGEST_SECRET: 'i'.repeat(40) };
const ms = email => async () => ({ email, firebase: { sign_in_provider: 'microsoft.com' } });
test('roles', () => {
  assert.equal(roleOf('IT@hoangmaistarschool.edu.vn', env), 'admin');
  assert.equal(roleOf('nga@hoangmaistarschool.edu.vn', env), 'viewer');
  assert.equal(roleOf('other@hoangmaistarschool.edu.vn', env), null);
  assert.equal(roleOf('a@b@hoangmaistarschool.edu.vn', env), null);
  assert.equal(roleOf('x@hoangmaistarschool.edu.vn', { ...env, FBADS_VIEWER_DOMAINS: '@hoangmaistarschool.edu.vn' }), 'viewer');
});
test('authorize users and secrets', async () => {
  assert.equal((await authorize({ authorization: 'Bearer t', env, verifyIdToken: ms('nga@hoangmaistarschool.edu.vn') })).role, 'viewer');
  assert.equal((await authorize({ authorization: 'Bearer t', env, verifyIdToken: ms('x@hoangmaistarschool.edu.vn') })).status, 403);
  assert.equal((await authorize({ authorization: 'Bearer t', env, verifyIdToken: async () => ({ email: 'it@hoangmaistarschool.edu.vn', firebase: { sign_in_provider: 'google.com' } }) })).status, 403);
  assert.equal((await authorize({ authorization: 'Bearer ' + 'c'.repeat(40), env, verifyIdToken: ms(''), allowSecrets: ['cron'] })).kind, 'cron');
  assert.equal((await authorize({ authorization: 'Bearer ' + 'c'.repeat(40), env, verifyIdToken: async () => { throw new Error('bad'); } })).status, 401, 'cron secret not accepted where not allowed');
  assert.equal((await authorize({ authorization: 'Bearer ' + 'i'.repeat(40), env, verifyIdToken: ms(''), allowSecrets: ['ingest'] })).kind, 'ingest');
  assert.equal((await authorize({ authorization: '', env, verifyIdToken: ms('') })).status, 401);
});
