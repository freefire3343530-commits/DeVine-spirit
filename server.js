// FILE PATH: server.js
// (GitHub repo te ei path e file ta rakhbe: server.js)
// DeVine Spirit API — standalone Express server (no Vercel needed).
// Runs on any Node host: Render, Railway, VPS, etc.
// 🛡 Protected by lib/shield.js (rate limits, auto-block, webhook secret) + lib/traps.js (honeypot URLs) + crash guards below.
import express from 'express';
import cors from 'cors';

import user from './api/user.js';
import tasks from './api/tasks.js';
import daily from './api/daily.js';
import withdraw from './api/withdraw.js';
import bot from './api/bot.js';
import payments from './api/payments.js';
import cron from './api/cron.js';
import farm from './api/farm.js';
import logo from './api/logo.js';
import payouts from './api/payouts.js';
import human from './api/human.js';
import adcredit from './api/adcredit.js';
import ads from './api/ads.js';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');   // avoids "fetch failed" when a host's IPv6 route to Telegram/Mongo is broken
import { shieldIp, shieldUser } from './lib/shield.js';
import { HONEYPOT_PATHS, honeypotHit } from './lib/traps.js';
import { verifyTelegramInit } from './lib/auth.js';
import { sanitizeInput } from './lib/sanitize.js';
import { getDb } from './lib/mongodb.js';

// A bug or a hacker's weird request must NEVER kill the server: log it and keep running.
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // so x-forwarded-for / IP checks work behind the host's proxy
app.use((_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });

// Only your frontend (and Telegram, which sends no Origin header) may call the API.
// ALLOWED_ORIGIN = your frontend URL(s), comma separated, e.g. https://de-vine-spirit.vercel.app
const allowed = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowed.length === 0 || allowed.includes(origin)) return cb(null, true);
    cb(new Error('Origin not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

// Health check — also use this URL for the free uptime pinger (keeps the server awake). Not rate limited, costs nothing.
app.get('/health', (_req, res) => res.json({ ok: true, t: Date.now() }));

app.use(shieldIp);                                  // 🛡 1: webhook secret + per-IP limit (before the body is even read)
app.use(express.json({ limit: '64kb' }));           // nobody needs a bigger body, and big bodies are a cheap way to hurt a small server
app.use(sanitizeInput);                             // 🧼 no Mongo-operator injection ($ne, $regex ...) in body or query
app.use(shieldUser);                                // 🛡 2: per-user limit (100/min) + fake-session limit

const routes = { user, tasks, daily, farm, withdraw, bot, payments, cron, logo, payouts, human, adcredit, ads };
app.all('/api/:name', async (req, res) => {
  const name = req.params.name;
  const handler = Object.prototype.hasOwnProperty.call(routes, name) ? routes[name] : null; // 'constructor' & co. are not routes
  if (!handler) {
    // 🪤 honeypot: decoy URLs the real app never calls. Logged (and the user is flagged if a valid session came with it), then answered like any unknown URL.
    if (HONEYPOT_PATHS.includes(name)) {
      try {
        const src = req.method === 'GET' ? req.query : (req.body || {});
        const tg = verifyTelegramInit(typeof src?.initData === 'string' ? src.initData : '');
        await honeypotHit(await getDb(), req, name, tg?.id ? String(tg.id) : null);
      } catch { /* a trap must never break the server */ }
    }
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    await handler(req, res);
  } catch (err) {
    console.error(`[${name}]`, err);
    // Telegram re-sends a webhook update for ever while we answer 500, so the bot always answers 200
    if (!res.headersSent) res.status(name === 'bot' ? 200 : 500).json(name === 'bot' ? { ok: true } : { error: 'Server error' });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  if (err?.message === 'Origin not allowed') return res.status(403).json({ error: 'Origin not allowed' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request' });
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'Server error' });
});

if (allowed.length === 0) console.warn('⚠️  ALLOWED_ORIGIN is not set: ANY website may call this API from a browser. Set it to your frontend URL (e.g. https://de-vine-spirit.vercel.app).');
if (!process.env.WEBHOOK_SECRET) console.warn('⚠️  WEBHOOK_SECRET is not set: the bot webhook rejects everything (fail-closed). Set it, then call /api/cron?job=setWebhook.');

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  console.log(`DeVine Spirit API listening on :${port}`);
  getDb().then(() => console.log('MongoDB connected (warm)')).catch((e) => console.error('MongoDB warm-up failed:', e.message)); // first tap is no longer slow
  // Keep-awake ping while the server is up. NOTE: a sleeping free server cannot wake itself, so ALSO add an
  // external pinger (UptimeRobot / cron-job.org) hitting <your-url>/health every 5 minutes.
  const self = (process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  if (self) setInterval(() => fetch(`${self}/health`).catch(() => {}), 4 * 60 * 1000).unref?.();
});
server.requestTimeout = 30_000;   // a slow-loris request cannot hold a connection for ever
server.headersTimeout = 35_000;
server.keepAliveTimeout = 65_000;
process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 8000).unref(); });
