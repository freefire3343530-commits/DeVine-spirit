import { cyInc, cyMin } from '../lib/cycleStats.js';
import { refCheck } from '../lib/refReward.js';
import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';
import { bdTodayKey } from '../lib/dateUtils.js';
import { SPIRIT_CFG, FIRST_CLAIM_READY } from '../lib/spiritCfg.js';

// ===== EDIT HERE: login bonus ($Devine for day 1, 2, 3 ... then it starts again from day 1) =====
const LOGIN_BONUS = [10, 20, 40, 70, 100, 150, 300];
// ===========================================================================================

// ===== Spirit shop + rewards: lib/spiritCfg.js (shared with api/farm.js). The reward claim itself is in api/farm.js. =====
// Food / Shower / Water / Pet were REMOVED from the server: they are client-side now (Gold, see index.html) and never change the reward.
// Timer of a newly claimed / bought Spirit: ready right away (like Gram Edge Farm) or after one full cycle (FIRST_CLAIM_READY = false).
// FIX: promo codes are 6 digits (only 900,000 possible), so one script could guess live codes all day (10 tries/min = 14,400/day).
// Now: 20 wrong codes per hour per user, then a one hour pause. (Per server process, zero database cost.)
const promoFails = new Map();   // telegramId -> { n, reset }
const PROMO_MAX_FAILS = 20, PROMO_FAIL_WINDOW_MS = 3600 * 1000;
const promoBlocked = (id) => { const c = promoFails.get(id); return !!c && c.reset > Date.now() && c.n >= PROMO_MAX_FAILS; };
const promoFail = (id) => {
  const now = Date.now(); let c = promoFails.get(id);
  if (!c || c.reset <= now) { c = { n: 0, reset: now + PROMO_FAIL_WINDOW_MS }; promoFails.set(id, c); }
  c.n++; if (promoFails.size > 20000) promoFails.clear();
};
const farmStart = (id, now) => ({
  [`spiritFarm.${id}`]: { nextClaimAt: FIRST_CLAIM_READY ? null : new Date(now.getTime() + SPIRIT_CFG[id].hours * 3600000) },
  [`spiritClaims.${id}`]: now,
});
// ====================================================================================================================

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { telegramId, initData, action, code } = req.body;
  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

  // initData is now REQUIRED — was optional, meaning anyone could claim the
  // daily reward or redeem a promo code for any telegramId with no proof of
  // identity.
  const tgUser = verifyTelegramInit(initData);
  if (!tgUser || String(tgUser.id) !== String(telegramId)) {
    return res.status(403).json({ error: 'Invalid Telegram session' });
  }

  try {
    const db = await getDb();
    const users = db.collection('users');
    const user = await users.findOne({ telegramId: String(telegramId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isBanned) return res.status(403).json({ error: 'Account banned' });

    // ── action: login (daily login bonus, streak 10 → 300 $Devine) ──────
    // One claim per Bangladesh calendar day. Miss a day and the streak starts again from day 1.
    if (action === 'login') {
      if (user.accountLocked) return res.status(403).json({ error: 'account_locked' });
      const today = bdTodayKey();
      const yesterday = bdTodayKey(new Date(Date.now() - 86400000));
      const lb = user.loginBonus || {};
      if (lb.lastDay === today) return res.status(400).json({ error: 'Already claimed today. Come back tomorrow.' });

      const day = lb.lastDay === yesterday ? ((lb.streak || 0) % LOGIN_BONUS.length) + 1 : 1;
      const reward = LOGIN_BONUS[day - 1];

      // Atomic: only one request per day can pass this filter, so a double tap cannot pay twice.
      const result = await users.findOneAndUpdate(
        { telegramId: String(telegramId), 'loginBonus.lastDay': { $ne: today } },
        { $inc: { egBalance: reward, ...cyInc('login', reward) }, $min: cyMin(), $set: { loginBonus: { lastDay: today, streak: day } } },
        { returnDocument: 'after' }
      );
      const updated = result?.value || result;
      if (!updated) return res.status(400).json({ error: 'Already claimed today. Come back tomorrow.' });
      return res.status(200).json({ success: true, reward, day, loginBonus: { lastDay: today, streak: day }, balance: updated.egBalance });
    }

    // ── action: promo ─────────────────────────────────────────────
    if (action === 'promo') {
      if (user.accountLocked) return res.status(403).json({ error: 'account_locked' });   // FIX: locked accounts must not earn (same as login / spirits)
      if (promoBlocked(String(telegramId))) return res.status(200).json({ valid: false, error: 'Too many wrong codes. Try again in an hour.' });
      if (!code) return res.status(400).json({ error: 'code required' });
      if (typeof code !== 'string' || code.length > 40) return res.status(400).json({ error: 'bad_request' });
      const cleanCode = code.toUpperCase().trim();
      const { checkOnly } = req.body;
      const promos = db.collection('promos');
      const promo = await promos.findOne({ code: cleanCode });

      // Validate
      if (!promo) { promoFail(String(telegramId)); return res.status(200).json({ valid: false, error: 'Invalid promo code.' }); }
      if (promo.expiresAt && new Date(promo.expiresAt) < new Date())
        return res.status(200).json({ valid: false, error: 'Promo code expired.' });
      if (promo.maxUses && promo.usedCount >= promo.maxUses)
        return res.status(200).json({ valid: false, error: 'Promo code limit reached.' });
      if ((user.promosUsed || []).includes(cleanCode))
        return res.status(200).json({ valid: false, error: 'Already used this promo code.' });

      // checkOnly = just validate, don't redeem yet.
      if (checkOnly) return res.status(200).json({ valid: true, reward: promo.reward, currency: 'mm' });

      // Every promo pays $Devine now (old Gold promos are converted by the migration script).
      const field = 'egBalance';

      // Atomic redeem: only succeeds if this code isn't already in
      // promosUsed. Previously read-then-write, so two simultaneous redeems
      // of the same code by the same user could both succeed.
      // FIX: reserve ONE use of the code first (atomic: usedCount can never go above maxUses, even when many users hit the last slot together),
      // then pay. If the user turns out to have used it already (or anything fails) the slot is given back.
      const slot = await promos.findOneAndUpdate(
        { code: cleanCode, $or: [{ maxUses: { $exists: false } }, { maxUses: null }, { maxUses: 0 }, { $expr: { $lt: [{ $ifNull: ['$usedCount', 0] }, '$maxUses'] } }] },
        { $inc: { usedCount: 1 } }, { returnDocument: 'after' });
      if (!(slot?.value !== undefined ? slot.value : slot)) return res.status(200).json({ valid: false, error: 'Promo code limit reached.' });
      const giveSlotBack = () => promos.updateOne({ code: cleanCode }, { $inc: { usedCount: -1 } }).catch(() => {});

      let result;
      try {
        result = await users.findOneAndUpdate(
          { telegramId: String(telegramId), promosUsed: { $ne: cleanCode } },
          { $inc: { [field]: promo.reward, ...cyInc('promo', promo.reward) }, $min: cyMin(), $push: { promosUsed: cleanCode } },
          { returnDocument: 'after' }
        );
      } catch (e) { await giveSlotBack(); throw e; }
      const updated = result?.value || result;
      if (!updated) {
        await giveSlotBack();
        return res.status(200).json({ valid: false, error: 'Already used this promo code.' });
      }

      return res.status(200).json({ success: true, reward: promo.reward, currency: 'mm' });
    }

    // ── action: claimSpirit (the FREE plan: one free Leaf Spirit per account) ─────
    // The spirit id is fixed on the server, so a client cannot claim a paid spirit this way.
    // Paid spirits are added to user.spirits by buySpirit below. The reward timer + claim live in api/farm.js.
    if (action === 'claimSpirit') {
      if (user.accountLocked) return res.status(403).json({ error: 'account_locked' });
      const FREE_SPIRIT = 'leaf';
      // Atomic: the filter only matches while the spirit is not yet owned, so a double tap cannot add it twice.
      const result = await users.findOneAndUpdate(
        { telegramId: String(telegramId), spirits: { $ne: FREE_SPIRIT } },
        { $addToSet: { spirits: FREE_SPIRIT }, $set: farmStart(FREE_SPIRIT, new Date()) },
        { returnDocument: 'after' }
      );
      const updated = result?.value || result;
      if (!updated) return res.status(200).json({ success: true, already: true, spirits: user.spirits || [] });
      return res.status(200).json({ success: true, spirits: updated.spirits || [FREE_SPIRIT] });
    }

    // -- action: buySpirit (pay $Devine, spirit is added to user.spirits) ----------------------
    if (action === 'buySpirit') {
      if (user.accountLocked) return res.status(403).json({ error: 'account_locked' });
      const id = String(req.body.spiritId || '');
      const cfg = SPIRIT_CFG[id];
      if (!cfg || cfg.price <= 0) return res.status(400).json({ error: 'This spirit cannot be bought.' });
      if ((user.spirits || []).includes(id)) return res.status(200).json({ success: true, already: true, spirits: user.spirits || [] });
      if (!(user.spirits || []).includes('leaf')) return res.status(400).json({ error: 'Claim your free Leaf Spirit first.' });
      // Atomic: balance check + "not owned yet" in one filter, so a double tap can never charge twice or overdraw.
      const result = await users.findOneAndUpdate(
        { telegramId: String(telegramId), spirits: { $ne: id }, egBalance: { $gte: cfg.price } },
        { $inc: { egBalance: -cfg.price, spiritSpent: cfg.price }, $addToSet: { spirits: id }, $set: farmStart(id, new Date()) },
        { returnDocument: 'after' }
      );
      const updated = result?.value || result;
      if (!updated) return res.status(400).json({ error: 'Not enough $Devine.' });
      await refCheck(db, updated); // referral rewards: friend bought his 1st Spirit / Spirit No.3
      return res.status(200).json({ success: true, spirits: updated.spirits, balance: updated.egBalance });
    }

    return res.status(400).json({ error: 'Invalid action. Use: login | promo | claimSpirit | buySpirit  (reward claim: /api/farm)' });
  } catch (err) {
    console.error('daily.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
