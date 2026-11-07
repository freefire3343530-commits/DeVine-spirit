// FILE PATH: lib/dateUtils.js
//
// Returns today's date as YYYY-MM-DD in Bangladesh time (UTC+6), used as a
// per-day bucket key — so daily buckets/limits
// reset at Bangladesh midnight regardless of the server's own timezone.
// Bangladesh has no daylight-saving shift, so a fixed +6h offset is exact.
export function bdTodayKey(date = new Date()) {
  const bd = new Date(date.getTime() + 6 * 60 * 60 * 1000);
  return bd.toISOString().slice(0, 10); // "2026-07-31"
}
