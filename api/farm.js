// FILE PATH: api/farm.js
// 🌾 SPIRIT FARM — the Gram Edge Farm reward system, running the 5 Spirits (100% server-side).
//   5 Spirits = 5 farms. Each pays a FIXED $Devine reward once per cycle (table: lib/spiritCfg.js).
//   Buying a Spirit stays in api/daily.js (claimSpirit / buySpirit). Every claim needs one finished ad: Adsgram block 60919 or GigaPub (picked at random by the app).
//
//   POST /api/farm { action:'state' }                                  -> every Spirit: owned, readyAt, reward
//   POST /api/farm { action:'start', spiritId, network }                       -> signed ad token (call it when the ad is tapped). network = 'adsgram' | 'gigapub'
//   POST /api/farm { action:'claim', spiritId, network, startTime, signature } -> pays cfg.reward once, starts the next cycle
//   GET  /api/farm?telegramId=..&initData=..                           -> same as 'state'
//
// Food / Shower / Water / Pet are NOT here any more: they live in the app (client side, paid with Gold) and never change the reward.
import crypto from 'crypto';
import { cyInc, cyMin } from '../lib/cycleStats.js';
import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';
import { detectBotPattern, lockForBotPattern, AD_CLAIM_HISTORY_KEEP } from '../lib/botGuard.js';
import { trapHit, decoyFieldsIn } from '../lib/traps.js';
import { humanNeeded } from '../lib/humanCheck.js';
import { SPIRIT_CFG, SPIRIT_IDS } from '../lib/spiritCfg.js';
import { adS2SOn, takeAdCredit, giveCreditBack } from '../lib/adProof.js';

// ===== EDIT HERE: ad anti-cheat (the ads are short, so the minimum is small) =====
const MIN_WATCH_SECONDS = 4;       // an ad cannot be finished faster than this after the server issued the token
const TOKEN_MAX_AGE_SECONDS = 900; // token expires
const COOLDOWN_SECONDS = 5;        // min gap between two paid claims of one user
// ========================================================================================================

const AD_NETS = ['adsgram', 'gigapub'];   // Adsgram rewarded block 60919 (S2S-checkable) | GigaPub (no S2S)
const signStart = (tgId, spiritId, t, net = 'adsgram') =>
  crypto.createHmac('sha256', crypto.createHash('sha256').update('farmtoken:' + process.env.BOT_TOKEN).digest()).update(`${tgId}:${spiritId}:${net}:${t}`).digest('hex');
const sigOk = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

const nextAtOf = (user, id) => { const v = user.spiritFarm?.[id]?.nextClaimAt; return v ? new Date(v).getTime() : 0; };

const view = (user) => ({
  now: Date.now(),
  spirits: SPIRIT_IDS.map((id) => {
    const c = SPIRIT_CFG[id];
    return { id, owned: (user.spirits || []).includes(id), hours: c.hours, reward: c.reward, price: c.price, readyAt: nextAtOf(user, id) };   // readyAt 0 = ready now
  }),
});

// Users from the old care/cycle system (or from before this system) get their timer once, so nobody loses or doubles a reward.
async function ensureFarm(users, user) {
  let changed = false;
  for (const id of SPIRIT_IDS) {
    if (!(user.spirits || []).includes(id) || user.spiritFarm?.[id]) continue;
    const c = SPIRIT_CFG[id];
    const legacyStart = user.spiritCare?.[id]?.cycleStart || (user.spiritClaims?.[id] ? new Date(user.spiritClaims[id]).getTime() : 0);
    const nextClaimAt = legacyStart ? new Date(legacyStart + c.hours * 3600000) : null;   // old cycle end (a finished cycle = ready now)
    await users.updateOne({ telegramId: user.telegramId, [`spiritFarm.${id}`]: { $exists: false } }, { $set: { [`spiritFarm.${id}`]: { nextClaimAt } } });
    changed = true;
  }
  return changed ? users.findOne({ telegramId: user.telegramId }) : user;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const src = req.method === 'GET' ? (req.query || {}) : (req.body || {});
  const telegramId = src.telegramId;
  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });
  const tgUser = verifyTelegramInit(src.initData || '');
  if (!tgUser || String(tgUser.id) !== String(telegramId)) return res.status(403).json({ error: 'Invalid Telegram session' });

  const tgId = String(telegramId);
  const db = await getDb();
  const users = db.collection('users');
  let user = await users.findOne({ telegramId: tgId });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.isBanned) return res.status(403).json({ error: 'Account banned' });
  user = await ensureFarm(users, user);

  if (req.method === 'GET') return res.status(200).json({ success: true, farm: view(user) });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body || {};
  // 🪤 trap: the real app never sends reward/price/hours/balance fields, so this is a hand-edited request
  const decoys = decoyFieldsIn(req.body);
  if (decoys.length) { await trapHit(db, tgId, 'tampered_request', `spirit farm: ${decoys.join(',')}`); return res.status(400).json({ error: 'Bad request' }); }

  if (action === 'state') return res.status(200).json({ success: true, farm: view(user) });

  if (action !== 'start' && action !== 'claim') {
    await trapHit(db, tgId, 'unknown_action', `spirit farm: ${String(action).slice(0, 40)}`);   // 🪤 the app only sends state / start / claim
    return res.status(400).json({ error: 'Unknown action' });
  }

  const id = String(req.body?.spiritId || '');
  if (!Object.prototype.hasOwnProperty.call(SPIRIT_CFG, id)) { await trapHit(db, tgId, 'bad_spirit_id', id.slice(0, 40)); return res.status(400).json({ error: 'Invalid spirit' }); }
  const cfg = SPIRIT_CFG[id];
  const net = req.body?.network === undefined ? 'adsgram' : String(req.body.network);
  if (!AD_NETS.includes(net)) { await trapHit(db, tgId, 'bad_ad_network', net.slice(0, 40)); return res.status(400).json({ error: 'Invalid network' }); }
  const p = `spiritFarm.${id}`;

  if (user.accountLocked) return res.status(403).json({ error: 'account_locked' });
  if (humanNeeded(user, 'claim')) return res.status(403).json({ error: 'human_check_required' });   // 🧑 bot fighter (only after botGuard flagged him)
  if (!(user.spirits || []).includes(id)) return res.status(400).json({ error: 'You do not own this spirit.' });
  if (Date.now() < nextAtOf(user, id)) return res.status(400).json({ error: 'not_ready' });

  // ── claim step 1: tap → server checks the Spirit is ready and signs a start token ──
  if (action === 'start') {
    const t = Date.now();
    return res.status(200).json({ success: true, startTime: t, signature: signStart(tgId, id, t, net) });
  }

  // ── claim step 2: verify the ad token + timing, then pay ──
  const startNum = Number(req.body?.startTime);
  const signature = req.body?.signature;
  if (!startNum || !signature) return res.status(400).json({ error: 'ad_required' });
  if (!sigOk(signStart(tgId, id, startNum, net), signature)) return res.status(400).json({ error: 'invalid_ad_token' });
  const elapsed = (Date.now() - startNum) / 1000;
  if (!(elapsed >= 0)) return res.status(400).json({ error: 'invalid_ad_token' });
  if (elapsed > TOKEN_MAX_AGE_SECONDS) return res.status(400).json({ error: 'ad_token_expired' });
  if (elapsed < MIN_WATCH_SECONDS) return res.status(400).json({ error: 'watch_time_too_short' });
  if (user.lastAdClaimAt && Date.now() - new Date(user.lastAdClaimAt).getTime() < COOLDOWN_SECONDS * 1000) return res.status(400).json({ error: 'ad_cooldown' });

  const w = Math.round(elapsed * 10) / 10;
  const sample = { s: startNum, c: Date.now(), w, v: w };
  const hit = detectBotPattern([...(user.recentAdClaims || []), sample]);
  if (hit) {
    const lk = await lockForBotPattern(db, tgId, hit, `Spirit farm · ${id}`, [...(user.recentAdClaims || []), sample]);
    if (lk === true) return res.status(403).json({ error: 'account_locked' });
    if (lk === 'human') return res.status(403).json({ error: 'human_check_required' });
  }

  // 📺 real ad proof from Adsgram's server (only when enabled): reserve one confirmed credit
  let credit = null;
  if (net === 'adsgram' && adS2SOn()) {   // GigaPub has no server callback, only Adsgram can be proven
    credit = await takeAdCredit(db, tgId, startNum);
    if (!credit) return res.status(400).json({ error: 'ad_not_confirmed' });
  }

  const now = new Date();
  // Atomic: pays only if the Spirit is still owned + ready, and this ad token was never used before. A double tap cannot pay twice.
  const result = await users.findOneAndUpdate(
    {
      telegramId: tgId,
      spirits: id,
      $and: [
        { $or: [{ [`${p}.nextClaimAt`]: null }, { [`${p}.nextClaimAt`]: { $lte: now } }] },
        { $or: [{ lastAdStartUsed: { $exists: false } }, { lastAdStartUsed: { $lt: startNum } }] },
      ],
    },
    {
      $inc: { egBalance: cfg.reward, spiritEarned: cfg.reward, spiritClaimCount: 1, totalAdsWatched: 1, ...cyInc('spirit', cfg.reward) },
      $min: cyMin(),   // cycle report: "since last withdraw" counters (lib/cycleStats.js)
      $set: { [`${p}.nextClaimAt`]: new Date(now.getTime() + cfg.hours * 3600 * 1000), [`spiritClaims.${id}`]: now, lastAdClaimAt: now, lastAdStartUsed: startNum },
      $push: { recentAdClaims: { $each: [sample], $slice: -AD_CLAIM_HISTORY_KEEP } },
    },
    { returnDocument: 'after' }
  );
  const updated = result?.value || result;
  if (!updated || !updated.telegramId) { await giveCreditBack(db, credit); return res.status(400).json({ error: 'Already claimed or not ready' }); }

  return res.status(200).json({ success: true, spiritId: id, reward: cfg.reward, balance: updated.egBalance, farm: view(updated) });
}
