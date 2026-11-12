// FILE PATH: lib/payouts.js
// PAYOUT PROOF SYSTEM — the single source of truth for "money really paid to players".
//
//   withdrawals  = the request lifecycle (pending → approved / rejected). NOT proof of payment.
//   payouts      = the proof ledger. A row exists ONLY after a payment was really made and confirmed:
//                    • 'onchain'         auto-pay: the bot saw its own transfer on the TON network
//                    • 'admin_hash'      admin typed the transaction hash after paying by hand
//                    • 'admin_attested'  admin confirmed the payment without a hash (shown as "Admin confirmed", no Tx link)
//                    • 'backfill_*'      old withdrawals imported by the admin (same two levels)
//
// Everything the public Payout Proof page shows (totals, today, the latest list) is calculated from `payouts`
// with status 'success'. Pending / approved / rejected / failed withdrawals are never counted.
//
// Duplicate protection (unique indexes in lib/indexes.js + the checks below; voided rows do not count):
//   • one successful payout per withdrawal   (payouts.withdrawalId is unique)
//   • one successful payout per transaction  (network + txHash is unique when a hash exists)
import { randomBytes } from 'crypto';
import { bdTodayKey } from './dateUtils.js';

export const DEFAULT_CHANNEL_URL = 'https://t.me/divinespiritpayoutproof';

// explorer + hash format per network (USDT is the token we pay in)
export const NETWORKS = {
  TON:  { label: 'TON',  tx: 'https://tonviewer.com/transaction/',   hash: /^(?:[0-9a-fA-F]{64}|[A-Za-z0-9_+/-]{43}=?)$/ },
  TRON: { label: 'TRON', tx: 'https://tronscan.org/#/transaction/',  hash: /^[0-9a-fA-F]{64}$/ },
  BSC:  { label: 'BSC',  tx: 'https://bscscan.com/tx/',              hash: /^0x[0-9a-fA-F]{64}$/ },
  ETH:  { label: 'ETH',  tx: 'https://etherscan.io/tx/',             hash: /^0x[0-9a-fA-F]{64}$/ },
};
export const DEFAULT_NETWORK = 'TON';
export const DEFAULT_TOKEN = 'USDT';
export const VERIFIED_BY = ['onchain', 'admin_hash', 'admin_attested', 'backfill_onchain', 'backfill_attested'];
export const VERIFIED_LABEL = {
  onchain: 'Verified on-chain', backfill_onchain: 'Verified on-chain',
  admin_hash: 'Verified by admin (hash)', admin_attested: 'Confirmed by admin', backfill_attested: 'Confirmed by admin',
};

const round4 = (n) => Math.round(Number(n) * 1e4) / 1e4;
export const isDupKey = (e) => !!e && (e.code === 11000 || /E11000/.test(String(e.message || '')));

// ── cache for the public numbers (5 s) — a new payout clears it at once ──────
let statsCache = null, statsAt = 0;
export function bumpPayoutVersion() { statsCache = null; statsAt = 0; }

// ── channel URL (configurable from the admin panel) ──────────────────────────
// Accepts: https://t.me/name · t.me/name · @name · name · https://t.me/+inviteHash · https://t.me/joinchat/hash
export function normalizeChannelUrl(input) {
  let s = String(input ?? '').trim();
  if (!s || s.length > 200) return null;
  if (s.startsWith('@')) s = 'https://t.me/' + s.slice(1);
  else if (/^(?:www\.)?(?:t|telegram)\.me\//i.test(s)) s = 'https://' + s;
  else if (/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(s)) s = 'https://t.me/' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!['t.me', 'www.t.me', 'telegram.me', 'www.telegram.me'].includes(u.hostname.toLowerCase())) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (!parts.length || parts.length > 2) return null;
  const first = parts[0];
  if (/^\+[A-Za-z0-9_-]{8,}$/.test(first) && parts.length === 1) return `https://t.me/${first}`;
  if (first === 'joinchat') return parts[1] && /^[A-Za-z0-9_-]{8,}$/.test(parts[1]) ? `https://t.me/joinchat/${parts[1]}` : null;
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(first)) return null;
  return `https://t.me/${first}`;                       // a post link (t.me/name/12) is reduced to the channel itself
}
// public channel → "@name" (the bot can post there); invite links have no @name
export function channelChat(url) {
  const m = String(url || '').match(/^https:\/\/t\.me\/([A-Za-z][A-Za-z0-9_]{4,31})$/);
  return m ? '@' + m[1] : null;
}
export async function getChannelUrl(db) {
  try {
    const d = await db.collection('botSettings').findOne({ _id: 'payoutChannel' });
    const n = d && normalizeChannelUrl(d.url);
    if (n) return n;
  } catch { /* fall through to the default */ }
  return normalizeChannelUrl(process.env.PAYOUT_CHANNEL_URL) || DEFAULT_CHANNEL_URL;
}
export async function setChannelUrl(db, url, adminId) {
  const n = normalizeChannelUrl(url);
  if (!n) return null;
  await db.collection('botSettings').updateOne({ _id: 'payoutChannel' }, { $set: { url: n, updatedAt: new Date(), updatedBy: String(adminId || '') } }, { upsert: true });
  return n;
}
export async function resetChannelUrl(db) {
  await db.collection('botSettings').deleteOne({ _id: 'payoutChannel' });
}

// ── privacy helpers (the only forms of name / wallet that ever leave the server) ──
export function maskName(u) {
  const base = String((u && (u.username || u.firstName)) || 'User').replace(/^@/, '').replace(/[\u0000-\u001f<>"'&]/g, '').trim();
  const chars = Array.from(base);
  if (!chars.length) return 'Us****';
  return chars.slice(0, chars.length > 3 ? 2 : 1).join('') + '****';
}
export function shortAddr(a) {
  const s = String(a || '');
  return s.length <= 14 ? s : `${s.slice(0, 6)}...${s.slice(-6)}`;
}
export function txUrl(network, hash) {
  const n = NETWORKS[network];
  return n && hash ? n.tx + encodeURIComponent(String(hash).trim()) : null;
}
export function validTxHash(network, hash) {
  const n = NETWORKS[network];
  return !!n && n.hash.test(String(hash || '').trim());
}
export function hashFromTxLink(link) {   // "https://tonviewer.com/transaction/<hash>" → hash   (a wallet link has no hash)
  const m = String(link || '').match(/\/transaction\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
export const makeTxId = () => `DSP-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;

// ── RECORD A SUCCESSFUL PAYOUT ───────────────────────────────────────────────
// w = the withdrawals document.  opts = { network, txHash, paidAmount, verifiedBy, adminId, paidAt }
// Safe to call twice: the second call returns { duplicate: true } and changes nothing.
export async function recordSuccessfulPayout(db, w, opts = {}) {
  if (!w || !w._id) return { ok: false, error: 'withdrawal_missing' };
  const network = opts.network || DEFAULT_NETWORK;
  if (!NETWORKS[network]) return { ok: false, error: 'bad_network' };
  const verifiedBy = opts.verifiedBy;
  if (!VERIFIED_BY.includes(verifiedBy)) return { ok: false, error: 'bad_verification' };
  const paid = round4(opts.paidAmount ?? w.usdtAmount);
  if (!Number.isFinite(paid) || paid <= 0 || paid > 100000) return { ok: false, error: 'bad_amount' };
  let hash = opts.txHash ? String(opts.txHash).trim() : null;
  if (hash && !validTxHash(network, hash)) return { ok: false, error: 'bad_hash' };
  if (!hash && (verifiedBy === 'onchain' || verifiedBy === 'admin_hash' || verifiedBy === 'backfill_onchain')) return { ok: false, error: 'hash_required' };

  const col = db.collection('payouts');
  const existing = await col.findOne({ withdrawalId: w._id, status: 'success' });
  if (existing) return { ok: true, duplicate: true, payout: existing };
  if (hash && await col.findOne({ network, txHash: hash, status: 'success' })) return { ok: false, error: 'duplicate_hash' };

  const doc = {
    txId: makeTxId(),
    withdrawalId: w._id,
    serial: w.serial || null,
    telegramId: String(w.telegramId),
    username: w.username || '',
    firstName: w.firstName || '',
    address: String(w.address || ''),               // full address: stored for the admin only, never sent to the public API
    network,
    token: DEFAULT_TOKEN,
    requestedEg: Number(w.egAmount) || 0,           // what the player asked for ($Devine)
    requestedUsd: round4(w.usdtAmount),             // net USDT the player was owed
    paidAmount: paid,                               // what was really sent
    usdValue: round4(opts.usdValue ?? paid),        // USD equivalent (USDT = 1 USD)
    txHash: hash,
    txUrl: txUrl(network, hash),
    status: 'success',
    verifiedBy,
    recordedBy: String(opts.adminId || 'system'),
    paidAt: opts.paidAt instanceof Date ? opts.paidAt : new Date(),
    createdAt: new Date(),
  };
  try {
    await col.insertOne(doc);
  } catch (e) {
    if (isDupKey(e)) {                               // someone recorded it a moment ago (double tap / two servers)
      const again = await col.findOne({ withdrawalId: w._id, status: 'success' });
      return again ? { ok: true, duplicate: true, payout: again } : { ok: false, error: 'duplicate_hash' };
    }
    throw e;
  }
  await db.collection('withdrawals').updateOne({ _id: w._id }, { $set: { payoutId: doc.txId, payoutNetwork: network, payoutVerified: true, payoutRecordedAt: doc.paidAt } });
  bumpPayoutVersion();
  return { ok: true, payout: doc };
}

// admin fixes the hash / network of a recorded payout
export async function updatePayoutHash(db, withdrawalId, network, hash) {
  if (!NETWORKS[network]) return { ok: false, error: 'bad_network' };
  const h = String(hash || '').trim();
  if (!validTxHash(network, h)) return { ok: false, error: 'bad_hash' };
  const col = db.collection('payouts');
  const dup = await col.findOne({ network, txHash: h, status: 'success', withdrawalId: { $ne: withdrawalId } });
  if (dup) return { ok: false, error: 'duplicate_hash' };
  let r;
  try {
    r = await col.findOneAndUpdate({ withdrawalId, status: 'success' }, { $set: { network, txHash: h, txUrl: txUrl(network, h), verifiedBy: 'admin_hash', editedAt: new Date() } }, { returnDocument: 'after' });
  } catch (e) { if (isDupKey(e)) return { ok: false, error: 'duplicate_hash' }; throw e; }
  const p = r?.value !== undefined ? r.value : r;
  if (!p) return { ok: false, error: 'not_found' };
  await db.collection('withdrawals').updateOne({ _id: withdrawalId }, { $set: { payoutNetwork: network } });
  bumpPayoutVersion();
  return { ok: true, payout: p };
}

// admin undo for a payout recorded by mistake: it stops counting everywhere (the row is kept, marked 'voided')
export async function voidPayout(db, withdrawalId, adminId) {
  const r = await db.collection('payouts').findOneAndUpdate({ withdrawalId, status: 'success' }, { $set: { status: 'voided', voidedAt: new Date(), voidedBy: String(adminId || '') } }, { returnDocument: 'after' });
  const p = r?.value !== undefined ? r.value : r;
  if (!p) return { ok: false, error: 'not_found' };
  await db.collection('withdrawals').updateOne({ _id: withdrawalId }, { $unset: { payoutId: '', payoutNetwork: '', payoutVerified: '', payoutRecordedAt: '' } });
  bumpPayoutVersion();
  return { ok: true, payout: p };
}

// ── PUBLIC NUMBERS (calculated from the real records, every time) ────────────
export function todayStartBD(now = new Date()) {
  return new Date(`${bdTodayKey(now)}T00:00:00+06:00`);       // "today" = Bangladesh day, same as the rest of the project
}
export async function getPayoutStats(db) {
  if (statsCache && Date.now() - statsAt < 5000) return statsCache;
  const col = db.collection('payouts');
  const ok = { status: 'success' };
  const [tot, ply, tod, last] = await Promise.all([
    col.aggregate([{ $match: ok }, { $group: { _id: null, usd: { $sum: '$usdValue' }, n: { $sum: 1 } } }]).toArray(),
    col.aggregate([{ $match: ok }, { $group: { _id: '$telegramId' } }, { $group: { _id: null, n: { $sum: 1 } } }]).toArray(),
    col.aggregate([{ $match: { ...ok, paidAt: { $gte: todayStartBD() } } }, { $group: { _id: null, usd: { $sum: '$usdValue' }, n: { $sum: 1 } } }]).toArray(),
    col.find(ok).sort({ paidAt: -1, txId: -1 }).limit(1).project({ txId: 1, paidAt: 1 }).toArray(),
  ]);
  statsCache = {
    totalUsd: round4(tot[0]?.usd || 0),
    payouts: tot[0]?.n || 0,
    players: ply[0]?.n || 0,
    todayUsd: round4(tod[0]?.usd || 0),
    todayCount: tod[0]?.n || 0,
    lastTxId: last[0]?.txId || null,
    updatedAt: Date.now(),
  };
  statsAt = Date.now();
  return statsCache;
}

// public list item: masked name, short wallet, nothing else that identifies the player
export function publicItem(p) {
  return {
    id: p.txId,
    name: maskName(p),
    network: p.network,
    token: p.token || DEFAULT_TOKEN,
    wallet: shortAddr(p.address),
    amount: round4(p.usdValue),
    paidAt: new Date(p.paidAt).getTime(),
    txUrl: p.txUrl || null,
    verified: p.verifiedBy === 'onchain' || p.verifiedBy === 'backfill_onchain' ? 'onchain' : 'admin',
  };
}
// newest first; cursor = "<paidAt ms>_<txId>"
export async function listPublicPayouts(db, { limit = 20, before = null } = {}) {
  const lim = Math.min(50, Math.max(1, Number(limit) | 0 || 20));
  const q = { status: 'success' };
  if (before) {
    const i = String(before).indexOf('_');
    const ms = Number(String(before).slice(0, i < 0 ? undefined : i)), id = i < 0 ? '' : String(before).slice(i + 1);
    if (Number.isFinite(ms) && ms > 0) {
      const d = new Date(ms);
      q.$or = [{ paidAt: { $lt: d } }, ...(id ? [{ paidAt: d, txId: { $lt: id } }] : [])];
    }
  }
  const rows = await db.collection('payouts').find(q).sort({ paidAt: -1, txId: -1 }).limit(lim + 1)
    .project({ txId: 1, username: 1, firstName: 1, network: 1, token: 1, address: 1, usdValue: 1, paidAt: 1, txUrl: 1, verifiedBy: 1 }).toArray();
  const more = rows.length > lim, page = more ? rows.slice(0, lim) : rows;
  const last = page[page.length - 1];
  return { items: page.map(publicItem), nextCursor: more && last ? `${new Date(last.paidAt).getTime()}_${last.txId}` : null };
}

// ── ADMIN: filters, search, back-fill ────────────────────────────────────────
export const ST_ORDER = ['a', 's', 'p', 'u', 'r'];
export const ST_LABEL = { a: 'All', s: '✅ Paid', p: '⏳ Pending', u: '🧾 Approved · not recorded', r: '❌ Rejected' };
export const NW_ORDER = ['a', 'T', 'R', 'B', 'E'];
export const NW_CODE = { T: 'TON', R: 'TRON', B: 'BSC', E: 'ETH' };
export const NW_LABEL = { a: 'All', T: 'TON', R: 'TRON', B: 'BSC', E: 'ETH' };
export const DT_ORDER = ['a', 't', 'w', 'm'];
export const DT_LABEL = { a: 'All time', t: 'Today', w: '7 days', m: '30 days' };

export function buildAdminFilter({ st = 'a', nw = 'a', dt = 'a' } = {}) {
  const and = [];
  if (st === 's') and.push({ payoutId: { $exists: true } });
  else if (st === 'p') and.push({ status: 'pending' });
  else if (st === 'u') and.push({ status: 'approved', payoutId: { $exists: false } });
  else if (st === 'r') and.push({ status: 'rejected' });
  if (nw === 'T') and.push({ $or: [{ payoutNetwork: 'TON' }, { payoutNetwork: { $exists: false } }] });   // every wallet is TON unless a payout says otherwise
  else if (NW_CODE[nw]) and.push({ payoutNetwork: NW_CODE[nw] });
  if (dt !== 'a') {
    const from = dt === 't' ? todayStartBD() : new Date(Date.now() - (dt === 'w' ? 7 : 30) * 86400000);
    and.push(st === 's' ? { payoutRecordedAt: { $gte: from } } : { createdAt: { $gte: from } });
  }
  return and.length ? { $and: and } : {};
}
export const nextCode = (order, cur) => order[(order.indexOf(cur) + 1) % order.length];

// find withdrawals by user id · tx id (DSP-…) · tx hash · withdraw number (#12) · withdrawal id
export async function adminSearch(db, raw, toObjectId) {
  const q = String(raw || '').trim();
  const W = db.collection('withdrawals'), P = db.collection('payouts');
  if (!q) return [];
  const byPayout = async (p) => (p ? W.find({ _id: p.withdrawalId }).toArray() : []);
  if (/^DSP-/i.test(q)) return byPayout(await P.findOne({ txId: q.toUpperCase() }));
  if (q.length >= 40) return byPayout(await P.findOne({ txHash: q }));                        // transaction hash
  if (/^#\d{1,7}$/.test(q)) return W.find({ serial: Number(q.slice(1)) }).limit(10).toArray(); // "#12" = withdraw number
  if (/^\d{1,12}$/.test(q)) {                                                                   // digits: a Telegram ID, or (short ones) a withdraw number
    const or = [{ telegramId: q }, ...(q.length <= 7 ? [{ serial: Number(q) }] : [])];
    return W.find({ $or: or }).sort({ createdAt: -1 }).limit(10).toArray();
  }
  if (/^[a-f0-9]{24}$/i.test(q) && toObjectId) { try { return await W.find({ _id: toObjectId(q) }).toArray(); } catch { return []; } }
  return byPayout(await P.findOne({ txHash: q }));
}

// old approved withdrawals → payouts.  includeAttested=false imports only the ones the bot/admin already confirmed as paid.
export async function backfillPayouts(db, { includeAttested = false, adminId = '' } = {}) {
  const W = db.collection('withdrawals');
  const cur = W.find({ status: 'approved', payoutId: { $exists: false } }).sort({ processedAt: 1 }).batchSize(200);
  const out = { imported: 0, skipped: 0, duplicates: 0, failed: 0 };
  for await (const w of cur) {
    const confirmed = w.payoutStatus === 'sent' || w.payoutStatus === 'manual_paid';
    if (!confirmed && !includeAttested) { out.skipped++; continue; }
    const hash = hashFromTxLink(w.txLink);
    const useHash = hash && validTxHash(DEFAULT_NETWORK, hash) ? hash : null;
    const r = await recordSuccessfulPayout(db, w, {
      network: DEFAULT_NETWORK, txHash: useHash, paidAmount: w.usdtAmount,
      verifiedBy: w.payoutStatus === 'sent' && useHash ? 'backfill_onchain' : 'backfill_attested',
      adminId, paidAt: w.payoutAt || w.manualPaidAt || w.processedAt || w.createdAt,
    });
    if (r.ok && r.duplicate) out.duplicates++; else if (r.ok) out.imported++; else out.failed++;
  }
  return out;
}
export async function backfillCounts(db) {
  const W = db.collection('withdrawals');
  const base = { status: 'approved', payoutId: { $exists: false } };
  const [confirmed, all] = await Promise.all([
    W.countDocuments({ ...base, payoutStatus: { $in: ['sent', 'manual_paid'] } }),
    W.countDocuments(base),
  ]);
  return { confirmed, attested: all - confirmed, all };
}
