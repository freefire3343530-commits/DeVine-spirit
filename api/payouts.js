// FILE PATH: api/payouts.js
// PUBLIC PAYOUT PROOF (read only).  Only data from the `payouts` ledger (confirmed payments) is ever returned.
//
//   GET /api/payouts?action=feed     → totals + today + the first page of the latest list   (what the app opens with)
//   GET /api/payouts?action=summary  → totals + today only (cheap; the app polls this to know when something changed)
//   GET /api/payouts?action=list&before=<cursor>&limit=20 → older payouts
//
// Privacy: names are masked (Ad****), wallets shortened (UQAm2y...Bvyegq). No Telegram ID, full address or photo is returned.
// Nobody can create or change a payout from here: this file has no write at all.
import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';
import { getPayoutStats, listPublicPayouts, getChannelUrl } from '../lib/payouts.js';

// tiny in-memory rate limit: 40 requests / minute / player
const hits = new Map();
function limited(id) {
  const now = Date.now(), arr = (hits.get(id) || []).filter((t) => now - t < 60000);
  arr.push(now); hits.set(id, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 60000) hits.delete(k);
  return arr.length > 40;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const q = req.query || {};
  const tg = verifyTelegramInit(q.initData || '');
  if (!tg || String(tg.id) !== String(q.telegramId)) return res.status(403).json({ ok: false, error: 'Invalid Telegram session' });
  if (limited(String(tg.id))) return res.status(429).json({ ok: false, error: 'too_many_requests' });

  const db = await getDb();
  const action = q.action || 'feed';
  if (action === 'summary') {
    const [stats, channelUrl] = await Promise.all([getPayoutStats(db), getChannelUrl(db)]);
    return res.status(200).json({ ok: true, stats, channelUrl });
  }
  if (action === 'list') {
    const page = await listPublicPayouts(db, { limit: q.limit, before: q.before || null });
    return res.status(200).json({ ok: true, ...page });
  }
  if (action === 'feed') {
    const [stats, channelUrl, page] = await Promise.all([getPayoutStats(db), getChannelUrl(db), listPublicPayouts(db, { limit: 20 })]);
    return res.status(200).json({ ok: true, stats, channelUrl, ...page });
  }
  return res.status(400).json({ ok: false, error: 'unknown_action' });
}
