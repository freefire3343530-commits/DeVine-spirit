// FILE PATH: lib/spiritCare.js
// 🌿 SPIRIT CARE + 3-HOUR REWARD CYCLE  (100% server-side; the app only displays what this file computes)
//
// Four statuses per spirit: f = Fullness, w = Water, c = Clean, m = Mood  (each 0..100).
// A reward cycle lasts cfg.hours (Leaf = 3h). Inside a cycle every status drops TICK_PTS (5) points every cycleMs/6
// (Leaf: every 30 min) -> at most 30 points per cycle. The drop is a pure function of SERVER time, so closing the app,
// refreshing it or changing the phone clock changes nothing.
//
//   Base reward  = floor((f+w+c+m)/4)            (max 100, scaled by cfg.reward/100 for the paid spirits)
//   Shower bonus = +20 once per cycle            (Shower also sets all four statuses to 100)
//   Final reward = Base + Shower bonus           (max 120, never more)
//
// When the cycle time is over the statuses are FROZEN (no more decay, no more care) until the reward is claimed, so a user
// who comes back late still gets exactly the reward of the finished cycle. A claim pays once, then starts a new cycle.
//
// Stored on users.spiritCare.<spiritId> = {
//   cycleId, cycleStart(ms), f,w,c,m (values at tick0), tick0, happiness, lastUpdate(ms),
//   showerUsed, claimStatus:'open', lastReward:{cycleId,base,bonus,total,avg,at,status:'claimed'}, reqs:[idempotency keys], petAt, waterAt
// }
// users.careV is a version counter: every change is a compare-and-set on it, so two parallel requests can never both win.
// History: collection spiritTx (spirit_reward / shower_bonus are unique per cycle through a unique index).
import { cyInc, cyMin } from './cycleStats.js';
import { bdTodayKey } from './dateUtils.js';

export const clock = { now: () => Date.now() };   // tests replace this

export const TICKS = 6;          // decay steps per cycle
export const TICK_PTS = 5;       // points lost per step
export const MAX_BASE = 100;
export const BONUS = 20;
export const KEYS = ['f', 'w', 'c', 'm'];

// ===== EDIT HERE: care shop =====
export const CARE = {
  food:   { price: 10, restore: 20, dailyLimit: 30 },   // Fullness +20, 30 foods per Bangladesh day (paid + ad together)
  shower: { price: 20 },                                // restores everything to 100 + bonus
  water:  { restore: 20, cooldownMs: 20000 },           // free
  pet:    { restore: 2,  cooldownMs: 5000 },            // free Mood
};
// =================================

const clampPct = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));

export function freshState(id, now, since) {
  const cycleStart = since || now;
  return { cycleId: `${id}_${cycleStart}`, cycleStart, f: 100, w: 100, c: 100, m: 100, tick0: 0, happiness: 100, lastUpdate: now,
           showerUsed: false, claimStatus: 'open', lastReward: null, reqs: [], petAt: 0, waterAt: 0 };
}

// What the statuses / reward are RIGHT NOW (server time) for a stored state.
export function view(st, now, cfg) {
  const cycleMs = cfg.hours * 3600000, tickMs = cycleMs / TICKS;
  const elapsed = Math.max(0, now - st.cycleStart);
  const tick = Math.min(TICKS, Math.floor(elapsed / tickMs));
  const drop = TICK_PTS * Math.max(0, tick - (st.tick0 || 0));
  const v = { f: clampPct(st.f - drop), w: clampPct(st.w - drop), c: clampPct(st.c - drop), m: clampPct(st.m - drop) };
  const avg = (v.f + v.w + v.c + v.m) / 4;
  const scale = cfg.reward / MAX_BASE;
  const base = Math.min(MAX_BASE, Math.floor(avg + 1e-9)) * scale;
  const bonus = st.showerUsed ? BONUS * scale : 0;
  const maxTotal = (MAX_BASE + BONUS) * scale;
  const total = Math.min(maxTotal, base + bonus);
  const complete = elapsed >= cycleMs;
  return { ...v, tick, avg, base, bonus, total, scale, maxTotal, complete, cycleMs, tickMs,
           cycleEnd: st.cycleStart + cycleMs, nextTickAt: complete || tick >= TICKS ? null : st.cycleStart + (tick + 1) * tickMs };
}

const foodUsedToday = (user, now) => (user?.care?.foodDay === bdTodayKey(new Date(now)) ? (user.care.foodCount || 0) : 0);

export function snapshot(user, id, cfg, now) {
  const st = user.spiritCare[id], v = view(st, now, cfg);
  return {
    spiritId: id, cycleId: st.cycleId, cycleStart: st.cycleStart, cycleMs: v.cycleMs, tickMs: v.tickMs, ticks: TICKS, tickPts: TICK_PTS,
    serverNow: now, tick0: st.tick0 || 0, stat0: { f: st.f, w: st.w, c: st.c, m: st.m },
    f: v.f, w: v.w, c: v.c, m: v.m, happiness: Math.round(v.avg * 10) / 10, avg: Math.round(v.avg * 100) / 100,
    base: v.base, bonus: v.bonus, total: v.total, maxTotal: v.maxTotal, scale: v.scale,
    showerUsed: !!st.showerUsed, claimStatus: st.claimStatus, complete: v.complete, claimable: v.complete && st.claimStatus === 'open',
    cycleEnd: v.cycleEnd, nextTickAt: v.nextTickAt, lastReward: st.lastReward || null,
    balance: user.egBalance || 0, foodUsed: foodUsedToday(user, now), foodLimit: CARE.food.dailyLimit,
  };
}

// state saved after a change: values are "rebased" to the current tick so the decay never counts twice
function rebased(st, v, now, patch = {}) {
  const n = { ...st, f: v.f, w: v.w, c: v.c, m: v.m, tick0: v.tick, ...patch, lastUpdate: now };
  n.happiness = Math.round(((n.f + n.w + n.c + n.m) / 4) * 10) / 10;
  return n;
}
const withReq = (st, reqId) => (reqId ? { ...st, reqs: [...(st.reqs || []), reqId].slice(-30) } : st);

// Pay with $Devine, or with a verified one-time ad token.
function charge(user, price, o) {
  if (o.pay === 'ad') {
    if (!(o.adStart > 0)) return { error: 'missing_ad_token' };
    if ((user.careAdLastUsed || 0) >= o.adStart) return { error: 'ad_token_used' };
    return { inc: { careAdCount: 1 }, set: { careAdLastUsed: o.adStart }, filter: {}, spent: 0 };
  }
  if ((user.egBalance || 0) < price) return { error: 'not_enough_devine' };
  return { inc: { egBalance: -price, careSpent: price }, set: {}, filter: { egBalance: { $gte: price } }, spent: price };
}

// compare-and-set loop. fn(ctx) decides; we write with a filter on careV (+ whatever fn asks for).
async function mutate(users, tgId, id, cfg, fn, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const now = clock.now();
    const user = await users.findOne({ telegramId: tgId });
    if (!user) return { error: 'not_found' };
    if (!user.spiritCare || !user.spiritCare[id]) {
      const since = user.spiritClaims && user.spiritClaims[id] ? new Date(user.spiritClaims[id]).getTime() : now;
      await users.findOneAndUpdate({ telegramId: tgId, [`spiritCare.${id}`]: { $exists: false } },
        { $set: { [`spiritCare.${id}`]: freshState(id, now, since) } }, { returnDocument: 'after' });
      continue;
    }
    const st = user.spiritCare[id], v = view(st, now, cfg);
    const out = fn({ user, st, v, now });
    if (out.error || out.dup) return { ...out, user, now };
    const cv = user.careV || 0;
    const filter = { telegramId: tgId, careV: cv ? cv : { $exists: false }, ...(out.filter || {}) };
    const upd = { $set: { ...out.set, careV: cv + 1 } };
    if (out.inc && Object.keys(out.inc).length) upd.$inc = out.inc;
    if (out.min) upd.$min = out.min;
    const r = await users.findOneAndUpdate(filter, upd, { returnDocument: 'after' });
    const doc = r?.value || r;
    if (doc && doc.telegramId) return { ok: true, user: doc, now, tx: out.tx || [], result: out.result || {} };
  }
  return { error: 'busy' };
}

let idxDone = false;
async function record(db, tgId, id, now, tx) {
  if (!tx.length) return;
  const col = db.collection('spiritTx');
  if (!idxDone) {
    idxDone = true;
    col.createIndex({ telegramId: 1, spiritId: 1, cycleId: 1, type: 1 }, { unique: true, partialFilterExpression: { type: { $in: ['spirit_reward', 'shower_bonus'] } } }).catch(() => {});
    col.createIndex({ telegramId: 1, at: -1 }).catch(() => {});
  }
  const docs = tx.map((t) => ({ telegramId: tgId, spiritId: id, at: new Date(now), ...t }));
  try { await col.insertMany(docs, { ordered: false }); } catch (e) { /* duplicate key = already recorded */ }
}

// kind: state | food | water | pet | shower | claim
// o: { pay:'devine'|'ad', adStart, reqId, cycleId }
export async function runAction(db, tgId, id, cfg, kind, o = {}) {
  const users = db.collection('users');
  const reqId = o.reqId ? String(o.reqId).slice(0, 64) : null;

  const fn = ({ user, st, v, now }) => {
    if (reqId && (st.reqs || []).includes(reqId)) return { dup: true };                 // idempotency: same request twice -> no second effect
    if (kind === 'state') return { dup: true };
    const scale = v.scale;

    if (kind === 'claim') {
      if (o.cycleId !== st.cycleId) {
        if (st.lastReward && st.lastReward.cycleId === o.cycleId) return { dup: true, alreadyClaimed: true };
        return { error: 'stale_cycle' };
      }
      if (st.claimStatus !== 'open') return { dup: true, alreadyClaimed: true };
      if (!v.complete) return { error: 'not_ready' };
      const ch = charge(user, 0, { pay: 'ad', adStart: o.adStart });   // every claim needs one finished ad
      if (ch.error) return { error: ch.error === 'missing_ad_token' ? 'ad_required' : ch.error };
      const total = v.total;
      const next = { ...freshState(id, now), f: v.f, w: v.w, c: v.c, m: v.m, happiness: Math.round(v.avg * 10) / 10,
        reqs: [...(st.reqs || []), ...(reqId ? [reqId] : [])].slice(-30),
        lastReward: { cycleId: st.cycleId, base: v.base, bonus: v.bonus, total, avg: Math.round(v.avg * 100) / 100, at: now, status: 'claimed' } };
      return {
        set: { [`spiritCare.${id}`]: next, [`spiritClaims.${id}`]: new Date(now), ...ch.set },
        inc: { ...ch.inc, egBalance: total, spiritEarned: total, ...cyInc('spirit', total) }, min: cyMin(),
        tx: [{ type: 'spirit_reward', cycleId: st.cycleId, amount: total, base: v.base, bonus: v.bonus, avg: Math.round(v.avg * 100) / 100, status: 'credited' }],
        result: { reward: total, base: v.base, bonus: v.bonus },
      };
    }

    // everything below changes the spirit: not possible once the cycle is over (frozen until the reward is claimed)
    if (v.complete) return { error: 'cycle_complete' };

    if (kind === 'water' || kind === 'pet') {
      const key = kind === 'water' ? 'w' : 'm', at = kind === 'water' ? 'waterAt' : 'petAt', c = CARE[kind];
      if (v[key] >= 100) return { error: 'already_full' };
      if (now - (st[at] || 0) < c.cooldownMs) return { error: 'cooldown' };
      const next = withReq(rebased(st, v, now, { [key]: Math.min(100, v[key] + c.restore), [at]: now }), reqId);
      return { set: { [`spiritCare.${id}`]: next }, result: {} };
    }

    if (kind === 'food') {
      if (v.f >= 100) return { error: 'already_full' };
      const used = foodUsedToday(user, now);
      if (used >= CARE.food.dailyLimit) return { error: 'food_limit' };
      const ch = charge(user, CARE.food.price, o);
      if (ch.error) return { error: ch.error };
      const next = withReq(rebased(st, v, now, { f: Math.min(100, v.f + CARE.food.restore) }), reqId);
      return {
        set: { [`spiritCare.${id}`]: next, 'care.foodDay': bdTodayKey(new Date(now)), 'care.foodCount': used + 1, ...ch.set },
        inc: ch.inc, filter: ch.filter,
        tx: ch.spent ? [{ type: 'care_spend', item: 'food', cycleId: st.cycleId, amount: -ch.spent }] : [{ type: 'care_free', item: 'food', cycleId: st.cycleId, amount: 0, via: 'ad' }],
        result: { restored: CARE.food.restore },
      };
    }

    if (kind === 'shower') {
      const allFull = v.f >= 100 && v.w >= 100 && v.c >= 100 && v.m >= 100;
      if (st.showerUsed && allFull) return { error: 'already_clean' };
      const ch = charge(user, CARE.shower.price, o);
      if (ch.error) return { error: ch.error };
      const first = !st.showerUsed;                          // the +20 bonus only exists once per cycle
      const next = withReq(rebased(st, v, now, { f: 100, w: 100, c: 100, m: 100, showerUsed: true }), reqId);
      const tx = [];
      if (ch.spent) tx.push({ type: 'care_spend', item: 'shower', cycleId: st.cycleId, amount: -ch.spent });
      else tx.push({ type: 'care_free', item: 'shower', cycleId: st.cycleId, amount: 0, via: 'ad' });
      if (first) tx.push({ type: 'shower_bonus', cycleId: st.cycleId, amount: BONUS * scale, status: 'pending_claim' });   // paid inside the cycle reward
      return { set: { [`spiritCare.${id}`]: next, ...ch.set }, inc: ch.inc, filter: ch.filter, tx, result: { bonusAwarded: first, bonus: first ? BONUS * scale : 0 } };
    }
    return { error: 'invalid_action' };
  };

  const res = await mutate(users, tgId, id, cfg, fn);
  const now = res.now || clock.now();
  if (res.user && res.user.spiritCare && res.user.spiritCare[id]) res.snap = snapshot(res.user, id, cfg, now);
  if (res.ok) await record(db, tgId, id, now, res.tx);
  return res;
}

export async function history(db, tgId, limit = 30) {
  return db.collection('spiritTx').find({ telegramId: tgId }).sort({ at: -1 }).limit(limit).toArray();
}
