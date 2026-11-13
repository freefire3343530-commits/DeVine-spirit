// FILE PATH: lib/tonPay.js
// (GitHub repo te ei path e file ta rakhbe: lib/tonPay.js)
// TON deposit helpers used by api/payments.js (users pay TON to create tasks).
// NOTE: this is NOT the payout file. Automatic USDT payouts live in lib/tonPayout.js.
//
// Render Environment Variables:
//   TON_RECEIVE_ADDRESS   the TON wallet address that receives the payments   (REQUIRED for paid task creation)
//   TONCENTER_API_KEY     free key from @tonapibot, avoids rate limits         (optional, recommended)
import { randomBytes } from 'crypto';

export const TON_RECEIVE_ADDRESS = (process.env.TON_RECEIVE_ADDRESS || '').trim();

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
export async function fetchRecentTonTransactions(limit = 100) {
  if (!TON_RECEIVE_ADDRESS) throw new Error('TON_RECEIVE_ADDRESS not set');
  const url = `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(TON_RECEIVE_ADDRESS)}&limit=${Number(limit) || 100}&archival=false`;
  const headers = process.env.TONCENTER_API_KEY ? { 'X-API-Key': process.env.TONCENTER_API_KEY } : {};
  // toncenter sometimes answers 500/429 for a moment (worse without TONCENTER_API_KEY). Try up to 3 times, then give up
  // (the cron runs again next minute). 3 x 8s + pauses stays under cron-job.org's 30s limit.
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(url, { headers, signal: ctrl.signal });
      if (r.status === 429 || r.status >= 500) throw new Error(`toncenter http ${r.status}`); // temporary: retry
      if (!r.ok) throw Object.assign(new Error(`toncenter http ${r.status}`), { permanent: true }); // 4xx = wrong address / key: retrying will not help
      const d = await r.json();
      if (!d || d.ok === false || !Array.isArray(d.result)) throw new Error('toncenter bad response');
      return d.result;
    } catch (e) {
      lastErr = e;
      if (e.permanent || attempt === 3) break;
      await new Promise((x) => setTimeout(x, 700 * attempt));
    } finally { clearTimeout(timer); }
  }
  throw lastErr;
}
