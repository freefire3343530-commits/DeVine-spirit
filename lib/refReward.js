// FILE PATH: lib/refReward.js
// REFERRAL SYSTEM v3  (total 1,500 $Devine per friend + 15% withdrawal commission)
//
//  1st generation (the people YOU invited) -> each reward is paid to you ONCE per friend:
//     join                          +300   (paid at signup in api/user.js)
//     10 tasks completed            +300
//     buys 1 Spirit (first paid)    +300   (api/daily.js buySpirit)
//     buys Spirit No.3 (fire)       +300   (api/daily.js buySpirit)
//     watches 10 Adsgram ads        +300   (api/ads.js daily_adsgram)
//     ----------------------------------
//     TOTAL                          1,500
//  (v2 also paid 'complete 10 Adsgram tasks' and 'friend invites 20 friends': both REMOVED in v3.)
//  Withdrawal commission: 15% of every APPROVED withdrawal of a direct friend (paid in api/bot.js).
//  2nd generation (friends of your friends) -> GEN2_PCT of every approved withdrawal (set it to 0 to switch it off).
//
// CPU / DB safety: refCheck() works only on the user document the caller ALREADY has (the result of its own update),
// so a normal event costs 0 extra DB calls. DB is touched only when a reward is newly reached:
// 1 write on the friend (flags) + 1 write on the referrer ($Devine). Once all flags are set, refProg.done stops every check.
import { cyInc, cyMin } from './cycleStats.js';

// ===== EDIT HERE: reward per step ($Devine) =====
export const REF = { join: 300, tasks: 300, spirit1: 300, spirit3: 300, ads: 300 };
// ===============================================
export const GEN1_PCT = 0.15; // % of a direct friend's approved withdrawal paid to you
export const GEN2_PCT = 0; // 2nd generation commission REMOVED (was 0.05). 0 = off; api/bot.js skips the payout when this is 0.

// ===== EDIT HERE: what a friend must do =====
export const NEED = {
  tasks: 10,          // completed tasks
  ads: 10,            // Adsgram rewarded ads watched (network daily_adsgram)
  spirit3: 'fire',    // Spirit No.3 in api/daily.js SPIRIT_CFG
};
// ============================================

// Steps paid by refCheck() (join is paid at signup, so it is not in this list)
const STEPS = ['tasks', 'spirit1', 'spirit3', 'ads'];
export const REF_STEPS = STEPS;
export const REF_TOTAL = Object.values(REF).reduce((s, v) => s + v, 0); // 1500

function reached(u, m) {
  switch (m) {
    case 'tasks':   return (u.tasksDoneTotal || 0) >= NEED.tasks;
    case 'spirit1': return (u.spirits || []).some((s) => s !== 'leaf');        // leaf = the free spirit, so any BOUGHT spirit counts
    case 'spirit3': return (u.spirits || []).includes(NEED.spirit3);
    case 'ads':     return (u.adsgramAdTotal || 0) >= NEED.ads;
    default:        return false;
  }
}

// A friend just became ACTIVE (first completed task): only counts it on the referrer (shown in the admin panel). No payout.
async function refActive(db, u) {
  const users = db.collection('users');
  const flag = await users.findOneAndUpdate(
    { telegramId: u.telegramId, 'refProg.active': { $ne: true } },
    { $set: { 'refProg.active': true } }
  );
  if (!(flag?.value || (flag && flag._id))) return;
  await users.updateOne(
    { telegramId: u.referredBy, isBanned: { $ne: true }, accountLocked: { $ne: true } },
    { $inc: { activeReferrals: 1 } }
  );
}

// u = the friend's user document AFTER the event (task done / ad watched / spirit bought)
export async function refCheck(db, u) {
  try {
    const p = u?.refProg;                       // only friends who joined through a referral link have refProg
    if (!p || !u.referredBy || u.accountLocked || u.isBanned) return;   // fake / locked friends never pay the referrer
    if (!p.active && (u.tasksDoneTotal || 0) >= 1) await refActive(db, u);
    if (p.done && p.v === 2) return;            // every step already paid
    const hit = STEPS.filter((m) => !p[m] && reached(u, m));
    if (!hit.length) return;                    // nothing new: zero DB calls

    const users = db.collection('users');
    const total = hit.reduce((s, m) => s + REF[m], 0);
    const set = {};
    for (const m of hit) set[`refProg.${m}`] = true;
    if (STEPS.every((m) => p[m] || hit.includes(m))) { set['refProg.done'] = true; set['refProg.v'] = 2; }

    // flip the flags first (atomic, so a double event can never pay twice), then pay
    const flag = await users.findOneAndUpdate(
      { telegramId: u.telegramId, $and: hit.map((m) => ({ [`refProg.${m}`]: { $ne: true } })) },
      { $set: set, $inc: { refBonusGenerated: total } }
    );
    if (!(flag?.value || (flag && flag._id))) return;
    const inc = { egBalance: total, totalRefEarnedEG: total, ...cyInc('refStep', total) };
    for (const m of hit) { inc[`refStats.${m}.n`] = 1; inc[`refStats.${m}.mm`] = REF[m]; }   // Invite page: friends done + $Devine per step
    await users.updateOne(
      { telegramId: u.referredBy, isBanned: { $ne: true }, accountLocked: { $ne: true } },
      { $inc: inc, $min: cyMin() }
    );
  } catch (e) { console.error('refCheck failed:', e); }
}
