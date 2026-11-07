import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot, BOT } from './support/harness.js';
import { signInitDataForTests } from '../server/lib/auth.js';
import { generateCollect } from '../web/shared/collect.js';
import { generateSky, skyLowerBounds } from '../web/shared/sky.js';
import { createBattle } from '../web/shared/battle.js';

let H;
before(async () => { H = await boot(); });
after(() => H.close());

describe('authentication & sessions', () => {
  test('rejects missing / forged / expired initData and unauthenticated calls', async () => {
    assert.equal((await H.call('POST', '/api/auth/telegram', { body: {} })).status, 400);
    const forged = (await H.call('POST', '/api/auth/telegram', { body: { initData: signInitDataForTests({ id: 5, first_name: 'x' }, 'wrong:token') } }));
    assert.equal(forged.status, 401);
    const old = signInitDataForTests({ id: 5, first_name: 'x' }, BOT, Math.floor(Date.now() / 1000) - 10 * 3600);
    assert.equal((await H.call('POST', '/api/auth/telegram', { body: { initData: old } })).status, 401);
    assert.equal((await H.call('GET', '/api/me')).status, 401);
    assert.equal((await H.call('GET', '/api/me', { token: 'v1.abc.def' })).status, 401);
  });
  test('login creates a clean account: starter spirit only, zero balances, no fake rewards', async () => {
    const p = await H.player(); const me = (await p.get('/me')).body;
    assert.equal(me.balances.coins, 0); assert.equal(me.balances.dr, 0); assert.deepEqual(Object.keys(me.spirits), ['nature']); assert.equal(me.level, 1);
    assert.equal(await H.db.collection('transactions').countDocuments({ uid: p.uid }), 0);
  });
  test('login is idempotent and does not reset progress', async () => {
    const p = await H.player(777001); await H.play(p, 1);
    const again = await H.player(777001);
    assert.equal(again.profile.stagesCleared, 1); assert.equal(await H.db.collection('users').countDocuments({ uid: '777001' }), 1);
  });
  test('banning revokes live tokens immediately', async () => {
    const p = await H.player(), a = await H.admin('sup');
    assert.equal((await p.get('/me')).status, 200);
    assert.equal((await a.post(`/players/${p.uid}/status`, { status: 'banned', reason: 'testing ban' })).status, 200);
    assert.equal((await p.get('/me')).status, 401);
    assert.equal((await H.call('POST', '/api/auth/telegram', { body: { initData: signInitDataForTests({ id: p.id, first_name: 'x' }, BOT) } })).status, 403);
  });
});

describe('stage progression & server-authoritative rewards', () => {
  test('stages unlock in order; stage 2 locked before 1 is cleared', async () => {
    const p = await H.player();
    assert.equal((await p.post('/game/session/start', { kind: 'stage', stage: 2 })).body.error, 'stage_locked');
    assert.equal((await p.post('/game/session/start', { kind: 'stage', stage: 99 })).status, 400);
  });
  test('honest clear pays XP/coins exactly once, via ledger; replay pays reduced; duplicate finish is refused', async () => {
    const p = await H.player();
    const fin = await H.play(p, 1); assert.equal(fin.status, 200); assert.ok(fin.body.cleared); assert.ok(fin.body.rewards.firstClear);
    const me = (await p.get('/me')).body, tx = await H.db.collection('transactions').find({ uid: p.uid }).toArray();
    assert.equal(me.balances.coins, tx.filter((t) => t.currency === 'coins').reduce((s, t) => s + t.delta, 0), 'balance must equal ledger sum');
    assert.ok(me.xp > 0);
    const rep = await H.play(p, 1); assert.ok(!rep.body.rewards.firstClear); assert.ok(rep.body.rewards.coins < fin.body.rewards.coins);
  });
  test('finishing the SAME session twice (even concurrently) pays once', async () => {
    const p = await H.player(); const s = (await p.post('/game/session/start', { kind: 'stage', stage: 1 })).body;
    const { picks, lastT } = H.collectPicks(s); await H.backdate(s.sid, lastT + 2000);
    const rs = await Promise.all([1, 2, 3].map(() => p.post('/game/session/finish', { sid: s.sid, picks })));
    assert.equal(rs.filter((r) => r.status === 200).length, 1); assert.ok(rs.every((r) => r.status === 200 || r.status === 409));
    assert.equal(await H.db.collection('transactions').countDocuments({ uid: p.uid, type: 'stage' }), 1);
  });
  test("another player's session id cannot be settled", async () => {
    const a = await H.player(), b = await H.player(); const s = (await a.post('/game/session/start', { kind: 'stage', stage: 1 })).body;
    const { picks, lastT } = H.collectPicks(s); await H.backdate(s.sid, lastT + 2000);
    assert.equal((await b.post('/game/session/finish', { sid: s.sid, picks })).status, 409);
  });
  test('cheating: instant crystal/adventure result, forged sky times, forged battle actions are rejected and flagged; nothing paid', async () => {
    const p = await H.player();
    let s = (await p.post('/game/session/start', { kind: 'stage', stage: 1 })).body;
    const { picks } = H.collectPicks(s);                                         // honest picks but submitted instantly (no real time elapsed)
    let r = await p.post('/game/session/finish', { sid: s.sid, picks }); assert.equal(r.status, 422);
    s = (await p.post('/game/session/start', { kind: 'stage', stage: 1 })).body;
    r = await p.post('/game/session/finish', { sid: s.sid, picks: [{ id: 0, t: 1 }, { id: 1, t: 2 }, { id: 2, t: 3 }] }); assert.equal(r.status, 422);
    s = (await p.post('/game/session/start', { kind: 'stage', stage: 1 })).body; await H.backdate(s.sid, 60000);
    r = await p.post('/game/session/finish', { sid: s.sid, picks: [{ id: 0, t: 5000000 }] }); assert.equal(r.status, 422);
    const u = await H.db.collection('users').findOne({ uid: p.uid });
    assert.ok(u.fraudScore >= 3); assert.equal(u.balances.coins, 0);
    assert.equal((await p.get('/me')).body.stagesCleared, 0);
    assert.equal((await p.post('/game/session/finish', { sid: s.sid, picks: [] })).status, 409, 'rejected session cannot be retried');
  });
  test('client-supplied numbers are ignored: extra fields (coins, xp, stars) have no effect', async () => {
    const p = await H.player(); const s = (await p.post('/game/session/start', { kind: 'stage', stage: 1 })).body;
    const { picks, lastT } = H.collectPicks(s); await H.backdate(s.sid, lastT + 2000);
    const r = await p.post('/game/session/finish', { sid: s.sid, picks, coins: 1e9, xp: 1e9, stars: 3, level: 50 });
    assert.equal(r.status, 200); assert.ok(r.body.rewards.coins < 1000); assert.equal((await p.get('/me')).body.level <= 3, true);
  });
  test('all four modes are playable end-to-end through stages 1-4 (adventure, crystal, battle, sky)', async () => {
    const p = await H.player(); const modes = [];
    for (let st = 1; st <= 4; st++) { const f = await H.play(p, st); assert.equal(f.status, 200, JSON.stringify(f.body)); assert.ok(f.body.cleared); modes.push((await H.db.collection('game_sessions').find({ uid: p.uid, stage: st, status: 'settled' }).toArray())[0].mode); }
    assert.deepEqual(modes.sort(), ['adventure', 'battle', 'crystal', 'sky']);
    assert.equal((await p.get('/me')).body.stagesCleared, 4);
  });
  test('level-up grants an idempotent coin bonus and appears in the response', async () => {
    const p = await H.player(); await H.jumpTo(p.uid, { xp: 0 });
    const f = await H.play(p, 1); const me = (await p.get('/me')).body;
    if (f.body.levelUps.length) assert.ok(await H.db.collection('transactions').findOne({ uid: p.uid, type: 'levelup' }));
    assert.equal(me.balances.coins, (await H.db.collection('transactions').find({ uid: p.uid, currency: 'coins' }).toArray()).reduce((s, t) => s + t.delta, 0));
  });
});

describe('divine rewards are budget-backed (never fabricated)', () => {
  async function playerAtStage9() {
    const p = await H.player();
    const cleared = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i + 1, { stars: 3, best: 1000, clears: 1 }]));
    await H.db.collection('player_progress').updateOne({ uid: p.uid }, { $set: { stagesCleared: cleared, xp: 3000, level: 12, spirits: { nature: { level: 12, evo: 1 }, fire: { level: 12, evo: 1 }, ice: { level: 12, evo: 1 } } } });
    return p;
  }
  test('with the default EMPTY budget a milestone pays zero DR and only a coin consolation', async () => {
    const p = await playerAtStage9(); const adm = await H.admin();
    assert.equal((await adm.patch('/content/levels/10', { set: { 'params.enemyLevel': 1 } })).status, 200);
    const f = await H.play(p, 10, ['nature', 'fire', 'ice']); assert.equal(f.status, 200);
    assert.equal(f.body.rewards.dr, 0); assert.ok(f.body.rewards.drFallbackCoins > 0);
    assert.equal((await p.get('/me')).body.balances.dr, 0);
    assert.equal(await H.db.collection('transactions').countDocuments({ uid: p.uid, currency: 'dr' }), 0);
  });
  test('after an admin funds the budget, the milestone pays DR once and the budget decreases', async () => {
    const adm = await H.admin(); const before = (await H.db.collection('rewards').findOne({ _id: 'dr_budget' }));
    assert.equal((await adm.post('/budget/fund', { units: 1000, dailyMaxUnits: 500, note: 'test funding' })).status, 200);
    const p = await playerAtStage9();
    const f = await H.play(p, 10, ['nature', 'fire', 'ice']); assert.equal(f.body.rewards.dr, 20);
    const b = await H.db.collection('rewards').findOne({ _id: 'dr_budget' });
    assert.equal(b.remainingUnits, before.remainingUnits + 1000 - 20); assert.equal((await p.get('/me')).body.balances.dr, 20);
    const rep = await H.play(p, 10, ['nature', 'fire', 'ice']); assert.equal(rep.body.rewards.dr, 0, 'replays never pay DR');
    assert.equal(await H.db.collection('transactions').countDocuments({ uid: p.uid, currency: 'dr', type: 'stage_dr' }), 1);
  });
  test('daily budget cap is enforced', async () => {
    const adm = await H.admin(); await adm.post('/budget/fund', { units: 100000, dailyMaxUnits: 30, note: 'cap test funding' });
    await H.db.collection('rewards').updateOne({ _id: 'dr_budget' }, { $set: { day: '', dailyRemaining: 0 } });
    const a = await playerAtStage9(), b = await playerAtStage9();
    const fa = await H.play(a, 10, ['nature', 'fire', 'ice']), fb = await H.play(b, 10, ['nature', 'fire', 'ice']);
    assert.equal(fa.body.rewards.dr, 20); assert.equal(fb.body.rewards.dr, 0, 'second grant would exceed the 30-unit daily cap');
  });
});

describe('spirits, daily reward, missions, island', () => {
  test('daily reward: once per UTC day, ledgered', async () => {
    const p = await H.player(); const r1 = await p.post('/rewards/daily'); assert.equal(r1.status, 200); assert.equal(r1.body.coins, 50);
    assert.equal((await p.post('/rewards/daily')).status, 409);
    assert.equal(await H.db.collection('transactions').countDocuments({ uid: p.uid, type: 'daily' }), 1);
  });
  test('upgrade charges once; concurrent double-tap cannot double-upgrade; insufficient funds rolls back', async () => {
    const p = await H.player(); await H.db.collection('users').updateOne({ uid: p.uid }, { $set: { 'balances.coins': 100 } });
    const rs = await Promise.all([p.post('/spirits/upgrade', { spiritId: 'nature' }), p.post('/spirits/upgrade', { spiritId: 'nature' })]);
    assert.equal(rs.filter((r) => r.status === 200).length, 1);
    const me = (await p.get('/me')).body; assert.equal(me.spirits.nature.level, 2); assert.equal(me.balances.coins, 60);
    await H.db.collection('users').updateOne({ uid: p.uid }, { $set: { 'balances.coins': 5 } });
    assert.equal((await p.post('/spirits/upgrade', { spiritId: 'nature' })).status, 402);
    assert.equal((await p.get('/me')).body.spirits.nature.level, 2, 'failed purchase must not change state');
    assert.equal((await p.post('/spirits/upgrade', { spiritId: 'fire' })).status, 403);
  });
  test('evolution gated by spirit level, player level and cost', async () => {
    const p = await H.player(); await H.db.collection('users').updateOne({ uid: p.uid }, { $set: { 'balances.coins': 99999 } });
    assert.equal((await p.post('/spirits/evolve', { spiritId: 'nature' })).body.error, 'spirit_level_too_low');
    await H.jumpTo(p.uid, { 'spirits.nature.level': 7 });
    assert.equal((await p.post('/spirits/upgrade', { spiritId: 'nature' })).body.error, 'evolution_required');
    assert.equal((await p.post('/spirits/evolve', { spiritId: 'nature' })).body.error, 'player_level_too_low');
    await H.jumpTo(p.uid, { level: 15 }); assert.equal((await p.post('/spirits/evolve', { spiritId: 'nature' })).status, 200);
  });
  test('mission claim requires verified progress and pays once', async () => {
    const p = await H.player(), me = (await p.get('/me')).body, m = me.missions[0];
    assert.equal((await p.post('/missions/claim', { missionId: m.id })).body.error, 'mission_not_claimable');
    const today = new Date().toISOString().slice(0, 10);
    await H.jumpTo(p.uid, { missions: { day: today, progress: { [m.metric]: 999 }, claimed: [] } });
    assert.equal((await p.post('/missions/claim', { missionId: m.id })).status, 200);
    assert.equal((await p.post('/missions/claim', { missionId: m.id })).status, 409);
    assert.equal((await p.post('/missions/claim', { missionId: 'nope' })).status, 404);
  });
  test('island: only owned spirits and unlocked decorations are accepted', async () => {
    const p = await H.player();
    assert.equal((await p.post('/island', { spirits: ['fire'], decorations: [] })).status, 403);
    assert.equal((await p.post('/island', { spirits: ['nature'], decorations: [{ id: 'golden_arch', x: 1, z: 1, rot: 0 }] })).status, 403);
    await H.jumpTo(p.uid, { decorations: ['moss_lantern'] });
    const ok = await p.post('/island', { spirits: ['nature'], decorations: [{ id: 'moss_lantern', x: 3, z: -2, rot: 370 }] });
    assert.equal(ok.status, 200); assert.equal(ok.body.decorations[0].rot, 10);
    assert.equal((await p.post('/island', { spirits: ['nature'], decorations: Array(4).fill({ id: 'moss_lantern', x: 0, z: 0, rot: 0 }) })).status, 400);
  });
});

describe('withdrawals', () => {
  async function eligible(units = 5000) {
    const p = await H.player(); const old = new Date(Date.now() - 30 * 86400000);
    await H.db.collection('users').updateOne({ uid: p.uid }, { $set: { createdAt: old, 'balances.dr': units } });
    await H.db.collection('transactions').insertOne({ idemKey: `${p.uid}:dr:seed:1`, uid: p.uid, currency: 'dr', delta: units, type: 'seed', ref: '1', createdAt: new Date() });
    await H.jumpTo(p.uid, { level: 12, stagesCleared: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1, { stars: 1, best: 1, clears: 1 }])) });
    return p;
  }
  const ADDR = 'UQ' + 'A'.repeat(46);
  test('closed by default (no rate configured, flag off)', async () => {
    const p = await eligible(); assert.equal((await p.post('/withdraw', { amountUnits: 1000, address: ADDR, idemKey: 'k0000001' })).body.error, 'withdrawals_closed');
    assert.equal((await p.get('/withdraw/status')).body.open, false);
  });
  test('full lifecycle with every rule enforced, holds, refunds and ledger consistency', async () => {
    const adm = await H.admin();
    assert.equal((await adm.patch('/content/settings/economy', { set: { drToUsd: 0.01, withdrawalsOpen: true } })).status, 200);
    const p = await eligible();
    const req = (b) => p.post('/withdraw', b);
    assert.equal((await req({ amountUnits: 10, address: ADDR, idemKey: 'k0000002' })).body.error, 'below_minimum');
    assert.equal((await req({ amountUnits: 1000, address: 'not-an-address', idemKey: 'k0000003' })).body.error, 'invalid_address');
    assert.equal((await req({ amountUnits: 9999999, address: ADDR, idemKey: 'k0000004' })).body.error, 'above_daily_limit');
    assert.equal((await req({ amountUnits: -5, address: ADDR, idemKey: 'k0000005' })).status, 400);
    assert.equal((await req({ amountUnits: 1.5, address: ADDR, idemKey: 'k0000006' })).status, 400);
    const ok = await req({ amountUnits: 1000, address: ADDR, idemKey: 'k0000007' }); assert.equal(ok.status, 200); assert.equal(ok.body.feeUnits, 50); assert.equal(ok.body.netUnits, 950);
    assert.equal((await p.get('/me')).body.balances.dr, 4000);
    assert.equal((await req({ amountUnits: 1000, address: ADDR, idemKey: 'k0000007' })).status, 409, 'same idempotency key');
    assert.equal((await req({ amountUnits: 1000, address: ADDR, idemKey: 'k0000008' })).body.error, 'withdraw_pending_or_limit', 'one pending at a time');
    assert.equal((await p.get('/me')).body.balances.dr, 4000, 'failed attempts must not move balance');
    const wid = ok.body.wid, fin = await H.admin('fin'), sup = await H.admin('sup');
    assert.equal((await sup.post(`/withdrawals/${wid}/approve`)).status, 403, 'support role cannot approve');
    assert.equal((await fin.post(`/withdrawals/${wid}/paid`, { txHash: 'abcdef123456' })).status, 409, 'must be approved first');
    assert.equal((await fin.post(`/withdrawals/${wid}/approve`)).status, 200);
    assert.equal((await fin.post(`/withdrawals/${wid}/approve`)).status, 409, 'cannot approve twice');
    assert.equal((await fin.post(`/withdrawals/${wid}/paid`, { txHash: 'abcdef123456' })).status, 200);
    assert.equal((await fin.post(`/withdrawals/${wid}/reject`, { reason: 'too late' })).status, 409, 'paid is final: no refund');
    assert.equal((await p.get('/me')).body.balances.dr, 4000);
    // second withdrawal → reject → refunded exactly once
    const w2 = await req({ amountUnits: 1000, address: 'ignored-wallet-is-locked', idemKey: 'k0000009' }); assert.equal(w2.status, 200);
    assert.equal((await H.db.collection('withdrawals').findOne({ wid: w2.body.wid })).address, ADDR, 'wallet is locked to the first one');
    assert.equal((await fin.post(`/withdrawals/${w2.body.wid}/reject`, { reason: 'wrong address' })).status, 200);
    assert.equal((await fin.post(`/withdrawals/${w2.body.wid}/reject`, { reason: 'again' })).status, 409);
    assert.equal((await p.get('/me')).body.balances.dr, 4000);
    const sum = (await H.db.collection('transactions').find({ uid: p.uid, currency: 'dr' }).toArray()).reduce((s, t) => s + t.delta, 0);
    assert.equal(sum, 4000, 'ledger sum equals balance');
    assert.ok(await H.db.collection('admin_logs').findOne({ action: 'withdrawal_paid' }));
  });
  test('requirements: level, cleared stage, account age, fraud review, one wallet per account', async () => {
    const adm = await H.admin(); await adm.patch('/content/settings/economy', { set: { drToUsd: 0.01, withdrawalsOpen: true } });
    const p = await eligible(); const w = (id) => p.post('/withdraw', { amountUnits: 1000, address: ADDR.replace('AAAA', 'BBBB'), idemKey: id });
    await H.jumpTo(p.uid, { level: 3 }); assert.equal((await w('k1000001')).body.error, 'level_too_low'); await H.jumpTo(p.uid, { level: 12 });
    await H.jumpTo(p.uid, { stagesCleared: { 1: { stars: 1, best: 1, clears: 1 } } }); assert.equal((await w('k1000002')).body.error, 'stage_requirement');
    await H.jumpTo(p.uid, { stagesCleared: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1, { stars: 1, best: 1, clears: 1 }])) });
    await H.db.collection('users').updateOne({ uid: p.uid }, { $set: { createdAt: new Date() } }); assert.equal((await w('k1000003')).body.error, 'account_too_new');
    await H.db.collection('users').updateOne({ uid: p.uid }, { $set: { createdAt: new Date(Date.now() - 9e9), fraudScore: 9 } }); assert.equal((await w('k1000004')).body.error, 'account_under_review');
    await H.db.collection('users').updateOne({ uid: p.uid }, { $set: { fraudScore: 0 } });
    assert.equal((await w('k1000005')).status, 200);
    const q = await eligible(); assert.equal((await q.post('/withdraw', { amountUnits: 1000, address: ADDR.replace('AAAA', 'BBBB'), idemKey: 'k1000006' })).body.error, 'wallet_in_use');
  });
});

describe('rewarded ads (server-verified)', () => {
  const sig = (uid, nonce, ts, ev) => crypto.createHmac('sha256', 'ad-secret-123').update(`${uid}.${nonce}.$
