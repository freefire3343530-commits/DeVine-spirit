// FILE PATH: lib/fraudScans.js
// Two more admin scanners in the same style as "Signup Bursts" (alert + buttons, nothing is blocked automatically):
//   💳 Shared Wallets  - one withdrawal wallet used by 2+ different accounts (the classic multi-account cash-out)
//   🧬 Referral Rings  - a referrer whose recent friends are mostly "dead" (never did anything) or share one signup IP
// The Lock / Ban / Members / Unlock buttons are the SAME ones as Signup Bursts (sb_* in lib/signupBursts.js) because
// every result is saved as a "cluster" of account IDs. Admin only; each scan = 1 aggregation, so it costs nothing until you tap it.
import { saveCluster } from './signupBursts.js';

const hx = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const FS = {
  WALLET_DAYS: 30, RING_DAYS: 7, RING_MIN: 5, SHOW: 6,
  IP_DAYS: 7, IP_MIN: 5,            // 🌐 one signup IP with 5+ accounts (carriers share IPs, so it is only flagged with more evidence)
  FAST_HOURS: 24, FAST_DAYS: 7,     // ⚡ withdrew within 24 h of signing up (last 7 days)
  TRAP_DAYS: 14,
};

// "alive" = did anything at all in the app (tasks, login bonus)
const ALIVE = { $or: [
  { $gt: [{ $ifNull: ['$tasksDoneTotal', 0] }, 0] },
  { $gt: [{ $size: { $ifNull: ['$completedTasks', []] } }, 0] },
  { $ne: [{ $ifNull: ['$loginBonus.lastDay', null] }, null] },
] };

// ── 💳 Shared wallets ─────────────────────────────────────────
export async function scanSharedWallets(db, days = FS.WALLET_DAYS) {
  const since = new Date(Date.now() - days * 86400000);
  return db.collection('withdrawals').aggregate([
    { $match: { createdAt: { $gte: since }, status: { $in: ['pending', 'approved'] } } },
    { $group: { _id: '$address', ids: { $addToSet: '$telegramId' }, n: { $sum: 1 }, usd: { $sum: '$usdtAmount' } } },
    { $match: { 'ids.1': { $exists: true } } },       // 2 or more DIFFERENT accounts
    { $sort: { n: -1 } },
    { $limit: FS.SHOW },
  ]).toArray();
}

// ── 🧬 Referral rings ─────────────────────────────────────────
export async function scanReferralRings(db, days = FS.RING_DAYS) {
  const since = new Date(Date.now() - days * 86400000);
  const rows = await db.collection('users').aggregate([
    { $match: { createdAt: { $gte: since }, referredBy: { $nin: [null, ''] } } },
    { $group: { _id: '$referredBy', n: { $sum: 1 }, dead: { $sum: { $cond: [ALIVE, 0, 1] } }, ips: { $push: '$signupIp' }, ids: { $push: '$telegramId' } } },
    { $match: { n: { $gte: FS.RING_MIN } } },
  ]).toArray();
  const out = [];
  for (const r of rows) {
    const cnt = new Map();
    for (const ip of r.ips) if (ip) cnt.set(ip, (cnt.get(ip) || 0) + 1);
    let topIp = null, ipN = 0;
    for (const [ip, c] of cnt) if (c > ipN) { topIp = ip; ipN = c; }
    const deadPct = r.dead / r.n, ipPct = ipN / r.n;
    if (deadPct < 0.5 && ipPct < 0.4) continue;              // looks healthy: do not bother the admin
    out.push({ referrer: String(r._id), n: r.n, dead: r.dead, topIp, ipN, ids: r.ids.map(String).slice(0, 1500),
      verdict: deadPct >= 0.8 || ipPct >= 0.6 ? '🔴 Looks like a referral farm' : '🟡 Suspicious: check the members first' });
  }
  out.sort((a, b) => b.n - a.n);
  return out.slice(0, FS.SHOW);
}

// ── 🌐 IP clusters (not only bursts: also slow "drip" signups from one IP) ──
export async function scanIpClusters(db, days = FS.IP_DAYS) {
  const since = new Date(Date.now() - days * 86400000);
  const rows = await db.collection('users').aggregate([
    { $match: { createdAt: { $gte: since }, signupIp: { $type: 'string' } } },
    { $group: { _id: '$signupIp', n: { $sum: 1 }, dead: { $sum: { $cond: [ALIVE, 0, 1] } }, refs: { $push: '$referredBy' }, ids: { $push: '$telegramId' } } },
    { $match: { n: { $gte: FS.IP_MIN } } },
    { $sort: { n: -1 } }, { $limit: 25 },
  ]).toArray();
  const out = [];
  for (const r of rows) {
    const cnt = new Map();
    for (const x of r.refs) if (x) cnt.set(x, (cnt.get(x) || 0) + 1);
    let topRef = null, refN = 0;
    for (const [k, c] of cnt) if (c > refN) { topRef = k; refN = c; }
    const deadPct = r.dead / r.n, refPct = refN / r.n;
    if (deadPct < 0.5 && refPct < 0.5 && r.n < 15) continue;   // many real people on one carrier IP: stay quiet
    out.push({ ip: String(r._id), n: r.n, dead: r.dead, topRef, refN, ids: r.ids.map(String).slice(0, 1500),
      verdict: deadPct >= 0.8 || refPct >= 0.8 || r.n >= 30 ? '🔴 Looks like one person with many accounts' : '🟡 Suspicious: check the members first' });
  }
  return out.slice(0, FS.SHOW);
}

// ── ⚡ Fast cash-out: asked for a withdrawal within hours of signing up ──
export async function scanFastCashout(db, days = FS.FAST_DAYS, hours = FS.FAST_HOURS) {
  const since = new Date(Date.now() - days * 86400000);
  const rows = await db.collection('withdrawals').aggregate([
    { $match: { createdAt: { $gte: since }, status: { $in: ['pending', 'approved'] } } },
    { $lookup: { from: 'users', localField: 'telegramId', foreignField: 'telegramId', as: 'u' } },
    { $unwind: '$u' },
    { $addFields: { ageH: { $divide: [{ $subtract: ['$createdAt', '$u.createdAt'] }, 3600000] } } },
    { $match: { ageH: { $gte: 0, $lte: hours } } },
    { $sort: { createdAt: -1 } }, { $limit: 40 },
    { $project: { telegramId: 1, egAmount: 1, usdtAmount: 1, status: 1, ageH: 1, address: 1, 'u.referredBy': 1, 'u.signupIp': 1, 'u.username': 1 } },
  ]).toArray();
  return rows;
}

// ── 🪤 Trap hits (lib/traps.js) ──
export async function scanTrapHits(db, days = FS.TRAP_DAYS) {
  const since = new Date(Date.now() - days * 86400000);
  const users = await db.collection('users').find({ trapHits: { $gt: 0 }, lastTrapAt: { $gte: since } },
    { projection: { telegramId: 1, username: 1, trapHits: 1, trapLog: 1, lastTrapAt: 1, accountLocked: 1, isBanned: 1, egBalance: 1 } }).sort({ lastTrapAt: -1 }).limit(8).toArray();
  const honey = await db.collection('trapEvents').countDocuments({ kind: 'honeypot_url', at: { $gte: since } });
  return { users, honey };
}

// ── screens ──────────────────────────────────────────────────
const clusterKb = (cid, n) => ({ inline_keyboard: [
  [{ text: '👁 Members (IDs + data)', callback_data: `sb_view_${cid}` }],
  [{ text: `🔒 Lock all ${n}`, callback_data: `sb_lock_${cid}` }, { text: `🚫 Ban all ${n}`, callback_data: `sb_banask_${cid}` }],
  [{ text: '✅ Real users — unlock', callback_data: `sb_clear_${cid}` }],
] });

// ctx: { db, chatId, msgId, send, edit, backKb }  → true = handled
export async function handleFraudCallback(data, ctx) {
  const { db, chatId, msgId, send, edit, backKb } = ctx;
  const menu = { inline_keyboard: [
    [{ text: '💳 Shared Wallets', callback_data: 'fs_wallet' }, { text: '🧬 Referral Rings', callback_data: 'fs_ring' }],
    [{ text: '🌐 IP Clusters', callback_data: 'fs_ip' }, { text: '⚡ Fast Cash-out', callback_data: 'fs_fast' }],
    [{ text: '🪤 Trap Hits', callback_data: 'fs_trap' }, { text: '🆕 Signup Bursts', callback_data: 'a_signups' }],
    [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }],
  ] };
  if (data === 'a_fraud') {
    await edit(chatId, msgId, '🕵️ <b>Fraud Scans</b>\n\n💳 <b>Shared Wallets</b>: one wallet cashing out for several accounts.\n🧬 <b>Referral Rings</b>: a referrer whose friends are fake or from one IP.\n🌐 <b>IP Clusters</b>: many accounts signed up from one IP (also slowly, not only in a burst).\n⚡ <b>Fast Cash-out</b>: withdrew within 24h of signing up.\n🪤 <b>Trap Hits</b>: people who sent requests the real app can never send.\n🆕 <b>Signup Bursts</b>: many accounts created at once.\n\n<i>Nothing is blocked automatically. You decide with the buttons.</i>', { reply_markup: menu });
    return true;
  }
  if (data === 'fs_ip') {
    await edit(chatId, msgId, '🌐 Scanning signup IPs of the last 7 days...');
    const rows = await scanIpClusters(db);
    await edit(chatId, msgId, `🌐 <b>IP Clusters</b> (last ${FS.IP_DAYS} days, ${FS.IP_MIN}+ accounts per IP)\n\n${rows.length ? `Found <b>${rows.length}</b> suspicious IP(s) ↓` : '🟢 No suspicious IP found.'}`, { reply_markup: menu });
    for (const r of rows) {
      const cid = await saveCluster(db, r.ids, 'ip');
      await send(chatId, `🌐 <b>IP</b> <code>${hx(r.ip)}</code> · <b>${r.n}</b> accounts\n💀 Never did anything: <b>${r.dead}/${r.n}</b> (${Math.round((100 * r.dead) / r.n)}%)\n🔗 Same referrer: <b>${r.refN}/${r.n}</b>${r.topRef ? ` (<code>${hx(r.topRef)}</code>)` : ''}\n\n<b>${r.verdict}</b>\n<i>Mobile carriers share one IP between many real people: open Members before you ban.</i>`, { reply_markup: clusterKb(cid, r.ids.length) });
    }
    return true;
  }
  if (data === 'fs_fast') {
    await edit(chatId, msgId, '⚡ Scanning withdrawals of the last 7 days...');
    const rows = await scanFastCashout(db);
    await edit(chatId, msgId, `⚡ <b>Fast Cash-out</b> (withdrew within ${FS.FAST_HOURS}h of signing up, last ${FS.FAST_DAYS} days)\n\n${rows.length ? `Found <b>${rows.length}</b> withdrawal(s) ↓` : '🟢 Nobody cashed out that fast.'}`, { reply_markup: menu });
    if (rows.length) {
      const ids = [...new Set(rows.map((r) => String(r.telegramId)))];
      const cid = await saveCluster(db, ids, 'fast');
      const lines = rows.slice(0, 15).map((r) => `• <code>${r.telegramId}</code>${r.u?.username ? ' @' + hx(r.u.username) : ''} · ${r.egAmount} $Devine · <b>${r.ageH.toFixed(1)}h</b> after signup · ${r.status}${r.u?.referredBy ? ` · ref <code>${hx(r.u.referredBy)}</code>` : ''}`).join('\n');
      await send(chatId, `⚡ <b>${ids.length} account(s) cashed out within ${FS.FAST_HOURS}h of joining</b>\n\n${lines}${rows.length > 15 ? `\n… and ${rows.length - 15} more` : ''}\n\n<i>A real new user can do this too. Check Members, then Lock the bad ones.</i>`, { reply_markup: clusterKb(cid, ids.length) });
    }
    return true;
  }
  if (data === 'fs_trap') {
    await edit(chatId, msgId, '🪤 Reading trap log...');
    const t = await scanTrapHits(db);
    await edit(chatId, msgId, `🪤 <b>Trap Hits</b> (last ${FS.TRAP_DAYS} days)\n\nUsers who hit a trap: <b>${t.users.length}</b>${t.users.length === 8 ? '+' : ''}\nHoney-pot URL hits (scanners): <b>${t.honey}</b>\n\n<i>A trap = a request the real app can never send. 3 hits = account auto-locked.</i>`, { reply_markup: menu });
    if (t.users.length) {
      const ids = t.users.map((u) => String(u.telegramId));
      const cid = await saveCluster(db, ids, 'trap');
      const lines = t.users.map((u) => `${u.isBanned ? '🚫' : u.accountLocked ? '🔒' : '•'} <code>${u.telegramId}</code>${u.username ? ' @' + hx(u.username) : ''} · <b>${u.trapHits}</b> hit(s) · ${Math.round(u.egBalance || 0)} $Devine\n     ${(u.trapLog || []).slice(-3).map((x) => hx(x.k) + (x.d ? ` (${hx(x.d)})` : '')).join(' · ')}`).join('\n');
      await send(chatId, `🪤 <b>Latest trap hits</b>\n\n${lines}`, { reply_markup: clusterKb(cid, ids.length) });
    }
    return true;
  }
  if (data === 'fs_wallet') {
    await edit(chatId, msgId, '💳 Scanning withdrawal wallets of the last 30 days...');
    const rows = await scanSharedWallets(db);
    await edit(chatId, msgId, `💳 <b>Shared Wallets</b> (last ${FS.WALLET_DAYS} days)\n\n${rows.length ? `Found <b>${rows.length}</b> wallet(s) used by 2+ accounts ↓` : '🟢 No wallet is used by more than one account.'}`, { reply_markup: menu });
    for (const r of rows) {
      const ids = r.ids.map(String);
      const cid = await saveCluster(db, ids, 'wallet');
      await send(chatId, `💳 <b>One wallet, ${ids.length} accounts</b>\n📍 <code>${hx(r._id)}</code>\n💸 ${r.n} withdrawals · $${(r.usd || 0).toFixed(2)} total\n👤 ${ids.map((i) => `<code>${i}</code>`).join(', ')}\n\n<b>${ids.length >= 3 ? '🔴 Very likely one person with many accounts.' : '🟡 Could be family or friends: open Members and check.'}</b>`, { reply_markup: clusterKb(cid, ids.length) });
    }
    return true;
  }
  if (data === 'fs_ring') {
    await edit(chatId, msgId, '🧬 Scanning referrals of the last 7 days...');
    const rows = await scanReferralRings(db);
    await edit(chatId, msgId, `🧬 <b>Referral Rings</b> (last ${FS.RING_DAYS} days, ${FS.RING_MIN}+ friends)\n\n${rows.length ? `Found <b>${rows.length}</b> suspicious referrer(s) ↓` : '🟢 No suspicious referrer found.'}`, { reply_markup: menu });
    for (const r of rows) {
      const cid = await saveCluster(db, [r.referrer, ...r.ids], 'ring');
      await send(chatId, `🧬 <b>Referrer</b> <code>${hx(r.referrer)}</code> · <b>${r.n}</b> friends\n💀 Never did anything: <b>${r.dead}/${r.n}</b> (${Math.round((100 * r.dead) / r.n)}%)\n🌐 Same signup IP: <b>${r.ipN}/${r.n}</b>${r.topIp ? ` (<code>${hx(r.topIp)}</code>)` : ''}\n\n<b>${r.verdict}</b>\n<i>Lock/Ban below affects the referrer AND all ${r.n} friends.</i>`, { reply_markup: clusterKb(cid, r.ids.length + 1) });
    }
    return true;
  }
  return false;
}
