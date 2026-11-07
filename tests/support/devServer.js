// Local dev/smoke server: in-memory DB + (real or shimmed) express. NOT for production. Usage: node --import ./tests/support/register.js tests/support/devServer.js
import { FakeDb } from './fakeDb.js';
import { loadEnv } from '../../server/lib/env.js';
import { createApp } from '../../server/index.js';
import { seedContent } from '../../server/services/content.js';
import { newProgress } from '../../server/services/progress.js';

export async function startDevServer({ port = 0, seed } = {}) {
  const db = new FakeDb(); await db.ensureIndexes(); await seedContent(db);
  const env = loadEnv({ NODE_ENV: 'development', BOT_TOKEN: 'dev:token', SESSION_SECRET: 'd'.repeat(48), DEV_AUTH_BYPASS: '1' });
  if (seed) await seed(db);
  const server = createApp({ db, env }).listen(port); await new Promise((r) => server.on('listening', r));
  return { db, port: server.address().port, close: () => server.close() };
}
export { newProgress };
