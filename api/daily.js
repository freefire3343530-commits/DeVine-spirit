import { cyInc, cyMin } from '../lib/cycleStats.js';
import { refCheck } from '../lib/refReward.js';
import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';
import { bdTodayKey } from '../lib/dateUtils.js';
import crypto from 'crypto';
import { runAction, history, clock } from '../lib/spiritCare.js';
import { detectBotPattern, flagBotPattern, AD_CLAIM_HISTORY_KEEP } from '../lib/botGuard.js';

// ===== EDIT HERE: login bonus ($Devine for day 1, 2, 3 ... then it starts again from day 1) =====
const LOGIN_BONUS = [10, 20, 40, 70, 100, 150, 300];
// ===========================================================================================

// ===== EDIT HERE: Spirit shop + rewards ($Devine) =====
// price  = buy price in $Devine (0 = free plan)
// reward = $Devine paid on every claim
// reward = the MAXIMUM base points of one cycle (at 100% care). On top of it comes the flat +40 Shower bonus (BONUS in lib/spiritCare.js), same for all 5 spirits.
// hours  = hours between two claims (each spirit has its own timer)
// The spirit must be at 100% health (fed, watered/charged, clean, happy) at the moment of the claim.
// Keep this table in sync with SPIRIT_CFG in index.html (the app only uses it to show prices/timers).
// foodPrice = $Devine per food item of that spirit (the Watch-Ad option is always free).
const SPIRIT_CFG = {
  leaf: { price: 0,     reward: 60,   hours: 2,  foodPrice: 10  },   // Spirit 1 (free)
  moon: { price: 3000,  reward: 100,  hours: 4,  foodPrice: 20  },   // Spirit 2 Lunaling
  fire: { price: 8000,  reward: 500,  hours: 8,  foodPrice: 50  },   // Spirit 3 Emberling
  sun:  { price: 20000, reward: 700,  hours: 12, foodPrice: 100 },   // Spirit 4 Sunling
  star: { price: 50000, reward: 1000, hours: 24, foodPrice: 150 },   // Spirit 5 Starling
};
// ===== Spirit care + 3-hour reward cycle: all rules live in lib/spiritCare.js (statuses, decay, rewards, shower bonus, shop prices) =====
// The ad (Adsgram interstitial int-60809) is checked here with a signed one-time token.
const CARE_AD_MIN_SECONDS = 4;        // an ad cannot be finished faster than this after the server issued the token
const CARE_AD_MAX_SECONDS = 900;      // token expires
// 📺 Real ad proof (OFF until you set CARE_AD_S2S=1 and ADSGRAM_S2S_SECRET, see api/adcredit.js and PATCH_NOTES.md).
// ON: an ad-paid action needs a fresh credit that ADSGRAM ITSELF sent for this user after the signed start token was issued.
const careS2SOn = () => process.env.CARE_AD_S2S === '1' && !!process.env.ADSGRAM_S2S_SECRET;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function takeAdCredit(db, tgId, adStart) {
  const col = db.collection('adsgramS2S');
  for (let i = 0; i < 5; i++) {                        // Adsgram's callback can arrive a moment after the app's own "ad closed": wait up to ~4s
    const r = await col.findOneAndUpdate(
      { telegramId: tgId, network: 'care', used: false, at: { $gte: new Date(adStart - 2000) } },
      { $set: { used: true, usedAt: new Date() } }, { sort: { at: 1 }, returnDocument: 'before' });
    const doc = r?.value !== undefined ? r.value : r;
    if (doc && doc._id) return doc;
    if (i < 4) await sleep(1000);
  }
  return null;
}
const careSign = (tgId, kind, t, spiritId = 'leaf') =>
  crypto.createHmac('sha256', crypto.createHash('sha256').update('caretoken:' + process.env.BOT_TOKEN).digest()).update(spiritId === 'leaf' ? `${tgId}:${kind}:${t}` : `${tgId}:${kind}:${spiritId}:${t}`).digest('hex');
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
      if (typeof code !== 'string' || code.length > 40) return res.status(400).json({ error: 'bad_request' });
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

    // -- SPIRIT CARE (server-authoritative statuses, 3h reward cycle) ----------------------------------------------------------
    //  spiritState  : current statuses + reward preview + cycle info (also starts the spirit's care record the first time)
    //  spiritWater / spiritPet : free Water / Mood boosts (cool-down protected)
    //  buyFood / buyShower     : pay:'devine' or pay:'ad' (signed token from careAdStart)
    //  claimSpiritReward       : once per cycle, needs cycleId + a finished ad token
    //  spiritHistory           : reward / shower-bonus / spend history
    const CARE_ACTIONS = { spiritState: 'state', spiritWater: 'water', spiritPet: 'pet', buyFood: 'food', buyShower: 'shower', claimSpiritReward: 'claim' };
    if (CARE_ACTIONS[action] || action === 'careAdStart' || action === 'spiritHistory') {
      if (user.accountLocked) return res.status(403).json({ error: 'account_locked' });
      const tgId = String(telegramId);
      const id = String(req.body.spiritId || 'leaf');
      const cfg = SPIRIT_CFG[id];
      if (!cfg) return res.status(400).json({ error: 'Unknown spirit.' });
      if (!(user.spirits || []).includes(id)) return res.status(400).json({ error: 'You do not own this spirit.' });

      if (action === 'spiritHistory') {
        const rows = await history(db, tgId, 30);
        return res.status(200).json({ success: true, history: rows.map((r) => ({ type: r.type, spiritId: r.spiritId, cycleId: r.cycleId, amount: r.amount, item: r.item || null, status: r.status || null, at: r.at })) });
      }

      // ad token: careAdStart (kind food | shower | claim) issues it, the paid action spends it (one time)
      if (action === 'careAdStart') {
        const kind = String(req.body.kind || '');
        if (!['food', 'shower', 'claim'].includes(kind)) return res.status(400).json({ error: 'Invalid kind.' });
        const t = clock.now();
        return res.status(200).json({ success: true, startTime: t, signature: careSign(tgId, kind, t, id) });
      }

      const kind = CARE_ACTIONS[action];
      const pay = kind === 'claim' ? 'ad' : String(req.body.pay || 'devine');
      if (pay !== 'devine' && pay !== 'ad') return res.status(400).json({ error: 'Invalid payment.' });
      let adStart = 0;
      if (pay === 'ad' && (kind === 'food' || kind === 'shower' || kind === 'claim')) {
        adStart = Number(req.body.startTime);
        if (!adStart || !req.body.signature) return res.status(400).json({ error: kind === 'claim' ? 'ad_required' : 'missing_ad_token' });
        if (careSign(tgId, kind, adStart, id) !== req.body.signature) return res.status(400).json({ error: 'invalid_ad_token' });
        const elapsed = (clock.now() - adStart) / 1000;
        if (!(elapsed >= CARE_AD_MIN_SECONDS)) return res.status(400).json({ error: 'watch_time_too_short' });
        if (elapsed > CARE_AD_MAX_SECONDS) return res.status(400).json({ error: 'ad_token_expired' });
      }

      // 📺 ad proof from Adsgram's server (only when enabled)
      let credit = null;
      if (pay === 'ad' && careS2SOn()) {
        credit = await takeAdCredit(db, tgId, adStart);
        if (!credit) return res.status(400).json({ error: 'ad_not_confirmed' });
      }
      const out = await runAction(db, tgId, id, cfg, kind, { pay, adStart, reqId: req.body.reqId, cycleId: req.body.cycleId });
      if (credit && (out.error || out.dup)) await db.collection('adsgramS2S').updateOne({ _id: credit._id }, { $set: { used: false }, $unset: { usedAt: '' } }).catch(() => {}); // nothing was paid: give the credit back
      if (out.error) return res.status(out.error === 'busy' ? 409 : 400).json({ error: out.error, snap: out.snap || null });
      if (pay === 'ad' && !out.dup) {   // 🤖 script detector for the live ad path: soft (no auto-lock), see lib/botGuard.js flagBotPattern
        try {
          const nowMs = clock.now(), watch = Math.round(((nowMs - adStart) / 1000) * 100) / 100;
          const upd = await users.findOneAndUpdate({ telegramId: tgId }, { $push: { careAdSamples: { $each: [{ s: adStart, c: nowMs, w: watch, v: watch }], $slice: -AD_CLAIM_HISTORY_KEEP } } }, { returnDocument: 'after', projection: { careAdSamples: 1 } });
          const doc = upd?.value !== undefined ? upd.value : upd;
          const hit = doc?.careAdSamples ? detectBotPattern(doc.careAdSamples) : null;
          if (hit) await flagBotPattern(db, tgId, hit, `via ${kind}`);
        } catch (e) { console.error('care ad pattern check failed:', e.message); }
      }
      return res.status(200).json({ success: true, duplicate: !!out.dup, alreadyClaimed: !!out.alreadyClaimed, snap: out.snap, ...(out.result || {}) });
    }

    return res.status(400).json({ error: 'Invalid action. Use: login | promo | claimSpirit | buySpirit | claimSpiritReward | spiritState | spiritWater | spiritPet | careAdStart | buyFood | buyShower | spiritHistory' });
  } catch (err) {
    console.error('daily.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
