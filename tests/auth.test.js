import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyInitData, signInitDataForTests, signToken, verifyToken, hashPassword, checkPassword } from '../server/lib/auth.js';
import { loadEnv } from '../server/lib/env.js';

const BOT = '123456:TEST-bot-token', USER = { id: 424242, first_name: 'Ada', username: 'ada' };

test('initData: valid signature accepted and user parsed', () => {
  const r = verifyInitData(signInitDataForTests(USER, BOT), BOT);
  assert.equal(r.user.id, 424242);
});
test('initData: wrong bot token, tampered payload, missing hash are rejected', () => {
  const good = signInitDataForTests(USER, BOT);
  assert.equal(verifyInitData(good, 'other:token'), null);
  assert.equal(verifyInitData(good.replace('Ada', 'Eve'), BOT), null);
  assert.equal(verifyInitData(good.replace(/hash=[0-9a-f]+/, ''), BOT), null);
  const forged = new URLSearchParams(good); forged.set('user', JSON.stringify({ id: 1 }));
  assert.equal(verifyInitData(forged.toString(), BOT), null);
  assert.equal(verifyInitData('', BOT), null); assert.equal(verifyInitData(null, BOT), null); assert.equal(verifyInitData(good, ''), null);
});
test('initData: expired and future auth_date rejected (replay window)', () => {
  const now = Date.now(), old = signInitDataForTests(USER, BOT, Math.floor(now / 1000) - 7200), fut = signInitDataForTests(USER, BOT, Math.floor(now / 1000) + 600);
  assert.equal(verifyInitData(old, BOT, { maxAgeSec: 3600, now }), null);
  assert.equal(verifyInitData(fut, BOT, { now }), null);
  assert.ok(verifyInitData(old, BOT, { maxAgeSec: 86400, now }));
});
test('tokens: roundtrip, tamper, wrong secret, expiry', () => {
  const S = 's'.repeat(40), t = signToken({ sub: '1' }, S, 60);
  assert.equal(verifyToken(t, S).sub, '1');
  assert.equal(verifyToken(t, 'x'.repeat(40)), null);
  const [a, b, c] = t.split('.'); assert.equal(verifyToken(`${a}.${Buffer.from('{"sub":"2","exp":9999999999}').toString('base64url')}.${c}`, S), null);
  assert.equal(verifyToken(t, S, Date.now() + 61_000), null);
  assert.equal(verifyToken('garbage', S), null);
});
test('admin password hashing', () => {
  const h = hashPassword('correct horse battery'); assert.ok(checkPassword('correct horse battery', h)); assert.ok(!checkPassword('wrong', h)); assert.ok(!checkPassword('x', 'junk'));
});
test('production env refuses weak/missing secrets and dev bypass', () => {
  assert.throws(() => loadEnv({ NODE_ENV: 'production' }));
  assert.throws(() => loadEnv({ NODE_ENV: 'production', BOT_TOKEN: 'a', SESSION_SECRET: 'short', MONGODB_URI: 'm', ALLOWED_ORIGIN: 'https://x' }));
  assert.throws(() => loadEnv({ NODE_ENV: 'production', BOT_TOKEN: 'a', SESSION_SECRET: 's'.repeat(40), MONGODB_URI: 'm', ALLOWED_ORIGIN: 'https://x', DEV_AUTH_BYPASS: '1' }));
  assert.ok(loadEnv({ NODE_ENV: 'production', BOT_TOKEN: 'a', SESSION_SECRET: 's'.repeat(40), MONGODB_URI: 'm', ALLOWED_ORIGIN: 'https://x' }).requireTxn);
});
