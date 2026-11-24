// FILE PATH: lib/mongodb.js
// One shared MongoDB connection for the whole server. Every api/*.js file does:  import { getDb } from '../lib/mongodb.js';
// Needs the env var MONGODB_URI (Render -> Environment). Database name: tonedge
import { MongoClient } from 'mongodb';
import { ensureAllIndexes } from './indexes.js';

const DB_NAME = 'tonedge';

let clientPromise = null;
let indexesStarted = false;
let criticalPromise = null;

// The two UNIQUE indexes that money safety depends on (one account per Telegram id, one wallet per account) are created
// BEFORE the first request is served. Before, they appeared only 30s after boot, and in that window the
// "insert wins, the others get E11000" protection did not exist. Same keys/options as lib/indexes.js, so nothing conflicts.
async function ensureCriticalIndexes(db) {
  try {
    await db.collection('users').createIndex({ telegramId: 1 }, { unique: true });
    await db.collection('users').createIndex({ lockedWalletAddress: 1 }, { unique: true, partialFilterExpression: { lockedWalletAddress: { $type: 'string' } } });
  } catch (e) { console.error('CRITICAL: unique index could not be created (duplicate data?):', e.message); }
}

export async function getDb() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  if (!clientPromise) {
    const client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 10, minPoolSize: 2, serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000, socketTimeoutMS: 30000 });
    clientPromise = client.connect().catch((err) => { clientPromise = null; throw err; }); // retry on next call if the first connect fails
  }
  const client = await clientPromise;
  const db = client.db(DB_NAME);
  if (!criticalPromise) criticalPromise = ensureCriticalIndexes(db);
  await criticalPromise;
  if (!indexesStarted) {
    indexesStarted = true;
    // background, never blocks a request; delayed so the ~40 createIndex calls don't compete with the first real requests
    setTimeout(() => ensureAllIndexes(db).catch((e) => console.error('ensureAllIndexes failed:', e.message)), 30000).unref?.();
  }
  return db;
}
