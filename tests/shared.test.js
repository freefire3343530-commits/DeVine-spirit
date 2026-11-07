import test from 'node:test';
import assert from 'node:assert/strict';
import { LEVELS, WORLDS, SPIRITS, MAX_LEVEL, xpToReach, levelFromXp, spiritStats, worldOfLevel } from '../web/shared/config.js';
import { makeRng } from '../web/shared/rng.js';
import { generateCollect, validateCollect, collectResult, PLAYER, stepPlayer } from '../web/shared/collect.js';
import { generateSky, validateSky, skyLowerBounds, makeSkyState, stepSky } from '../web/shared/sky.js';
import { createBattle, replayBattle, elementMult } from '../web/shared/battle.js';

test('rng is deterministic per seed and differs across seeds', () => {
  const a = makeRng('x'), b = makeRng('x'), c = makeRng('y');
  const sa = [a.next(), a.next(), a.next()], sb = [b.next(), b.next(), b.next()];
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, [c.next(), c.next(), c.next()]);
});

test('50 levels, 5 worlds x 10, boss on every 10th, XP curve monotonic and level cap reachable', () => {
  assert.equal(LEVELS.length, MAX_LEVEL);
  assert.equal(WORLDS.length, 5);
  for (const w of WORLDS) assert.equal(LEVELS.filter((l) => l.world === w.id).length, 10);
  for (let n = 10; n <= 50; n += 10) { assert.equal(LEVELS[n - 1].boss, true); assert.equal(LEVELS[n - 1].mode, 'battle'); }
  for (let i = 2; i <= MAX_LEVEL; i++) assert.ok(xpToReach(i) > xpToReach(i - 1));
  assert.equal(levelFromXp(0), 1); assert.equal(levelFromXp(xpToReach(50)), 50); assert.equal(levelFromXp(xpToReach(50) - 1), 49);
  assert.equal(worldOfLevel(11).key, 'fire');
  for (const m of ['adventure', 'crystal', 'battle', 'sky']) assert.ok(LEVELS.some((l) => l.mode === m), m);
});

test('first-clear XP alone never blocks the player-level gate of the next stage', () => {
  let xp = 0;
  for (const l of LEVELS) {
    const w = worldOfLevel(l.id), need = Math.max(l.requiresLevel, l.id === w.from ? w.unlockLevel : 0);
    assert.ok(levelFromXp(xp) >= need, `stage ${l.id} needs level ${need}, would have ${levelFromXp(xp)}`);
    xp += l.reward.xp;
  }
});

test('collect: honest greedy run validates; speed hacks, duplicates, bad ids and future times are rejected', () => {
  const L = LEVELS.find((l) => l.mode === 'crystal'), lay = generateCollect('crystal', 'seed1', L.params);
  assert.deepEqual(lay, generateCollect('crystal', 'seed1', L.params));            // deterministic
  const picks = []; let p = { x: 0, z: 0 }, t = 0; const left = [...lay.items];
  while (left.length) { left.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z)); const it = left.shift(); t += (Math.hypot(it.x - p.x, it.z - p.z) / PLAYER.speed) * 1100 + 50; if (t > lay.timeLimit * 1000) break; picks.push({ id: it.id, t: Math.round(t) }); p = it; }
  const v = validateCollect(lay, picks, t + 500); assert.ok(v.ok); assert.ok(collectResult(lay, v).cleared);
  assert.equal(validateCollect(lay, picks.map((q, i) => ({ id: q.id, t: 50 + i * 5 })), 1e6).reason, 'impossible_speed');
  assert.equal(validateCollect(lay, [picks[0], picks[0]], 1e6).reason, 'bad_item');
  assert.equal(validateCollect(lay, [{ id: 9999, t: 100 }], 1e6).reason, 'bad_item');
  assert.equal(validateCollect(lay, picks, 1000).reason, 'bad_time');               // claims more time than really elapsed
  assert.equal(validateCollect(lay, [{ id: 0, t: 'x' }], 1e6).reason, 'bad_pick');
});

test('collect: obstacle layout never traps the spawn and player stays inside arena', () => {
  const lay = generateCollect('adventure', 's', LEVELS[0].params), pos = { x: 0, z: 0 };
  for (let i = 0; i < 600; i++) stepPlayer(pos, { x: 1, z: 0.3 }, 1 / 60, lay);
  assert.ok(Math.hypot(pos.x, pos.z) <= lay.arena);
});

test('sky: a simple bot can finish every sky stage; impossible times are rejected', () => {
  for (const L of LEVELS.filter((l) => l.mode === 'sky')) {
    const c = generateSky('bot' + L.id, L.params), s = makeSkyState(c), dt = 1 / 60; let T = 0, ti = 1;
    while (T < 150 && !s.finished) {
      const cur = c.platforms.find((q) => Math.abs(s.y - q.y) < 0.2 && Math.abs(s.x - q.x) <= q.w / 2 && Math.abs(s.z - q.z) <= q.d / 2);
      if (cur) ti = Math.min(c.platforms.length - 1, cur.id + 1);
      const tg = c.platforms[ti], dx = tg.x - s.x, dz = tg.z - s.z, d = Math.hypot(dx, dz) || 1;
      stepSky(s, { x: dx / d, z: dz / d, jump: !!cur && s.grounded && cur.z + cur.d / 2 - s.z < 0.35 }, dt, c); T += dt;
    }
    assert.ok(s.finished, `sky stage ${L.id} not finishable by bot`);
    const lb = skyLowerBounds(c);
    assert.ok(validateSky(c, { times: lb.map((x) => x * 1.6) }, 1e6).ok);
    assert.equal(validateSky(c, { times: lb.map(() => 100) }, 1e6).reason, 'impossible_speed');
    assert.equal(validateSky(c, { times: lb.slice(1) }, 1e6).reason, 'missing_checkpoints');
  }
});

const team = (ids, lvl = 5, evo = 0) => ids.map((id) => { const d = SPIRITS.find((s) => s.id === id); return { id, element: d.element, stats: spiritStats(d, lvl, evo), ability: d.ability }; });
const playBot = (cfg) => { const b = createBattle(cfg), acts = []; while (!b.state.over) { const me = b.state.team[b.state.active]; const a = me.cd === 0 ? 'ability' : 'attack'; assert.ok(b.step(a).ok); acts.push(a); } return { b, acts }; };

test('battle: deterministic replay, tamper detection, cooldown and swap validation, element wheel', () => {
  const cfg = { seed: 'r1', team: team(['nature', 'fire']), enemy: { name: 'e', element: 'ice', level: 4 }, maxTurns: 40 };
  const { acts, b } = playBot(cfg), r = replayBattle(cfg, acts);
  assert.ok(r.ok); assert.equal(r.result, b.state.result); assert.equal(r.damageDealt, b.state.damageDealt);
  assert.equal(replayBattle(cfg, acts.slice(0, -1)).reason, 'battle_not_finished');
  assert.equal(replayBattle(cfg, [...acts, 'attack']).reason, 'actions_after_end');
  assert.equal(replayBattle(cfg, ['hax']).reason, 'bad_action');
  const x = createBattle(cfg); assert.ok(x.step('ability').ok); assert.equal(x.step('ability').error, 'ability_cooldown');
  assert.equal(x.step('swap:0').error, 'bad_swap'); assert.equal(x.step('swap:2').error, 'bad_swap');
  assert.equal(elementMult('fire', 'ice'), 1.5); assert.equal(elementMult('ice', 'fire'), 0.75); assert.equal(elementMult('divine', 'fire'), 1);
});

test('battle: stage difficulty is winnable with a reasonable team across the 50 levels (bot, >=80% over 60 seeds)', () => {
  for (const [n, lvl, evo] of [[3, 2, 0], [10, 5, 0], [20, 9, 0], [30, 13, 1], [40, 16, 2], [50, 19, 2]]) {
    let wins = 0;
    for (let i = 0; i < 60; i++) {
      const cfg = { seed: `w${n}:${i}`, team: team(['nature', 'fire', 'ice'], lvl, evo), enemy: { name: 'e', element: 'nature', level: LEVELS[n - 1].params.enemyLevel, boss: n % 10 === 0 }, maxTurns: 40 };
      if (playBot(cfg).b.state.result === 'win') wins++;
    }
    assert.ok(wins / 60 >= 0.8, `stage ${n}: ${wins}/60`);
  }
});
