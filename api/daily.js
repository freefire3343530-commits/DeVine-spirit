import { cyInc, cyMin } from '../lib/cycleStats.js';
import { refCheck } from '../lib/refReward.js';
import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';
import { bdTodayKey } from '../lib/dateUtils.js';
import crypto from 'crypto';

// ===== EDIT HERE: login bonus ($Devine for day 1, 2, 3 ... then it starts again from day 1) =====
const LOGIN_BONUS = [10, 20, 40, 70, 100, 150, 300];
// ===========================================================================================

// ===== EDIT HERE: Spirit shop + rewards ($Devine) =====
// price  = buy price in $Devine (0 = free plan)
// reward = $Devine paid on every claim
// hours  = hours between two claims (each spirit has its own timer)
// The spirit must be at 100% health (fed, watered/charged, clean, happy) at the moment of the claim.
// Keep this table in sync with SPIRIT_CFG in index.html (the app only uses it to show prices/timers).
const SPIRIT_CFG = {
  leaf: { price: 0,     reward: 100,  hours: 3  },   // Spirit 1 (free)
  moon: { price: 3000,  reward: 300,  hours: 6  },   // Spirit 2
  fire: { price: 8000,  reward: 500,  hours: 8  },   // Spirit 3
  sun:  { price: 20000, reward: 1000, hours: 12 },   // Spirit 4
  star: { price: 50000, reward: 2000, hours: 24 },   // Spirit 5
};
// ===== EDIT HERE: reward by spirit health at the moment of the claim =====
// [minimum health %, share of the spirit's full reward]. Checked from the top.
// Leaf Spirit (reward 100 / 3h):  100% -> 100,  75%+ -> 75,  50%+ -> 50,  below 50% -> 25.
const HEALTH_TIERS = [[100, 1], [75, 0.75], [50, 0.5], [0, 0.25]];
const tierShare = (h) => (HEALTH_TIERS.find(([min]) => h >= min) || [0, 0.25])[1];

// ===== EDIT HERE: care shop (food + shower). Keep in sync with the spirit pages (they only show the numbers). =====
// price = $Devine, heal = overall health % recovered. A user can also pay by watching an Adsgram interstitial (int-60809) instead.
const CARE = {
  food:   { price: 10, heal: 20, dailyLimit: 30 },   // 30 foods per Bangladesh day (paid + ad foods together)
  shower: { price: 20, heal: 30 },
};
const CARE_AD_MIN_SECONDS = 4;        // an ad cannot be finished faster than this after the server issued the token
const CARE_AD_MAX_SECONDS = 900;      // token expires
const careSign = (tgId, kind, t) =>
  crypto.createHmac('sha256', crypto.createHash('sha256').update('caretoken:' + process.env.BOT_TOKEN).digest()).update(`${tgId}:${kind}:${t}`).digest('hex');
// =======================================================

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
      if (!code) return res.status(400).json({ error: 'code required' });
      const cleanCode = code.toUpperCase().trim();
      const { checkOnly } = req.body;
      const promos = db.collection('promos');
      const promo = await promos.findOne({ code: cleanCode });

      // Validate
      if (!promo) return res.status(200).json({ valid: false, error: 'Invalid promo code.' });
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
      const result = await users.findOneAndUpdate(
        { telegramId: String(telegramId), promosUsed: { $ne: cleanCode } },
        { $inc: { [field]: promo.reward, ...cyInc('promo', promo.reward) }, $min: cyMin(), $push: { promosUsed: cleanCode } },
        { returnDocument: 'after' }
      );
      const updated = result?.value || result;
      if (!updated) {
        return res.status(200).json({ valid: false, error: 'Already used this promo code.' });
      }

      // Still not perfectly race-proof against maxUses across DIFFERENT
      // users hitting the last slot at the same instant (this $inc isn't
      // conditioned on usedCount < maxUses), but that only risks a handful
      // of extra redemptions on a capped code, not unlimited balance growth.
      await promos.updateOne({ code: cleanCode }, { $inc: { usedCount: 1 } });

      return res.status(200).json({ success: true, reward: promo.reward, currency: 'mm' });
    }

    // ── action: claimSpirit (the FREE plan: one free Leaf Spirit per account) ─────
    // The spirit id is fixed on the server, so a client cannot claim a paid spirit this way.
    // Paid spirits are added to user.spirits by the (future) buy flow.
    if (action === 'claimSpirit') {
      if (user.accountLocked) return res.status(403).json({ error: 'account_locked' });
      const FREE_SPIRIT = 'leaf';
      // Atomic: the filter only matches while the spirit is not yet owned, so a double tap cannot add it twice.
      const result = await users.findOneAndUpdate(
        { telegramId: String(telegramId), spirits: { $ne: FREE_SPIRIT } },
        { $addToSet: { spirits: FREE_SPIRIT }, $set: { 'spiritClaims.leaf': new Date() } },
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
        { $inc: { egBalance: -cfg.price, spiritSpent: cfg.price }, $addToSet: { spirits: id }, $set: { [`spiritClaims.${id}`]: new Date() } },
        { returnDocument: 'after' }
      );
      const updated = result?.value || result;
      if (!updated) return res.status(400).json({ error: 'Not enough $Devine.' });
      await refCheck(db, updated); // referral rewards: friend bought his 1st Spirit / Spirit No.3
      return res.status(200).json({ success: true, spirits: updated.spirits, spiritClaims: updated.spiritClaims || {}, balance: updated.egBalance });
    }

    // -- action: claimSpiritReward (timer + reward depends on health: 25 / 50 / 75 / 100 %) ---------------------------------
    if (action === 'claimSpiritReward') {
      if (user.accountLocked) return res.status(403).json({ error: 'account_locked' });
      const id = String(req.body.spiritId || '');
      const cfg = SPIRIT_CFG[id];
      if (!cfg) return res.status(400).json({ error: 'Unknown spirit.' });
      if (!(user.spirits || []).includes(id)) return res.status(400).json({ error: 'You do not own this spirit.' });
      const health = Number(req.body.health);
      if (!Number.isFinite(health) || health < 0 || health > 100) return res.status(400).json({ error: 'Invalid health.' });
      const share = tierShare(health);
      const reward = Math.round(cfg.reward * share);
      const now = Date.now();
      const cutoff = new Date(now - cfg.hours * 3600000);
      const key = `spiritClaims.${id}`;
      // Atomic: only one request can pass the "timer finished" filter, so a double tap cannot pay twice.
      const result = await users.findOneAndUpdate(
        { telegramId: String(telegramId), spirits: id, $or: [{ [key]: { $exists: false } }, { [key]: { $lte: cutoff } }] },
        { $inc: { egBalance: reward, spiritEarned: reward, ...cyInc('spirit', reward) }, $min: cyMin(), $set: { [key]: new Date(now) } },
        { returnDocument: 'after' }
      );
      const updated = result?.value || result;
      if (!updated) {
        const last = user.spiritClaims && user.spiritClaims[id] ? new Date(user.spiritClaims[id]).getTime() : 0;
        return res.status(400).json({ error: 'Not ready yet.', nextAt: last + cfg.hours * 3600000, spiritClaims: user.spiritClaims || {} });
      }
      return res.status(200).json({ success: true, reward, share, health: Math.round(health), balance: updated.egBalance, spiritClaims: updated.spiritClaims || {}, nextAt: now + cfg.hours * 3600000 });
    }

    // -- CARE SHOP: food + shower -----------------------------------------------------------------------------------------------
    // careStatus : how many foods were used today
    // careAdStart: the app asks for a signed token right before it shows the Adsgram interstitial
    // buyFood / buyShower: pay:'devine' (spends $Devine) or pay:'ad' (needs the signed token, costs nothing).
    // The spirit page applies the health recovery only after the server says success.
    if (action === 'careStatus' || action === 'careAdStart' || action === 'buyFood' || action === 'buyShower') {
      if (user.accountLocked) return res.status(403).json({ error: 'account_locked' });
      const tgId = String(telegramId);
      const today = bdTodayKey();
      const usedOf = (u) => (u?.care?.foodDay === today ? (u.care.foodCount || 0) : 0);
      const status = (u) => ({ balance: u.egBalance || 0, foodUsed: usedOf(u), foodLimit: CARE.food.dailyLimit });

      if (action === 'careStatus') return res.status(200).json({ success: true, ...status(user) });

      if (action === 'careAdStart') {
        const kind = String(req.body.kind || '');
        if (!CARE[kind]) return res.status(400).json({ error: 'Invalid kind.' });
        if (kind === 'food' && usedOf(user) >= CARE.food.dailyLimit) return res.status(400).json({ error: 'food_limit', ...status(user) });
        const t = Date.now();
        return res.status(200).json({ success: true, startTime: t, signature: careSign(tgId, kind, t) });
      }

      const kind = action === 'buyFood' ? 'food' : 'shower';
      const cfg = CARE[kind];
      const pay = String(req.body.pay || 'devine');
      if (pay !== 'devine' && pay !== 'ad') return res.status(400).json({ error: 'Invalid payment.' });

      // what changes on success
      let filter = { telegramId: tgId };
      const inc = {};
      const set = {};
      if (pay === 'devine') {
        filter.egBalance = { $gte: cfg.price };
        inc.egBalance = -cfg.price;
        inc.careSpent = cfg.price;
      } else {
        const startNum = Number(req.body.startTime);
        if (!startNum || !req.body.signature) return res.status(400).json({ error: 'missing_ad_token' });
        if (careSign(tgId, kind, startNum) !== req.body.signature) return res.status(400).json({ error: 'invalid_ad_token' });
        const elapsed = (Date.now() - startNum) / 1000;
        if (!(elapsed >= CARE_AD_MIN_SECONDS)) return res.status(400).json({ error: 'watch_time_too_short' });
        if (elapsed > CARE_AD_MAX_SECONDS) return res.status(400).json({ error: 'ad_token_expired' });
        // the token is one-time: it must be newer than the last care-ad token this user spent
        filter.$and = [{ $or: [{ careAdLastUsed: { $exists: false } }, { careAdLastUsed: { $lt: startNum } }] }];
        set.careAdLastUsed = startNum;
        inc.careAdCount = 1;
      }
      if (kind === 'shower') inc.careShowerCount = 1;

      let updated = null;
      if (kind === 'food') {
        // 1) same day, still under the limit   2) first food of a new day (counter starts again from 1)
        const same = await users.findOneAndUpdate(
          { ...filter, 'care.foodDay': today, 'care.foodCount': { $lt: cfg.dailyLimit } },
          { $inc: { ...inc, 'care.foodCount': 1 }, ...(Object.keys(set).length ? { $set: set } : {}) },
          { returnDocument: 'after' }
        );
        updated = same?.value || same;
        if (!updated) {
          const fresh = await users.findOneAndUpdate(
            { ...filter, 'care.foodDay': { $ne: today } },
            { $inc: inc, $set: { ...set, 'care.foodDay': today, 'care.foodCount': 1 } },
            { returnDocument: 'after' }
          );
          updated = fresh?.value || fresh;
        }
      } else {
        const r = await users.findOneAndUpdate(
          filter,
          { $inc: inc, ...(Object.keys(set).length ? { $set: set } : {}) },
          { returnDocument: 'after' }
        );
        updated = r?.value || r;
      }

      if (!updated) {
        const now = await users.findOne({ telegramId: tgId });
        if (kind === 'food' && usedOf(now) >= cfg.dailyLimit) return res.status(400).json({ error: 'food_limit', ...status(now || user) });
        if (pay === 'devine') return res.status(400).json({ error: 'not_enough_devine', ...status(now || user) });
        return res.status(400).json({ error: 'ad_token_used' });
      }
      return res.status(200).json({ success: true, kind, pay, heal: cfg.heal, price: pay === 'devine' ? cfg.price : 0, ...status(updated) });
    }

    return res.status(400).json({ error: 'Invalid action. Use: login | promo | claimSpirit | buySpirit | claimSpiritReward | careStatus | careAdStart | buyFood | buyShower' });
  } catch (err) {
    console.error('daily.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
