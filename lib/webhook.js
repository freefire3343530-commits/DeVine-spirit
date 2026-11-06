// FILE PATH: lib/webhook.js
// Telegram webhook helpers: secret-token check (incoming) + setWebhook / getWebhookInfo / deleteWebhook (outgoing).
//
// ENV needed (Render):
//   BOT_TOKEN        – already set
//   WEBHOOK_SECRET   – NEW. Random string, only A-Z a-z 0-9 _ -  (1-256 chars). e.g.  openssl rand -hex 32
//   PUBLIC_URL       – NEW. Your server's public https URL, no trailing slash. e.g. https://devine-spirit.onrender.com
//   CRON_SECRET      – already set (protects the /api/cron setup jobs)
import crypto from 'crypto';
import { tgApi } from './tg.js';

const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Telegram sends our secret in the header X-Telegram-Bot-Api-Secret-Token on every update.
// Fail-closed: if WEBHOOK_SECRET is not set, every request is rejected (otherwise anyone could fake an admin tap).
export function isTelegramRequest(req) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return false;
  return safeEq(req.headers?.['x-telegram-bot-api-secret-token'] || '', secret);
}

export const webhookUrl = () => `${String(process.env.PUBLIC_URL || '').replace(/\/+$/, '')}/api/bot`;

export async function setBotWebhook({ dropPending = false } = {}) {
  if (!process.env.BOT_TOKEN) return { ok: false, error: 'BOT_TOKEN is not set' };
  if (!process.env.WEBHOOK_SECRET || !/^[A-Za-z0-9_-]{1,256}$/.test(process.env.WEBHOOK_SECRET))
    return { ok: false, error: 'WEBHOOK_SECRET missing or invalid (use only A-Z a-z 0-9 _ -)' };
  if (!/^https:\/\//.test(process.env.PUBLIC_URL || '')) return { ok: false, error: 'PUBLIC_URL must start with https://' };
  return tgApi('setWebhook', {
    url: webhookUrl(),
    secret_token: process.env.WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],   // the bot only handles these two
    max_connections: 40,
    drop_pending_updates: dropPending,
  });
}

export const getBotWebhookInfo = () => tgApi('getWebhookInfo', {});
export const deleteBotWebhook = (dropPending = false) => tgApi('deleteWebhook', { drop_pending_updates: dropPending });
