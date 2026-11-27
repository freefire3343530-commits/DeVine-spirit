// FILE PATH: lib/spiritCfg.js
// ONE place for the Spirit shop + reward table ($Devine). Used by api/daily.js (buy / free spirit) and api/farm.js (reward claim).
// The Gram Edge Farm system now runs the Spirits: 5 Spirits = 5 farms, each pays a FIXED reward once per cycle.
//   price  = buy price in $Devine (0 = free plan)
//   reward = $Devine paid on every claim (always 100%: feeding / showering is only for fun and never changes it)
//   hours  = hours between two claims (each Spirit has its own timer)
// Keep this table in sync with SPIRIT_CFG in index.html (the app only uses it to show prices/timers; the SERVER pays).
export const SPIRIT_CFG = {
  leaf: { price: 0,     reward: 60,   hours: 2  },   // Spirit 1 (free)
  moon: { price: 3000,  reward: 100,  hours: 4  },   // Spirit 2 Lunaling
  fire: { price: 8000,  reward: 500,  hours: 8  },   // Spirit 3 Emberling
  sun:  { price: 20000, reward: 700,  hours: 12 },   // Spirit 4 Sunling
  star: { price: 50000, reward: 1000, hours: 24 },   // Spirit 5 Starling
};
export const SPIRIT_IDS = Object.keys(SPIRIT_CFG);

// true  = a Spirit is ready to claim right after it is claimed (free) / bought (same as Gram Edge Farm).
// false = the first cycle starts at that moment (old DeVine behaviour).
export const FIRST_CLAIM_READY = true;
