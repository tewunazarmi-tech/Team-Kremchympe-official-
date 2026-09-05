const API = (token) => `https://api.telegram.org/bot${token}`;

export async function tgCall(env, method, payload) {
  const res = await fetch(`${API(env.TELEGRAM_BOT_TOKEN)}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error('Telegram API error', method, data);
  }
  return data;
}

export function sendMessage(env, chatId, text, opts = {}) {
  return tgCall(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: opts.keyboard,
  });
}

export function editMessage(env, chatId, messageId, text, opts = {}) {
  return tgCall(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    reply_markup: opts.keyboard,
  });
}

export function answerCallback(env, callbackQueryId, text) {
  return tgCall(env, 'answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}

export async function sendPhotoToChat(env, chatId, fileIdOrUrl, caption, opts = {}) {
  return tgCall(env, 'sendPhoto', { chat_id: chatId, photo: fileIdOrUrl, caption, parse_mode: 'HTML', reply_markup: opts.keyboard });
}

export function inlineKeyboard(rows) {
  // rows: [[{text, callback_data}], ...]
  return { inline_keyboard: rows };
}

// Verifies that an incoming HTTP request genuinely came from Telegram, using
// the secret token Telegram echoes back in a header (set via setWebhook's
// secret_token param). This stops anyone from POSTing fake "bookings" or
// admin commands straight at the webhook URL.
export function verifyTelegramWebhook(request, env) {
  const header = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  return header && env.TELEGRAM_WEBHOOK_SECRET && header === env.TELEGRAM_WEBHOOK_SECRET;
}
