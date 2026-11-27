// FILE PATH: lib/adProof.js
// 📺 Optional real-ad proof for Spirit reward claims (moved out of api/daily.js).
// OFF until CARE_AD_S2S=1 and ADSGRAM_S2S_SECRET are set (see api/adcredit.js).
// ON: a claim needs a fresh credit that ADSGRAM ITSELF sent for this user after the signed start token was issued.
export const adS2SOn = () => process.env.CARE_AD_S2S === '1' && !!process.env.ADSGRAM_S2S_SECRET;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reserve one unused credit (Adsgram's callback can arrive a moment after the app's own "ad closed": wait up to ~4s).
export async function takeAdCredit(db, tgId, adStart) {
  const col = db.collection('adsgramS2S');
  for (let i = 0; i < 5; i++) {
    const r = await col.findOneAndUpdate(
      { telegramId: tgId, network: 'care', used: false, at: { $gte: new Date(adStart - 2000) } },
      { $set: { used: true, usedAt: new Date() } }, { sort: { at: 1 }, returnDocument: 'before' });
    const doc = r?.value !== undefined ? r.value : r;
    if (doc && doc._id) return doc;
    if (i < 4) await sleep(1000);
  }
  return null;
}
// Nothing was paid: give the credit back.
export const giveCreditBack = (db, credit) =>
  credit ? db.collection('adsgramS2S').updateOne({ _id: credit._id }, { $set: { used: false }, $unset: { usedAt: '' } }).catch(() => {}) : null;
