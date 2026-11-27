// FILE PATH: api/adcredit.js
// 📺 AD CONFIRMATION RECEIVER (server-to-server). Adsgram calls this URL itself when a user FINISHES a rewarded ad:
//     GET https://<your-server>/api/adcredit?userid=[userId]&secret=<ADSGRAM_S2S_SECRET>
// We store one "credit" for that user. api/farm.js (when CARE_AD_S2S=1) pays a Spirit reward claim (which needs an ad) ONLY if it
// can consume a fresh credit, so a script that never shows an ad (it only calls our API) can no longer earn.
// A credit lives 1 day (TTL) and one user can hold at most 20 unused credits.
//
// Render env:  ADSGRAM_S2S_SECRET = long random text (also written inside the Reward URL in the Adsgram dashboard)
//              CARE_AD_S2S        = 1 turns the enforcement on in api/daily.js (OFF = old behaviour, nothing changes)
// NOTE: Adsgram only sends this callback for REWARDED blocks. See PATCH_NOTES.md.
import crypto from 'crypto';
import { getDb } from '../lib/mongodb.js';

const safeEq = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
let ttlDone = false;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  const secret = process.env.ADSGRAM_S2S_SECRET;
  if (!secret) return res.status(503).json({ error: 's2s_not_configured' });
  if (!safeEq(req.query?.secret || '', secret)) return res.status(403).json({ error: 'forbidden' });
  const userid = String(req.query?.userid || '');
  if (!/^\d{3,15}$/.test(userid)) return res.status(400).json({ error: 'invalid_userid' });

  const db = await getDb();
  const col = db.collection('adsgramS2S');
  if (!ttlDone) { ttlDone = true; col.createIndex({ at: 1 }, { expireAfterSeconds: 86400 }).catch(() => {}); }
  const open = await col.countDocuments({ telegramId: userid, network: 'care', used: false });
  if (open >= 20) return res.status(200).json({ ok: true, ignored: true });
  await col.insertOne({ telegramId: userid, network: 'care', used: false, at: new Date() });
  return res.status(200).json({ ok: true });
}
