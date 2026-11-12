// FILE PATH: lib/payoutAdmin.js
// 💸 PAYOUT MANAGEMENT — the admin side of the Payout Proof system, inside the existing Telegram admin panel.
// api/bot.js calls handlePayoutCallback / handlePayoutText (admin only: bot.js already rejects everyone else before this runs).
//
//   Dashboard      totals, today, pending requests, approved-but-not-recorded, channel URL
//   Transactions   all withdrawals, filter by status · network · date, 6 per page, tap one for the full details
//   Search         by user ID, transaction ID (DSP-…), tx hash, withdraw number (#12) or withdrawal id
//   Record payment after paying by hand: choose network → send tx hash → confirm the amount actually paid
//   Edit / Void    fix a wrong hash, or undo a payout recorded by mistake (it stops counting at once)
//   Channel URL    the public Telegram payout channel (used by the app button, the bot menu and the proof posts)
//   Import old     turn old approved withdrawals into payout records (confirmed ones, or all of them after you vouch)
import {
  NETWORKS, DEFAULT_NETWORK, VERIFIED_LABEL, recordSuccessfulPayout, updatePayoutHash, voidPayout, getPayoutStats,
  getChannelUrl, setChannelUrl, resetChannelUrl, channelChat, normalizeChannelUrl, validTxHash,
  ST_ORDER, ST_LABEL, NW_ORDER, NW_LABEL, DT_ORDER, DT_LABEL, buildAdminFilter, nextCode, adminSearch, backfillPayouts, backfillCounts,
} from './payouts.js';
import { checkBotAdmin } from './tg.js';
import { fmtBDDateTime } from './cycleStats.js';
import { wdNo } from './wdSerial.js';

const esc = (v) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const usd = (n) => `$${Number(n || 0).toFixed(4)}`;
const PAGE = 6;
const menuKb = { inline_keyboard: [[{ text: '◀️ Payout Management', callback_data: 'a_payouts' }], [{ text: '🏠 Admin menu', callback_data: 'a_menu' }]] };

export const isPayoutCallback = (d) => /^(a_payouts|apl_|apd_|ppn_|ppnh_|ppa_|ppe_|ppv_|ppvy_|a_pps|a_ppch|ppch_|a_ppbf|ppbf_)/.test(d);

const statusLabel = (w) => {
  if (w.payoutId) return '✅ Paid';
  if (w.status === 'pending') return '⏳ Pending';
  if (w.status === 'rejected') return '❌ Rejected';
  if (w.status === 'approved') return w.payoutStatus === 'unknown' || w.payoutStatus === 'failed' ? '⚠️ Payment unclear' : '🧾 Approved · not recorded';
  return esc(w.status || '?');
};

// ── DASHBOARD ────────────────────────────────────────────────────────────────
async function dashboard(ctx) {
  const { db } = ctx;
  const [s, url, pending, unrec] = await Promise.all([
    getPayoutStats(db), getChannelUrl(db),
    db.collection('withdrawals').countDocuments({ status: 'pending' }),
    db.collection('withdrawals').countDocuments({ status: 'approved', payoutId: { $exists: false } }),
  ]);
  const text =
    `💸 <b>Payout Management</b>\n\n` +
    `✅ <b>Total paid:</b> ${usd(s.totalUsd)}\n` +
    `🧾 Payouts: <b>${s.payouts}</b> · 👥 Players paid: <b>${s.players}</b>\n\n` +
    `📅 <b>Today:</b> ${usd(s.todayUsd)} · <b>${s.todayCount}</b> payout(s)\n\n` +
    `⏳ Pending requests: <b>${pending}</b>\n` +
    `🧾 Approved but not recorded as paid: <b>${unrec}</b>${unrec ? ' ← not counted in the public numbers yet' : ''}\n\n` +
    `🔗 Channel: ${esc(url)}\n\n` +
    `<i>Only payments recorded as paid are counted. Requested / approved / rejected / failed withdrawals never are.</i>`;
  const kb = { inline_keyboard: [
    [{ text: '📋 Transactions', callback_data: 'apl_aaa_0' }, { text: '🔎 Search', callback_data: 'a_pps' }],
    [{ text: `⏳ Requests (${pending})`, callback_data: 'apl_paa_0' }, { text: `🧾 Not recorded (${unrec})`, callback_data: 'apl_uaa_0' }],
    [{ text: '🔗 Channel URL', callback_data: 'a_ppch' }, { text: '📥 Import old payouts', callback_data: 'a_ppbf' }],
    [{ text: '🏠 Admin menu', callback_data: 'a_menu' }],
  ] };
  return { text, kb };
}

// ── TRANSACTION LIST ─────────────────────────────────────────────────────────
async function listView(ctx, st, nw, dt, page) {
  const W = ctx.db.collection('withdrawals');
  const filter = buildAdminFilter({ st, nw, dt });
  const sortKey = st === 's' ? { payoutRecordedAt: -1, _id: -1 } : { createdAt: -1, _id: -1 };
  const [rows, total] = await Promise.all([
    W.find(filter).sort(sortKey).skip(page * PAGE).limit(PAGE + 1).toArray(),
    W.countDocuments(filter),
  ]);
  const more = rows.length > PAGE, list = more ? rows.slice(0, PAGE) : rows;
  const head = `📋 <b>Transactions</b> (${total})\nStatus: <b>${ST_LABEL[st]}</b> · Network: <b>${NW_LABEL[nw]}</b> · Date: <b>${DT_LABEL[dt]}</b>\n<i>Date = request date (Paid: payment date)</i>\n\n`;
  const body = list.length
    ? list.map((w) => `${w.serial ? wdNo(w) + ' ' : ''}<code>${esc(w.telegramId)}</code> · <b>${usd(w.usdtAmount)}</b> · ${statusLabel(w)} · ${esc(w.payoutNetwork || DEFAULT_NETWORK)} · ${fmtBDDateTime(w.payoutRecordedAt || w.createdAt)}`).join('\n')
    : 'Nothing found with these filters.';
  const code = `${st}${nw}${dt}`;
  const kb = { inline_keyboard: [
    ...list.map((w) => [{ text: `🔍 ${w.serial ? wdNo(w) : ''} ${w.telegramId} · ${usd(w.usdtAmount)}`.trim(), callback_data: `apd_${w._id}` }]),
    [
      { text: `Status: ${ST_LABEL[st].replace(/^\S+ /, '')}`, callback_data: `apl_${nextCode(ST_ORDER, st)}${nw}${dt}_0` },
      { text: `Net: ${NW_LABEL[nw]}`, callback_data: `apl_${st}${nextCode(NW_ORDER, nw)}${dt}_0` },
      { text: `Date: ${DT_LABEL[dt]}`, callback_data: `apl_${st}${nw}${nextCode(DT_ORDER, dt)}_0` },
    ],
    [...(page > 0 ? [{ text: '◀️ Prev', callback_data: `apl_${code}_${page - 1}` }] : []), ...(more ? [{ text: 'Next ▶️', callback_data: `apl_${code}_${page + 1}` }] : [])],
    [{ text: '◀️ Payout Management', callback_data: 'a_payouts' }],
  ].filter((r) => r.length) };
  return { text: head + body, kb };
}

// ── ONE RECORD ───────────────────────────────────────────────────────────────
async function detailView(ctx, wid) {
  const { db, ObjectId } = ctx;
  let id; try { id = new ObjectId(wid); } catch { return { text: '❌ Invalid id.', kb: menuKb }; }
  const w = await db.collection('withdrawals').findOne({ _id: id });
  if (!w) return { text: '❌ Withdrawal not found.', kb: menuKb };
  const p = await db.collection('payouts').findOne({ withdrawalId: w._id, status: 'success' });
  const text =
    `🧾 <b>${w.serial ? 'Withdrawal ' + wdNo(w) : 'Withdrawal'}</b> — ${statusLabel(w)}\n\n` +
    `👤 <b>${esc(w.firstName || 'User')}</b>${w.username ? ' (@' + esc(w.username) + ')' : ''} · ID <code>${esc(w.telegramId)}</code>\n` +
    `💰 Requested: ${Number(w.egAmount || 0).toLocaleString('en')} $Devine → <b>${usd(w.usdtAmount)}</b> (net of ${w.feePercent ?? 5}% fee)\n` +
    `📍 <code>${esc(w.address)}</code>\n` +
    `🕒 Requested: ${fmtBDDateTime(w.createdAt)}${w.processedAt ? `\n🕒 Processed: ${fmtBDDateTime(w.processedAt)}` : ''}\n` +
    (w.payoutStatus ? `⚙️ Payment flag: <b>${esc(w.payoutStatus)}</b>${w.payoutError ? ' — ' + esc(w.payoutError) : ''}\n` : '') +
    (p
      ? `\n✅ <b>PAID</b> — counted in Payout Proof\n🆔 Tx ID: <code>${esc(p.txId)}</code>\n🌐 Network: <b>${esc(p.token)} · ${esc(p.network)}</b>\n💵 Paid: <b>${usd(p.paidAmount)}</b> (USD ${usd(p.usdValue)})\n🔗 Hash: ${p.txHash ? `<code>${esc(p.txHash)}</code>` : '<i>none (admin confirmed)</i>'}\n🕒 Paid at: ${fmtBDDateTime(p.paidAt)}\n🛡 ${esc(VERIFIED_LABEL[p.verifiedBy] || p.verifiedBy)}`
      : `\n⚪ <b>Not counted</b> in Payout Proof${w.status === 'approved' ? ' — record the payment below once it is really paid.' : '.'}`);
  const rows = [];
  if (!p && w.status === 'pending') rows.push([{ text: '💸 Open request (approve / reject)', callback_data: `wd_view_${w._id}` }]);
  if (!p && w.status === 'approved') rows.push([{ text: '🧾 Record payment (hash + amount)', callback_data: `wd_paid_${w._id}` }]);
  if (p) {
    if (p.txUrl) rows.push([{ text: '🔗 View transaction', url: p.txUrl }]);
    rows.push([{ text: '✏️ Edit tx hash / network', callback_data: `ppe_${w._id}` }, { text: '🗑 Void payout', callback_data: `ppv_${w._id}` }]);
  }
  rows.push([{ text: '👤 View user', callback_data: `lookup_${w.telegramId}` }], [{ text: '◀️ Payout Management', callback_data: 'a_payouts' }]);
  return { text, kb: { inline_keyboard: rows } };
}

// ── RECORD A PAYMENT (after paying by hand) ──────────────────────────────────
function recordKb(wid, network) {
  return { inline_keyboard: [
    Object.keys(NETWORKS).map((k) => ({ text: (k === network ? '✅ ' : '') + k, callback_data: `ppn_${wid}_${k}` })),
    [{ text: '✅ Paid — I have no hash (admin confirmed)', callback_data: `ppnh_${wid}` }],
    [{ text: '⏭ Skip for now (not counted)', callback_data: 'a_payouts' }],
  ] };
}
const recordText = (w, network) =>
  `🧾 <b>Record payout ${w.serial ? wdNo(w) : ''}</b>\n\n👤 <code>${esc(w.telegramId)}</code> · ${usd(w.usdtAmount)} USDT\n📍 <code>${esc(w.address)}</code>\n\n` +
  `Only record this when the money has <b>really been sent</b>. It then appears in the public Payout Proof.\n\n` +
  `🌐 Network: <b>${network}</b> (tap to change)\n👉 Now <b>send the transaction hash</b> as a message.`;

export async function startPayoutRecord(ctx, w, network = DEFAULT_NETWORK) {
  ctx.state[ctx.fromId] = { step: 'pp_hash', wid: String(w._id), network };
  await ctx.send(ctx.chatId, recordText(w, network), { reply_markup: recordKb(String(w._id), network), disable_web_page_preview: true });
}

async function askAmount(ctx, w, s) {
  s.step = 'pp_amount';
  await ctx.send(ctx.chatId,
    `💵 <b>How much was actually paid?</b>\n\nRequested (net): <b>${usd(w.usdtAmount)}</b> USDT\nNetwork: <b>${esc(s.network)}</b> · Hash: ${s.hash ? '<code>' + esc(s.hash) + '</code>' : '<i>none (admin confirmed)</i>'}\n\nTap the button if the full amount was paid, or send the real amount in USD (e.g. <code>0.0475</code>).`,
    { reply_markup: { inline_keyboard: [[{ text: `✅ Same as requested (${usd(w.usdtAmount)})`, callback_data: `ppa_${s.wid}` }], [{ text: '❌ Cancel', callback_data: 'a_payouts' }]] } });
}

const ERR = {
  bad_hash: '❌ That does not look like a valid transaction hash for this network.',
  hash_required: '❌ A transaction hash is required for this verification type.',
  duplicate_hash: '❌ This transaction hash is already used by another payout. A transaction can be counted only once.',
  bad_amount: '❌ Invalid amount.', bad_network: '❌ Invalid network.', not_found: '❌ Payout not found.', withdrawal_missing: '❌ Withdrawal not found.',
};

async function finishRecord(ctx, s, amount) {
  const { db, ObjectId } = ctx;
  let w; try { w = await db.collection('withdrawals').findOne({ _id: new ObjectId(s.wid) }); } catch { w = null; }
  delete ctx.state[ctx.fromId];
  if (!w) { await ctx.send(ctx.chatId, ERR.withdrawal_missing, { reply_markup: menuKb }); return; }
  if (w.status !== 'approved') {
    await ctx.send(ctx.chatId, w.status === 'pending' ? '❌ This withdrawal is still <b>pending</b>. Approve it first, pay it, then record the payment.' : `❌ This withdrawal is <b>${esc(w.status)}</b>, so it cannot be recorded as paid.`, { reply_markup: menuKb });
    return;
  }
  const r = await recordSuccessfulPayout(db, w, { network: s.network, txHash: s.hash || null, paidAmount: amount, verifiedBy: s.hash ? 'admin_hash' : 'admin_attested', adminId: ctx.fromId });
  if (!r.ok) { await ctx.send(ctx.chatId, ERR[r.error] || `❌ Could not record (${esc(r.error)}).`, { reply_markup: menuKb }); return; }
  if (r.duplicate) { await ctx.send(ctx.chatId, `ℹ️ Already recorded: <code>${esc(r.payout.txId)}</code>. Nothing changed.`, { reply_markup: menuKb }); return; }
  await db.collection('withdrawals').updateOne({ _id: w._id }, { $set: { payoutStatus: w.payoutStatus === 'sent' ? 'sent' : 'manual_paid', manualPaidAt: new Date() } });
  const p = r.payout, diff = Math.abs(p.paidAmount - Number(w.usdtAmount || 0)) > 0.0001;
  await ctx.send(ctx.chatId,
    `✅ <b>Payout recorded</b>\n\n🆔 <code>${esc(p.txId)}</code>\n💵 ${usd(p.paidAmount)} · ${esc(p.token)} · ${esc(p.network)}\n🛡 ${esc(VERIFIED_LABEL[p.verifiedBy])}${diff ? `\n⚠️ Differs from the requested ${usd(w.usdtAmount)}` : ''}\n\nTotals and the Latest Payouts list in the app are updated.`,
    { reply_markup: { inline_keyboard: [[{ text: '🔍 Open record', callback_data: `apd_${w._id}` }], [{ text: '◀️ Payout Management', callback_data: 'a_payouts' }]] } });
}

// ── CHANNEL URL ──────────────────────────────────────────────────────────────
async function channelView(ctx) {
  const url = await getChannelUrl(ctx.db);
  const chat = channelChat(url);
  return {
    text: `🔗 <b>Payout channel</b>\n\nCurrent: ${esc(url)}\n\nThis link is used by the <b>“View All in Our Payouts Channel”</b> button in the app, the bot's <b>Payment Proofs</b> button and the <b>“New payout paid”</b> posts.\n${chat ? `Posts go to <b>${esc(chat)}</b> — the bot must be an <b>admin</b> of that channel.` : '⚠️ This is an invite link: the app button works, but the bot can only post to a public channel (<code>t.me/name</code>).'}`,
    kb: { inline_keyboard: [[{ text: '✏️ Change URL', callback_data: 'ppch_set' }, { text: '♻️ Reset to default', callback_data: 'ppch_reset' }], [{ text: '◀️ Payout Management', callback_data: 'a_payouts' }]] },
  };
}

// ── BUTTONS ──────────────────────────────────────────────────────────────────
export async function handlePayoutCallback(data, ctx) {
  const { db, chatId, msgId, edit, send, state, fromId, ObjectId } = ctx;
  const show = async (v) => edit(chatId, msgId, v.text, { reply_markup: v.kb, disable_web_page_preview: true });

  if (data === 'a_payouts') { delete state[fromId]; await show(await dashboard(ctx)); return true; }

  let m = data.match(/^apl_([a-z])([a-zA-Z])([a-z])_(\d+)$/);
  if (m) {
    const [, st, nw, dt, pg] = m;
    if (!ST_LABEL[st] || !NW_LABEL[nw] || !DT_LABEL[dt]) return true;
    await show(await listView(ctx, st, nw, dt, Math.min(1000, Number(pg))));
    return true;
  }
  if (data.startsWith('apd_')) { await show(await detailView(ctx, data.slice(4))); return true; }

  if (data === 'a_pps') {
    state[fromId] = { step: 'pp_search' };
    await edit(chatId, msgId, '🔎 <b>Search</b>\n\nSend a <b>user ID</b>, a <b>transaction ID</b> (<code>DSP-…</code>), a <b>tx hash</b> or a <b>withdraw number</b> (<code>#12</code>):', { reply_markup: menuKb });
    return true;
  }

  // network buttons while recording / editing
  m = data.match(/^ppn_([a-f0-9]{24})_([A-Z]+)$/);
  if (m) {
    const [, wid, net] = m;
    if (!NETWORKS[net]) return true;
    const w = await db.collection('withdrawals').findOne({ _id: new ObjectId(wid) });
    if (!w) { await edit(chatId, msgId, ERR.withdrawal_missing, { reply_markup: menuKb }); return true; }
    const cur = state[fromId];
    if (cur && cur.wid === wid && cur.step === 'pp_edithash') {
      cur.network = net;
      await edit(chatId, msgId, `✏️ <b>Edit transaction</b>\n\n🌐 Network: <b>${net}</b>\n👉 Send the <b>new transaction hash</b> as a message.`, { reply_markup: { inline_keyboard: [Object.keys(NETWORKS).map((k) => ({ text: (k === net ? '✅ ' : '') + k, callback_data: `ppn_${wid}_${k}` })), [{ text: '❌ Cancel', callback_data: 'a_payouts' }]] } });
      return true;
    }
    state[fromId] = { step: 'pp_hash', wid, network: net };
    await edit(chatId, msgId, recordText(w, net), { reply_markup: recordKb(wid, net), disable_web_page_preview: true });
    return true;
  }
  m = data.match(/^ppnh_([a-f0-9]{24})$/);               // paid, but the admin has no hash
  if (m) {
    const w = await db.collection('withdrawals').findOne({ _id: new ObjectId(m[1]) });
    if (!w) { await edit(chatId, msgId, ERR.withdrawal_missing, { reply_markup: menuKb }); return true; }
    const s = state[fromId] && state[fromId].wid === m[1] ? state[fromId] : (state[fromId] = { wid: m[1], network: DEFAULT_NETWORK });
    s.hash = null;
    await askAmount(ctx, w, s);
    return true;
  }
  m = data.match(/^ppa_([a-f0-9]{24})$/);                // "same as requested"
  if (m) {
    const s = state[fromId];
    if (!s || s.wid !== m[1] || s.step !== 'pp_amount') { await send(chatId, '⌛ This step expired. Open the record again.', { reply_markup: menuKb }); return true; }
    const w = await db.collection('withdrawals').findOne({ _id: new ObjectId(m[1]) });
    await finishRecord(ctx, s, w ? w.usdtAmount : 0);
    return true;
  }

  // edit hash / void
  m = data.match(/^ppe_([a-f0-9]{24})$/);
  if (m) {
    const p = await db.collection('payouts').findOne({ withdrawalId: new ObjectId(m[1]), status: 'success' });
    if (!p) { await edit(chatId, msgId, ERR.not_found, { reply_markup: menuKb }); return true; }
    state[fromId] = { step: 'pp_edithash', wid: m[1], network: p.network };
    await edit(chatId, msgId, `✏️ <b>Edit transaction</b>\n\n🆔 <code>${esc(p.txId)}</code>\n🌐 Network: <b>${esc(p.network)}</b>\n👉 Send the <b>new transaction hash</b> as a message (or change the network first).`, { reply_markup: { inline_keyboard: [Object.keys(NETWORKS).map((k) => ({ text: (k === p.network ? '✅ ' : '') + k, callback_data: `ppn_${m[1]}_${k}` })), [{ text: '❌ Cancel', callback_data: 'a_payouts' }]] } });
    return true;
  }
  m = data.match(/^ppv_([a-f0-9]{24})$/);
  if (m) {
    await edit(chatId, msgId, '🗑 <b>Void this payout?</b>\n\nIt will stop counting in the totals and disappear from Latest Payouts right away. Use this only if it was recorded by mistake.', { reply_markup: { inline_keyboard: [[{ text: '🗑 Yes, void it', callback_data: `ppvy_${m[1]}` }], [{ text: '◀️ Back', callback_data: `apd_${m[1]}` }]] } });
    return true;
  }
  m = data.match(/^ppvy_([a-f0-9]{24})$/);
  if (m) {
    const r = await voidPayout(db, new ObjectId(m[1]), fromId);
    await edit(chatId, msgId, r.ok ? '🗑 Payout voided. Totals updated.' : (ERR[r.error] || '❌ Could not void.'), { reply_markup: r.ok ? { inline_keyboard: [[{ text: '🔍 Open record', callback_data: `apd_${m[1]}` }], [{ text: '◀️ Payout Management', callback_data: 'a_payouts' }]] } : menuKb });
    return true;
  }

  // channel
  if (data === 'a_ppch') { await show(await channelView(ctx)); return true; }
  if (data === 'ppch_set') {
    state[fromId] = { step: 'pp_channel' };
    await edit(chatId, msgId, '🔗 Send the <b>new channel link</b> (for example <code>https://t.me/yourchannel</code> or <code>@yourchannel</code>):', { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'a_ppch' }]] } });
    return true;
  }
  if (data === 'ppch_reset') { await resetChannelUrl(db); await show(await channelView(ctx)); return true; }

  // import old payouts
  if (data === 'a_ppbf') {
    const c = await backfillCounts(db);
    await edit(chatId, msgId,
      `📥 <b>Import old payouts</b>\n\nOld approved withdrawals that are not in Payout Proof yet:\n• ✅ Confirmed as paid (auto-paid on-chain, or marked paid by you): <b>${c.confirmed}</b>\n• 🧾 Approved only (no payment confirmation saved): <b>${c.attested}</b>\n\n“Confirmed only” is the safe choice. “All approved” also imports the second group — do it only if you know they were really paid.`,
      { reply_markup: { inline_keyboard: [[{ text: `📥 Import confirmed only (${c.confirmed})`, callback_data: 'ppbf_c' }], [{ text: `📥 Import ALL approved (${c.all})`, callback_data: 'ppbf_a' }], [{ text: '◀️ Payout Management', callback_data: 'a_payouts' }]] } });
    return true;
  }
  if (data === 'ppbf_a') {
    await edit(chatId, msgId, '⚠️ <b>Import ALL approved withdrawals?</b>\n\nEvery approved withdrawal will show in Payout Proof as <b>“Confirmed by admin”</b> (no Tx link). Tap Yes only if you vouch that they were all really paid.', { reply_markup: { inline_keyboard: [[{ text: '✅ Yes, I vouch for them', callback_data: 'ppbf_ay' }], [{ text: '◀️ Back', callback_data: 'a_ppbf' }]] } });
    return true;
  }
  if (data === 'ppbf_c' || data === 'ppbf_ay') {
    await edit(chatId, msgId, '⏳ Importing…');
    const r = await backfillPayouts(db, { includeAttested: data === 'ppbf_ay', adminId: fromId });
    
