// FILE PATH: lib/tonPay.js
// (GitHub repo te ei path e file ta rakhbe: lib/tonPay.js)
// TON deposit helpers used by api/payments.js (users pay TON to create tasks).
// NOTE: this is NOT the payout file. Automatic USDT payouts live in lib/tonPayout.js.
//
// Render Environment Variables:
//   TON_RECEIVE_ADDRESS   the TON wallet address that receives the payments   (REQUIRED for paid task creation)
//   TONCENTER_API_KEY     free key from @tonapibot, avoids rate limits         (optional, recommended)
import { randomBytes } from 'crypto';

// Render env values are often pasted with spaces, a trailing newline or quotes around them: strip all of that.
const clean = (v) => String(v || '').trim().replace(/^["'\s]+|["'\s]+$/g, '');
export const TON_RECEIVE_ADDRESS = clean(process.env.TON_RECEIVE_ADDRESS);
// Friendly form (EQ.../UQ..., 48 chars) or raw form (0:<64 hex>)
export const tonAddressLooksValid = (a = TON_RECEIVE_ADDRESS) => /^[A-Za-z0-9_-]{48}$/.test(a) || /^-?\d+:[0-9a-fA-F]{64}$/.test(a);
// Safe to show to whoever knows CRON_SECRET: the address is public, the key is only described (never printed).
export function tonDiag() {
  const key = clean(process.env.TONCENTER_API_KEY);
  return { address: TON_RECEIVE_ADDRESS || null, addressLooksValid: tonAddressLooksValid(), apiKey: key ? `set (${key.length} chars)` : 'not set', apiKeyRejectedByToncenter: keyBad };
}

const MEMO_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I so users can copy it without mistakes

// A short unique comment the user must send with the payment, e.g. "TCK7M2X9QA". payments.js matches deposits by it.
export function randomTonMemo(prefix = 'TC') {
  const bytes = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += MEMO_CHARS[bytes[i] % MEMO_CHARS.length];
  return String(prefix).toUpperCase() + s;
}

// Opens Tonkeeper / any TON wallet with the amount and comment already filled in.
export function buildTonDeepLink(amountNanoTon, memo) {
  return `ton://transfer/${TON_RECEIVE_ADDRESS}?amount=${encodeURIComponent(String(amountNanoTon))}&text=${encodeURIComponent(String(memo))}`;
}

// Latest transactions of the receiving wallet (newest first), in the toncenter v2 format payments.js reads:
// { transaction_id: { hash }, in_msg: { source, value, message } }
//
// Two providers, tried in this order (the result array has a `.provider` field: 'v2' or 'v3'):
//   1) toncenter v2 getTransactions  (talks to TON lite-servers; sometimes answers 500/504 for a while)
//   2) toncenter v3 transactions     (separate index database; used only when v2 failed)
// Each provider gets 2 tries (6s each). Worst case ~25s, which stays under cron-job.org's 30s limit.
const TRIES = 2, TRY_TIMEOUT_MS = 6000;
const addrQ = () => encodeURIComponent(TON_RECEIVE_ADDRESS);

let keyBad = false; // toncenter answered 401/403 to our TONCENTER_API_KEY -> run without it (1 request/second is enough for a 1-minute cron)

async function getJson(url) {
  let lastErr, attempt = 0;
  while (attempt < TRIES) {
    attempt++;
    const key = clean(process.env.TONCENTER_API_KEY);
    const headers = key && !keyBad ? { 'X-API-Key': key } : {};
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TRY_TIMEOUT_MS);
    try {
      const r = await fetch(url, { headers, signal: ctrl.signal });
      if (!r.ok) {
        if ((r.status === 401 || r.status === 403) && headers['X-API-Key']) { keyBad = true; console.error('toncenter rejected TONCENTER_API_KEY (http ' + r.status + ') - continuing without a key'); attempt--; continue; }
        const body = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160); // toncenter says WHY in the body
        throw Object.assign(new Error(`http ${r.status}${body ? ' ' + body : ''}`), { permanent: r.status < 500 && r.status !== 429 });
      }
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (e.permanent || attempt >= TRIES) break;            // 4xx (wrong address) will not get better by retrying
      await new Promise((x) => setTimeout(x, 700 * attempt));
    } finally { clearTimeout(timer); }
  }
  throw lastErr;
}

async function viaV2(limit) {
  const d = await getJson(`https://toncenter.com/api/v2/getTransactions?address=${addrQ()}&limit=${limit}&archival=false`);
  if (!d || d.ok === false || !Array.isArray(d.result)) throw new Error('bad response');
  return d.result;
}

// v3 -> v2 shape. A text comment is in in_msg.message_content.decoded = { type: 'text_comment', comment }.
async function viaV3(limit) {
  const d = await getJson(`https://toncenter.com/api/v3/transactions?account=${addrQ()}&limit=${limit}&sort=desc`);
  if (!d || !Array.isArray(d.transactions)) throw new Error('bad response');
  return d.transactions.map((t) => {
    const m = t.in_msg;
    const dec = m?.message_content?.decoded;
    return {
      transaction_id: { hash: t.hash || null },
      in_msg: m ? { source: m.source || '', value: m.value, message: dec?.type === 'text_comment' ? String(dec.comment || '') : '' } : null,
    };
  });
}

export async function fetchRecentTonTransactions(limit = 100) {
  if (!TON_RECEIVE_ADDRESS) throw new Error('TON_RECEIVE_ADDRESS not set');
  const n = Number(limit) || 100;
  const errors = [];
  for (const [name, fn] of [['v2', viaV2], ['v3', viaV3]]) {
    try {
      const result = await fn(n);
      result.provider = name;
      return result;
    } catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  throw new Error(errors.join(' | '));
}
