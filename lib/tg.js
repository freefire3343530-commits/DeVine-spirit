// FILE PATH: lib/tg.js
// (GitHub repo te ei path e file ta rakhbe: lib/tg.js)
// Resilient Telegram call. A sleeping / just-restarted server (or a short network hiccup) used to throw "fetch failed" and the admin
// panel answered "Something went wrong". Now a connection-level failure is retried (2 more times, short pause) before giving up.
// Retried: "fetch failed" (the request never reached Telegram), HTTP 429 (waits retry_after) and 502/503/504.
// NOT retried: a timeout (the message may already have been delivered) and normal Telegram answers like "chat not found".
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
export async function tgFetch(method, body, timeoutMs = 20000) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if ((r.status === 429 || r.status === 502 || r.status === 503 || r.status === 504) && attempt < 3) {
        let wait = 1000 * attempt;
        if (r.status === 429) { const j = await r.json().catch(() => null); wait = Math.min(5000, ((j?.parameters?.retry_after) || 1) * 1000); }
        await sleepMs(wait);
        continue;
      }
      return await r.json();
    } catch (e) {
      last = e;
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      if (timedOut || attempt === 3) break;
      console.warn(`telegram ${method} failed (${e?.cause?.code || e?.message}), retry ${attempt}/2`);
      await sleepMs(700 * attempt);
    }
  }
  const err = new Error(last?.name === 'TimeoutError' ? 'Telegram timeout' : `Telegram connection failed (${last?.cause?.code || last?.message || 'unknown'})`);
  err.cause = last;
  throw err;
}

export async function tgSend(chatId, text, extra = {}) {
  return tgFetch('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}

// ── more Telegram helpers (ported from NEWTUBE lib/telegram.js) ─────────────
export async function tgApi(method, params = {}) {
  return tgFetch(method, params);
}

// Is this user a member of the channel/group? Used by Channel/Group Join tasks (the bot must be admin there).
async function memberStatus(userId, chat) {
  try {
    const r = await tgApi('getChatMember', { chat_id: chat, user_id: Number(userId) });
    if (!r?.ok) return { ok: false };
    return { ok: true, status: r.result?.status };
  } catch { return { ok: false }; }
}
export async function isMember(userId, chat) {
  let r = await memberStatus(userId, chat);
  if (!r.ok) { await new Promise((x) => setTimeout(x, 500)); r = await memberStatus(userId, chat); } // one retry
  if (!r.ok) return false;                                                                           // fail closed
  return ['member', 'administrator', 'creator'].includes(r.status);
}

// Is OUR bot an admin of this channel/group? Checked before an API task is created (nobody pays for a task that can never be verified).
let __botId = null;
async function getBotId() {
  if (__botId) return __botId;
  try { const r = await tgApi('getMe', {}); if (r?.ok) __botId = r.result.id; } catch { /* ignore */ }
  return __botId;
}
export async function checkBotAdmin(chat) {
  const botId = await getBotId();
  if (!botId) return { ok: false, error: 'server_error' };
  let r;
  try { r = await tgApi('getChatMember', { chat_id: chat, user_id: botId }); } catch { return { ok: false, error: 'server_error' }; }
  if (!r?.ok || !['administrator', 'creator'].includes(r.result?.status)) return { ok: false, error: 'bot_not_admin' };
  let title = null;
  try { const c = await tgApi('getChat', { chat_id: chat }); if (c?.ok) title = c.result?.title || null; } catch { /* ignore */ }
  return { ok: true, title };
}
