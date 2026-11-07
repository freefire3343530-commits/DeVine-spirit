# DIVINE SPIRIT — *A World Beyond Imagination.*
Telegram Mini App: 3D fantasy RPG (5 worlds, 50 stages, 4 collectible spirits, 4 playable modes), server-authoritative economy.
**Status: vertical slice, not production-ready.** Read `docs/TEST_REPORT.md` and "Known limitations" first.

## Structure
```
server/        Express API (auth, ledger, sessions/verification, ads, withdrawals, leaderboard, admin)
web/           Mini App client (Three.js) · web/admin admin dashboard · web/shared rules used by BOTH client and server
tests/         node:test suites + in-memory DB fake + Express shim
docs/          API.md · ADS.md · TEST_REPORT.md
legacy/        previous Gram Edge Farm app, preserved untouched, not deployed
```
Why this architecture: it keeps the old project's stack (Node ESM, Express, MongoDB driver, vanilla frontend) — no framework migration. The same deterministic modules (`web/shared`) generate levels and run battles on the client **and** let the server verify results, which is how score/reward tampering is prevented without trusting the client.

## Install & run
```
npm install
cp .env.example .env     # fill BOT_TOKEN, SESSION_SECRET, MONGODB_URI (replica set / Atlas), ALLOWED_ORIGIN, ADMIN_ACCOUNTS
npm run hash-password -- 'a long passphrase'    # → passwordHash for ADMIN_ACCOUNTS
npm run vendor           # self-host Three.js 0.170.0 (otherwise loaded from jsDelivr)
npm test
SERVE_WEB=1 npm start    # API + client + /admin/ on one origin
```
Local without Telegram: `NODE_ENV=development DEV_AUTH_BYPASS=1` then open `http://localhost:3000/?dev=1` (refused in production).
Telegram: BotFather → set the Mini App / menu button URL to your HTTPS host. Admin: `https://host/admin/`.
Deploy: `render.yaml` provided (Render). Frontend can instead be static (set `<meta name="api-base">` and `ALLOWED_ORIGIN`). Large assets: none needed yet (spirits/worlds are procedural); if you add GLBs, serve them from a CDN/object store.

## How the rules are enforced
* Identity only from server-verified Telegram `initData`; session tokens HMAC-signed, revocable. Balances/XP/levels exist only in MongoDB; the client sends only inputs (picked ids+times, checkpoint times, battle actions).
* Every balance change = one immutable `transactions` row with a **unique idempotency key** inside a MongoDB transaction → duplicate claims impossible. One-shot status transitions for sessions, ads, missions, daily reward, withdrawals.
* **Two currencies.** Spirit Coins: free in-game. Divine Rewards (integer units): paid *only* from a funded, capped budget (`rewards/dr_budget`, **starts at 0**); empty budget ⇒ zero DR, never a fake balance. Withdrawals closed by default (needs `withdrawalsOpen` + a rate), always manually approved, with level/stage/account-age/daily-limit/one-wallet rules and fraud-review block.
* Admin: separate scrypt credentials, roles, whitelisted+range-checked edits, audit log on every write.

## Features: done vs not
**Implemented (see test report for how far each is verified):** Telegram auth · 50-stage progression with server XP/levels/unlocks/rewards (admin-configurable) · 5 distinct procedural worlds with own palette/lighting/ambience/music/ambient sound · 4 original procedural spirits with idle/walk/fly/ability/victory/evolve/level-up animations · spirit collection, upgrade, evolution · Spirit Adventure, Crystal Hunt, Spirit Battle (enemy AI intents, elements, cooldowns, swap, victory/defeat), Sky Challenge (physics, checkpoints) · daily reward, daily missions, achievements · leaderboards (global/weekly/achievements) · weekly world boss (damage ranking, 5 tries/day, admin settlement) · personal island (place spirits/decorations, saved) · rewarded-ad framework · withdrawal pipeline · admin API + dashboard · low/medium/high graphics + FPS-adaptive downgrade · independent music/SFX volumes, haptics, Telegram back button.

**Not done / simplified (honest list):**
* Not run in a real 3D environment or on a device; visuals, controls feel, balance and performance are **unverified**.
* Art is procedural primitives, not Blender GLB models; no texture compression/LOD (instancing + density scaling instead). Walk/fly animations are procedural transforms, not skeletal.
* Music/SFX are synthesized and basic. Battle swap picks the next living spirit (no chooser UI).
* Client is plain JavaScript (JSDoc-free), not TypeScript.
* "Weekly challenges" = weekly leaderboard + boss only. Personal island has no interactive environmental objects. Admin lacks spirit/world/mission *creation* (edit-only) and charts; analytics are counters.
* Sky/collect verification is plausibility-based (distance/speed/time bounds), not full input replay: a skilled cheater could still make a bot play within human-possible limits. Battles are fully replay-verified.
* Per-process rate limiting; use a shared store behind multiple instances. No CAPTCHA/device fingerprinting/KYC.
* Ads and TON payout are not automated or tested against live services (payouts are manual by design).

## Open decisions (yours)
1. **Old MM$ economy**: legacy balances/withdrawals remain in DB `tonedge`, untouched. Decide: honor/pay out, convert, or retire — nothing was migrated.
2. Fund the DR budget and set `drToUsd` only with real money behind it; keep `withdrawalsOpen=false` until then. Check legal/tax/Telegram policy for redeemable rewards in your regions.
3. Provide real art/audio if you want AAA visuals (GLB pipeline hook points: `web/js/scene/spirits.js`, `worlds.js`).
