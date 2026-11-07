// Telegram initData verification + signed session tokens + password hashing. No external deps.
import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
export { safeEq };

/**
 * Validates Telegram WebApp initData per https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * Returns {user, authDate, startParam} or null. Pure function: no I/O.
 */
export function verifyInitData(initData, botToken, { maxAgeSec = 3600, now = Date.now() } = {}) {
  try {
    if (typeof initData !== 'string' || initData.length < 20 || initData.length > 4096 || !botToken) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
    params.delete('hash');
    const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = hmac('WebAppData', botToken);
    const expected = hmac(secret, dcs).toString('hex');
    if (!safeEq(expected, hash)) return null;
    const authDate = parseInt(params.get('auth_date') || '', 10);
    const age = Math.floor(now / 1000) - authDate;
    if (!Number.isFinite(authDate) || age > maxAgeSec || age < -60) return null;   // expired / from the future
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return null;
    return { user, authDate, startParam: params.get('start_param') || null };
  } catch { return null; }
}

/** Test/dev helper: builds a valid initData string for a given bot token. */
export function signInitDataForTests(user, botToken, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: 'AAH-test', user: JSON.stringify(user) });
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  params.set('hash', hmac(hmac('WebAppData', botToken), dcs).toString('hex'));
  return params.toString();
}

// ── signed bearer tokens (compact JWT-like: v1.<payload>.<sig>) ──
export function signToken(payload, secret, ttlSec, now = Date.now()) {
  const body = { ...payload, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + ttlSec, jti: crypto.randomBytes(8).toString('hex') };
  const p = b64u(JSON.stringify(body));
  return `v1.${p}.${b64u(hmac(secret, `v1.${p}`))}`;
}
export function verifyToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  if (!safeEq(b64u(hmac(secret, `v1.${parts[1]}`)), parts[2])) return null;
  try {
    const body = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (!body.exp || body.exp * 1000 < now) return null;
    return body;
  } catch { return null; }
}

// ── admin passwords: scrypt$N$saltHex$hashHex ──
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16), N = 16384;
  const h = crypto.scryptSync(pw, salt, 32, { N });
  return `scrypt$${N}$${salt.toString('hex')}$${h.toString('hex')}`;
}
export function checkPassword(pw, stored) {
  try {
    const [alg, N, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const h = crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 32, { N: Number(N) });
    return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
  } catch { return false; }
}
