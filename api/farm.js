// FILE PATH: api/farm.js
// Farming: 6 farms, each pays a fixed DVS$ reward once per cycle.
// Farm 1 is free, farms 2-6 are bought with DVS$.
import { cyInc, cyMin } from '../lib/cycleStats.js';
import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';
import { refCheck } from '../lib/refReward.js';

// ===== EDIT HERE: farm settings (50,000 DVS$ = $1) =====
// hours = how often you can claim, reward = DVS$ per claim, price = DVS$ to buy (0 = free)
const FARMS = [
  { name: 'Farm 1', hours: 1,  reward: 30,  price: 0 },
  { name: 'Farm 2', hours: 2,  reward: 50,  price: 250 },
  { name: 'Farm 3', hours: 4,  reward: 100, price: 750 },
  { name: 'Farm 4', hours: 6,  reward: 200, price: 2000 },
  { name: 'Farm 5', hours: 8,  reward: 300, price: 5000 },
  { name: 'Farm 6', hours: 12, reward: 500, price: 12500 },
];
// ======================================================

const N = FARMS.length;

const freshSlots = (old) =>
  FARMS.map((f, i) => ({
    // users who bought a plot in the old plot system keep the matching farm unlocked
    unlocked: f.price === 0 || !!old?.[i]?.unlocked,
    nextClaimAt: null, // null = ready to claim now
  }));

const view = (farm) => ({
  now: Date.now(),
  farms: FARMS.map((f, i) => {
    const s = farm.slots[i] || {};
    return {
      id: i,
      name: f.name,
      hours: f.hours,
      reward: f.reward,
      price: f.price,
      unlocked: !!s.unlocked,
      readyAt: s.nextClaimAt ? new Date(s.nextClaimAt).getTime() : 0,
    };
  }),
});

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const telegramId = req.query?.telegramId || req.body?.telegramId;
  const initData = req.query?.initData || req.body?.initData || '';
  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });
  const tgUser = verifyTelegramInit(initData);
  if (!tgUser || String(tgUser.id) !== String(telegramId)) return res.status(403).json({ error: 'Invalid Telegram session' });

  const tgId = String(telegramId);
  const db = await getDb();
  const users = db.collection('users');
  let user = await users.findOne({ telegramId: tgId });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.isBanned) return res.status(403).json({ error: 'Account banned' });

  if (!user.farm2?.slots || user.farm2.slots.length !== N) {
    await users.updateOne(
      { telegramId: tgId, $or: [{ 'farm2.slots': { $exists: false } }, { 'farm2.slots': { $size: 0 } }] },
      { $set: { farm2: { slots: freshSlots(user.farm?.slots) } } }
    );
    user = await users.findOne({ telegramId: tgId });
  }
  if (req.method === 'GET') return res.status(200).json({ success: true, farm: view(user.farm2) });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body || {};
  const i = parseInt(req.body?.slot, 10);
  if (!(i >= 0 && i < N)) return res.status(400).json({ error: 'Invalid farm' });
  const cfg = FARMS[i];
  const p = `farm2.slots.${i}`;

  // ── buy a farm ──────────────────────────────────────────────
  if (action === 'unlock') {
    if (cfg.price <= 0) return res.status(400).json({ error: 'This farm is already free' });
    const r = await users.updateOne(
      { telegramId: tgId, [`${p}.unlocked`]: { $ne: true }, egBalance: { $gte: cfg.price } },
      { $inc: { egBalance: -cfg.price }, $set: { [`${p}.unlocked`]: true, [`${p}.nextClaimAt`]: null } }
    );
    if (!r.modifiedCount) return res.status(400).json({ error: 'Not enough DVS$ (or already bought)' });
    user = await users.findOne({ telegramId: tgId });
    await refCheck(db, user); // referral milestone: friend unlocked 5 farms
    return res.status(200).json({ success: true, balance: user.egBalance, farm: view(user.farm2) });
  }

  // ── claim: farm must be unlocked + ready, then pay ──
  if (action === 'claim') {
    if (user.accountLocked) return res.status(403).json({ error: 'account_locked' });
    const slot = user.farm2.slots[i];
    if (!slot?.unlocked) return res.status(400).json({ error: 'Buy this farm first' });
    const readyAt = slot.nextClaimAt ? new Date(slot.nextClaimAt).getTime() : 0;
    if (Date.now() < readyAt) return res.status(400).json({ error: 'Not ready yet' });

    const now = new Date();
    // Atomic: pays only if the farm is still unlocked + ready.
    const result = await users.findOneAndUpdate(
      {
        telegramId: tgId,
        [`${p}.unlocked`]: true,
        $or: [{ [`${p}.nextClaimAt`]: null }, { [`${p}.nextClaimAt`]: { $lte: now } }],
      },
      {
        $inc: { egBalance: cfg.reward, farmClaims: 1, ...cyInc('farm', cfg.reward) },
        $min: cyMin(), // cycle report: "since last withdraw" counters (lib/cycleStats.js)
        $set: { [`${p}.nextClaimAt`]: new Date(now.getTime() + cfg.hours * 3600 * 1000) },
        // farmClaimTimes = exact time of each farm claim (log only). api/withdraw.js counts farmClaims since the last withdrawal
        $push: { farmClaimTimes: { $each: [Date.now()], $slice: -20 } },
      },
      { returnDocument: 'after' }
    );
    const updated = result?.value || result;
    if (!updated) return res.status(400).json({ error: 'Already claimed or not ready' });

    await refCheck(db, updated); // referral milestone: friend made 3 farm claims today
    return res.status(200).json({ success: true, reward: cfg.reward, balance: updated.egBalance, farm: view(updated.farm2) });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
