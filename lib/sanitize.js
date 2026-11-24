// FILE PATH: lib/sanitize.js
// 🧼 INPUT GUARD: stops MongoDB operator injection ("NoSQL injection").
// Express turns  {"taskId": {"$ne": null}}  (JSON body)  or  ?taskId[$ne]=x  (query string)  into a real object,
// and Mongo would then treat it as an OPERATOR instead of a value. Two rules, applied to every /api request:
//   1) no key anywhere inside body / query may start with "$"   (that is how every Mongo operator is written)
//   2) fields that must be plain values (ids, codes, tokens ...) may only be a string / number / boolean, never an object or array
// The real app never sends either, so normal users are never affected. Webhook (/api/bot) is skipped: it is
// protected by the secret token and its payload is built by Telegram.
const SCALAR_FIELDS = new Set([
  'telegramId', 'initData', 'taskId', 'action', 'code', 'referCode', 'spiritId', 'kind', 'pay', 'reqId', 'cycleId',
  'signature', 'startTime', 'orderId', 'address', 'token', 'answer', 'channelUsername', 'title', 'url', 'verifyType',
  'package', 'username', 'firstName', 'fp', 'type', 'cat', 'after', 'before', 'network', 'secret', 'job', 'userid',
  'egAmount', 'checkOnly', 'limit', 's2s', 'cron', 'id',
]);
const MAX_DEPTH = 8;

function hasOperatorKey(v, depth = 0) {
  if (v === null || typeof v !== 'object') return false;
  if (depth > MAX_DEPTH) return true;                       // absurdly deep = not a real request
  if (Array.isArray(v)) return v.some((x) => hasOperatorKey(x, depth + 1));
  for (const k of Object.keys(v)) {
    if (k.startsWith('$') || hasOperatorKey(v[k], depth + 1)) return true;
  }
  return false;
}

function badScalar(src) {
  if (!src || typeof src !== 'object') return null;
  for (const k of SCALAR_FIELDS) {
    const v = src[k];
    if (v !== undefined && v !== null && typeof v === 'object') return k;
  }
  return null;
}

export function sanitizeInput(req, res, next) {
  if (req.path === '/api/bot' || req.path === '/health') return next();
  const bad = hasOperatorKey(req.body) || hasOperatorKey(req.query);
  const field = bad ? 'operator' : (badScalar(req.body) || badScalar(req.query));
  if (field) {
    console.warn(`sanitize: rejected ${req.method} ${req.path} (${field}) ip=${req.shieldIp || req.ip}`);
    return res.status(400).json({ ok: false, success: false, error: 'bad_request' });
  }
  next();
}

// helper for handlers (defense in depth): is v a short plain string?
export const isStr = (v, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max;
