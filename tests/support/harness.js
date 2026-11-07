import { FakeDb } from './fakeDb.js';
import { loadEnv } from '../../server/lib/env.js';
import { createApp } from '../../server/index.js';
import { seedContent, invalidateContent } from '../../server/services/content.js';
import { signInitDataForTests, hashPassword } from '../../server/lib/auth.js';
import { generateCollect, PLAYER } from '../../web/shared/collect.js';
import { generateSky, skyLowerBounds } from '../../web/shared/sky.js';
import { createBattle } from '../../web/shared/battle.js';
import crypto from 'node:crypto';

export const BOT = '123456:TEST-bot-token';
export const ADMIN_PW = 'correct horse battery staple';
let ipCounter = 0;

export async function boot(extraEnv = {}) {
  invalidateContent();
  const db = new FakeDb(); await db.ensureIndexes(); await seedContent(db);
  const env = loadEnv({ NODE_ENV: 'test', BOT_TOKEN: BOT, SESSION_SECRET: 's'.repeat(48), ADS_SECRET: 'ad-secret-123', ...extraEnv,
    ADMIN_ACCOUNTS: JSON.stringify([{ username: 'root', passwordHash: hashPassword(ADMIN_PW), role: 'owner' }, { username: 'sup', passwordHash: hashPassword(ADMIN_PW), role: 'support' }, { username: 'fin', passwordHash: hashPassword(ADMIN_PW), role: 'finance' }]) });
  const server = createApp({ db, env }).listen(0);
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { token, body, ip } = {}) {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-test-ip': ip || `10.0.0.${(ipCounter++ % 250) + 1}`, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
  }
  const player = async (id = Math.floor(Math.random() * 1e9) + 1000) => {
    const r = await call('POST', '/api/auth/telegram', { body: { initData: signInitDataForTests({ id, first_name: 'P' + id }, BOT) } });
    if (r.status !== 200) throw new Error('login failed ' + JSON.stringify(r));
    const t = r.body.token;
    return { id, uid: String(id), token: t, profile: r.body.profile,
      get: (p) => call('GET', '/api' + p, { token: t }), post: (p, b) => call('POST', '/api' + p, { token: t, body: b ?? {} }) };
  };
  const admin = async (username = 'root') => {
    const r = await call('POST', '/api/admin/login', { body: { username, password: ADMIN_PW } });
    const t = r.body?.token;
    return { token: t, get: (p) => call('GET', '/api/admin' + p, { token: t }), post: (p, b) => call('POST', '/api/admin' + p, { token: t, body: b ?? {} }), patch: (p, b) => call('PATCH', '/api/admin' + p, { token: t, body: b }) };
  };

  // ── honest-client bots (use the same shared sims the real client uses) ──
  const backdate = (sid, ms) => db.collection('game_sessions').updateOne({ sid }, { $set: { startedAt: new Date(Date.now() - ms) } });
  function collectPicks(s) {
    const lay = generateCollect(s.mode, s.seed, s.params), picks = []; let p = { x: 0, z: 0 }, t = 0; const left = [...lay.items];
    while (left.length) { left.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z)); const it = left.shift(); t += (Math.hypot(it.x - p.x, it.z - p.z) / PLAYER.speed) * 1100 + 60; if (t > lay.timeLimit * 1000 * 0.95) break; picks.push({ id: it.id, t: Math.round(t) }); p = it; }
    return { picks, lastT: t };
  }
  function battleActions(cfg) {
    const b = createBattle(cfg), acts = [];
    while (!b.state.over) { const me = b.state.team[b.state.active]; const a = me.cd === 0 ? 'ability' : (b.state.intent === 'heavy' && acts.length % 3 === 0 ? 'guard' : 'attack'); b.step(a); acts.push(a); }
    return { acts, result: b.state.result };
  }
  /** plays a stage like an honest client; returns the finish response. Retries lost battles with a fresh session. */
  async function play(pl, stage, team) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const st = await pl.post('/game/session/start', { kind: 'stage', stage, ...(team ? { team } : {}) });
      if (st.status !== 200) return st;
      const s = st.body; let body;
      if (s.mode === 'adventure' || s.mode === 'crystal') { const { picks, lastT } = collectPicks(s); body = { sid: s.sid, picks }; await backdate(s.sid, lastT + 2000); }
      else if (s.mode === 'sky') { const c = generateSky(s.seed, s.params), times = skyLowerBounds(c).map((x) => Math.round(x * 1.6)); body = { sid: s.sid, times }; await backdate(s.sid, times.at(-1) + 2000); }
      else { const { acts } = battleActions(s.battle); body = { sid: s.sid, actions: acts }; await backdate(s.sid, acts.length * 600 + 1000); }
      const fin = await pl.post('/game/session/finish', body);
      if (fin.status !== 200 || fin.body.cleared) return fin;
    }
    throw new Error('could not clear stage ' + stage);
  }
  const jumpTo = async (uid, patch) => db.collection('player_progress').updateOne({ uid }, { $set: patch });
  return { db, env, base, call, player, admin, play, backdate, battleActions, collectPicks, jumpTo, close: () => server.close() };
}
