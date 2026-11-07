import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/env.js';
import { connectDb } from './lib/db.js';
import { HttpError } from './lib/http.js';
import { seedContent } from './services/content.js';
import { apiRouter } from './routes/api.js';
import { adminRouter } from './routes/admin.js';

export function createApp({ db, env, webDir }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.trustProxy);
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Strict-Transport-Security': 'max-age=15552000' });
    next();
  });
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  // Strict CORS allow-list (Telegram clients send the Mini App origin; a missing Origin = server-to-server, e.g. ad callbacks).
  app.use(cors({ origin(origin, cb) { cb(null, !origin || env.allowedOrigins.includes(origin) || (!env.prod && env.allowedOrigins.length === 0)); },
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'], maxAge: 600 }));
  app.use(express.json({ limit: '20kb' }));
  app.get('/health', (_req, res) => res.json({ ok: true, t: Date.now() }));
  app.use('/api/admin', adminRouter({ db, env }));
  app.use('/api', apiRouter({ db, env }));
  if (webDir) app.use(express.static(webDir));          // optional: serve the web client from the same host
  app.use((req, _res, next) => next(new HttpError(404, 'not_found')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') return res.status(400).json({ error: 'bad_request' });
    console.error('[error]', err);                                   // details stay in server logs, never in the response
    res.status(500).json({ error: 'server_error' });
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = loadEnv();
  const db = await connectDb(env);
  await seedContent(db);
  const webDir = process.env.SERVE_WEB === '1' ? path.join(path.dirname(fileURLToPath(import.meta.url)), '../web') : undefined;
  const app = createApp({ db, env, webDir });
  app.listen(env.port, () => console.log(`DIVINE SPIRIT API on :${env.port}`));
}
