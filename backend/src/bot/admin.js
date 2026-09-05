import { sendMessage, inlineKeyboard, answerCallback } from '../telegram.js';
import { getSession, setSession, clearSession, upsertPackage, listPackages, upsertDiscount, logAudit } from '../db.js';
import { setWorkerSecret, testRazorpayCredentials } from '../razorpay.js';
import { randomGuideCode } from '../auth.js';
import { confirmBookingAndAssign } from '../booking.js';

export function mainMenu() {
  return inlineKeyboard([
    [{ text: '🌐 Website', callback_data: 'menu:website' }, { text: '📦 Packages', callback_data: 'menu:packages' }],
    [{ text: '🏷️ Discounts', callback_data: 'menu:discounts' }, { text: '💳 Payments', callback_data: 'menu:payments' }],
    [{ text: '👥 Guides', callback_data: 'menu:guides' }, { text: '📅 Bookings', callback_data: 'menu:bookings' }],
    [{ text: '📊 Analytics', callback_data: 'menu:analytics' }, { text: '⚙️ Settings', callback_data: 'menu:settings' }],
  ]);
}

function paymentMenu() {
  return inlineKeyboard([
    [{ text: '🔑 Configure Razorpay', callback_data: 'pay:configure' }],
    [{ text: '🧪 Re-test Gateway', callback_data: 'pay:retest' }],
    [{ text: '🔗 Webhook Status', callback_data: 'pay:webhook_status' }],
    [{ text: '💰 Payment History', callback_data: 'pay:history' }, { text: '📊 Payment Summary', callback_data: 'pay:summary' }],
    [{ text: '⬅️ Back', callback_data: 'menu:root' }],
  ]);
}

export async function handleAdminMessage(env, db, chatId, text) {
  const session = await getSession(db, chatId);

  if (session && session.flow === 'configure_razorpay') {
    return continueConfigureRazorpay(env, db, chatId, text, session);
  }
  if (session && session.flow === 'add_package') {
    return continueAddPackage(env, db, chatId, text, session);
  }
  if (session && session.flow === 'add_discount') {
    return continueAddDiscount(env, db, chatId, text, session);
  }

  if (text === '/start' || text === '/menu') {
    await clearSession(db, chatId);
    return sendMessage(env, chatId, '👋 <b>Krem Chympe Admin</b>\nChoose a section:', { keyboard: mainMenu() });
  }

  return sendMessage(env, chatId, "Use /menu to open the admin panel, or tap a button on a previous message.");
}

export async function handleAdminCallback(env, db, chatId, data, callbackQueryId, messageId) {
  await answerCallback(env, callbackQueryId, '');

  // ---- Manual-mode booking approval (Mode 1) ----
  if (data.startsWith('bk:confirm:') || data.startsWith('bk:reject:')) {
    return handleManualBookingDecision(env, db, chatId, data);
  }

  if (data === 'menu:root') {
    return sendMessage(env, chatId, 'Main menu:', { keyboard: mainMenu() });
  }

  if (data === 'menu:payments') {
    const s = await db.prepare('SELECT * FROM payment_settings WHERE id = 1').first();
    const status = s.configured && s.gateway_verified
      ? `🟢 <b>GATEWAY MODE ACTIVE</b> (${s.mode}, key …${s.key_id_last4})`
      : s.configured && !s.gateway_verified
        ? `🟡 <b>MANUAL MODE</b> — Razorpay configured but not currently verified${s.last_failure_reason ? `\nLast issue: ${s.last_failure_reason}` : ''}`
        : `⚪ <b>MANUAL MODE</b> — Razorpay not configured yet`;
    return sendMessage(env, chatId, `💳 <b>Payment Settings</b>\n${status}`, { keyboard: paymentMenu() });
  }

  if (data === 'pay:configure') {
    await setSession(db, chatId, 'configure_razorpay', 'awaiting_key_id', {});
    return sendMessage(env, chatId, '🔑 Send your <b>Razorpay Key ID</b> now (starts with rzp_test_ or rzp_live_).\n\nThis will be stored as an encrypted server secret — never shown again in chat.');
  }

  if (data === 'pay:retest') {
    const test = await testRazorpayCredentials(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET);
    if (test.ok) {
      await db.prepare("UPDATE payment_settings SET gateway_verified = 1, last_verified_at = datetime('now'), last_failure_reason = NULL, updated_at = datetime('now') WHERE id = 1").run();
      await logAudit(db, { actorChatId: chatId, action: 'payment.retest_ok', entity: 'payment_settings', entityId: 1 });
      return sendMessage(env, chatId, '✅ Gateway re-tested successfully. The website is showing the gateway payment page.');
    }
    await db.prepare("UPDATE payment_settings SET gateway_verified = 0, last_failure_reason = ?, updated_at = datetime('now') WHERE id = 1").bind(test.reason).run();
    await logAudit(db, { actorChatId: chatId, action: 'payment.retest_failed', entity: 'payment_settings', entityId: 1, after: { reason: test.reason } });
    return sendMessage(env, chatId, `❌ Gateway test failed: ${test.reason}\nThe website is showing manual payment mode until this is fixed.`);
  }

  if (data === 'pay:webhook_status') {
    const s = await db.prepare('SELECT * FROM payment_settings WHERE id = 1').first();
    return sendMessage(env, chatId, s.webhook_configured ? '🔗 Webhook: <b>configured</b> ✅' : '🔗 Webhook: <b>not configured</b> ❌\nSee README for the Razorpay dashboard webhook URL to add.');
  }

  if (data === 'pay:history' || data === 'pay:summary') {
    const rows = (await db.prepare('SELECT * FROM payments ORDER BY created_at DESC LIMIT 10').all()).results;
    const lines = rows.map((p) => `${p.status === 'payment.captured' ? '🟢' : p.status === 'payment.failed' ? '❌' : '•'} ₹${p.amount} — booking #${p.booking_id} (${p.status})`);
    return sendMessage(env, chatId, `💰 <b>Recent Payments</b>\n${lines.join('\n') || '(none yet)'}`, {
      keyboard: inlineKeyboard([[{ text: '⬅️ Back', callback_data: 'menu:payments' }]]),
    });
  }

  if (data === 'menu:packages') {
    const packages = await listPackages(db);
    const lines = packages.map((p) => `${p.active ? '🟢' : '⚪'}${p.highlighted ? ' ⭐' : ''} <b>${p.name}</b> — ₹${p.base_price} (id ${p.id})`);
    return sendMessage(env, chatId, `📦 <b>Packages</b>\n${lines.join('\n') || '(none yet)'}`, {
      keyboard: inlineKeyboard([
        [{ text: '➕ Add package', callback_data: 'pkg:add' }],
        [{ text: '⬅️ Back', callback_data: 'menu:root' }],
      ]),
    });
  }

  if (data === 'pkg:add') {
    await setSession(db, chatId, 'add_package', 'awaiting_name', {});
    return sendMessage(env, chatId, 'Send the new package <b>name</b>:');
  }

  if (data === 'menu:discounts') {
    return sendMessage(env, chatId, '🏷️ <b>Discounts</b>', {
      keyboard: inlineKeyboard([
        [{ text: '➕ Add discount', callback_data: 'disc:add' }],
        [{ text: '⬅️ Back', callback_data: 'menu:root' }],
      ]),
    });
  }

  if (data === 'disc:add') {
    await setSession(db, chatId, 'add_discount', 'awaiting_label', {});
    return sendMessage(env, chatId, 'Send a short <b>label</b> for this discount (e.g. "Monsoon 20% off"):');
  }

  if (data === 'menu:guides') {
    return sendMessage(env, chatId, '👥 <b>Guides</b>', {
      keyboard: inlineKeyboard([
        [{ text: '➕ Generate guide code', callback_data: 'guide:gen:all' }],
        [{ text: '⬅️ Back', callback_data: 'menu:root' }],
      ]),
    });
  }

  if (data === 'guide:gen:all') {
    const code = randomGuideCode();
    await db
      .prepare("INSERT INTO guide_codes (code, scope) VALUES (?, ?)")
      .bind(code, JSON.stringify({ all: true }))
      .run();
    await logAudit(db, { actorChatId: chatId, action: 'guide_code.generate', entity: 'guide_codes', entityId: code, after: { scope: 'all' } });
    return sendMessage(env, chatId, `✅ New guide code (all services): <code>${code}</code>\nGive this to the guide — they send it to this bot to activate their account.`);
  }

  if (data === 'menu:website' || data === 'menu:bookings' || data === 'menu:analytics' || data === 'menu:settings') {
    return sendMessage(env, chatId, 'This section is coming in the next build stage.', { keyboard: inlineKeyboard([[{ text: '⬅️ Back', callback_data: 'menu:root' }]]) });
  }

  return sendMessage(env, chatId, 'Unknown option.');
}

async function handleManualBookingDecision(env, db, chatId, data) {
  const [, action, idStr] = data.split(':');
  const bookingId = parseInt(idStr, 10);
  const booking = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(bookingId).first();

  if (!booking) return sendMessage(env, chatId, 'Booking not found.');
  if (booking.payment_status !== 'awaiting_verification') {
    return sendMessage(env, chatId, `This booking was already handled (current status: ${booking.payment_status}/${booking.booking_status}).`);
  }

  if (action === 'confirm') {
    await db
      .prepare("UPDATE bookings SET payment_status = 'verified', amount_paid_total = final_amount, updated_at = datetime('now') WHERE id = ?")
      .bind(bookingId)
      .run();
    await logAudit(db, { actorChatId: chatId, action: 'booking.manual_confirm', entity: 'bookings', entityId: bookingId });

    const updated = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(bookingId).first();
    const assignment = await confirmBookingAndAssign(env, db, updated);
    const guideNote = assignment.assigned
      ? `Assigned to guide: ${assignment.guide.name}.`
      : '⚠️ No eligible active guide — assign manually from 👥 Guides.';
    return sendMessage(env, chatId, `✅ Booking ${booking.booking_code} confirmed. ${guideNote}`);
  }

  // reject
  await db
    .prepare("UPDATE bookings SET payment_status = 'rejected', booking_status = 'rejected', updated_at = datetime('now') WHERE id = ?")
    .bind(bookingId)
    .run();
  await logAudit(db, { actorChatId: chatId, action: 'booking.manual_reject', entity: 'bookings', entityId: bookingId });
  return sendMessage(env, chatId, `❌ Booking ${booking.booking_code} rejected.`);
}

async function continueConfigureRazorpay(env, db, chatId, text, session) {
  if (session.step === 'awaiting_key_id') {
    await setSession(db, chatId, 'configure_razorpay', 'awaiting_key_secret', { keyId: text.trim() });
    return sendMessage(env, chatId, '🔑 Now send your <b>Razorpay Key Secret</b>.');
  }
  if (session.step === 'awaiting_key_secret') {
    await setSession(db, chatId, 'configure_razorpay', 'awaiting_webhook_secret', { ...session.data, keySecret: text.trim() });
    return sendMessage(env, chatId, '🔑 Finally, send your <b>Razorpay Webhook Secret</b> (from the Razorpay dashboard webhook config).');
  }
  if (session.step === 'awaiting_webhook_secret') {
    const { keyId, keySecret } = session.data;
    const webhookSecret = text.trim();

    await sendMessage(env, chatId, '🧪 Testing these credentials with Razorpay...');
    const test = await testRazorpayCredentials(keyId, keySecret);
    if (!test.ok) {
      await clearSession(db, chatId);
      await logAudit(db, { actorChatId: chatId, action: 'payment.configure_failed', entity: 'payment_settings', entityId: 1, after: { reason: test.reason } });
      return sendMessage(env, chatId, `❌ Razorpay rejected these credentials: ${test.reason}\n\nThe website will keep using manual payment mode. Start over with 💳 Payments → 🔑 Configure Razorpay when you have the correct keys.`);
    }

    const [ok1, ok2, ok3] = await Promise.all([
      setWorkerSecret(env, 'RAZORPAY_KEY_ID', keyId),
      setWorkerSecret(env, 'RAZORPAY_KEY_SECRET', keySecret),
      setWorkerSecret(env, 'RAZORPAY_WEBHOOK_SECRET', webhookSecret),
    ]);

    await clearSession(db, chatId);

    if (!ok1 || !ok2 || !ok3) {
      return sendMessage(env, chatId, '❌ Credentials were valid, but saving them to Cloudflare failed. Check CF_API_TOKEN permissions and try again. The website will keep using manual payment mode until this succeeds.');
    }

    const detectedMode = keyId.startsWith('rzp_live_') ? 'live' : 'test';
    await db
      .prepare(
        `UPDATE payment_settings SET
           configured = 1, gateway_verified = 1, webhook_configured = 1, mode = ?, key_id_last4 = ?,
           last_verified_at = datetime('now'), last_failure_reason = NULL, updated_at = datetime('now')
         WHERE id = 1`
      )
      .bind(detectedMode, keyId.slice(-4))
      .run();
    await logAudit(db, { actorChatId: chatId, action: 'payment.configured', entity: 'payment_settings', entityId: 1, after: { mode: detectedMode } });

    return sendMessage(env, chatId, `✅ Razorpay verified (${detectedMode} mode, key ending …${keyId.slice(-4)}).\n\n🟢 The website has automatically switched to gateway payments — visitors will now pay through Razorpay Checkout instead of the manual instructions.`);
  }
}

async function continueAddPackage(env, db, chatId, text, session) {
  if (session.step === 'awaiting_name') {
    await setSession(db, chatId, 'add_package', 'awaiting_price', { name: text.trim() });
    return sendMessage(env, chatId, `Send the base <b>price</b> for "${text.trim()}" (numbers only, e.g. 1499):`);
  }
  if (session.step === 'awaiting_price') {
    const price = parseFloat(text.replace(/[^0-9.]/g, ''));
    if (Number.isNaN(price)) return sendMessage(env, chatId, 'Please send a valid number for the price.');
    const id = await upsertPackage(db, { name: session.data.name, basePrice: price, active: 1 }, chatId);
    await clearSession(db, chatId);
    return sendMessage(env, chatId, `✅ Package <b>${session.data.name}</b> added at ₹${price} (id ${id}). It's now live on the website.`);
  }
}

async function continueAddDiscount(env, db, chatId, text, session) {
  if (session.step === 'awaiting_label') {
    await setSession(db, chatId, 'add_discount', 'awaiting_percent', { label: text.trim() });
    return sendMessage(env, chatId, 'Send the discount <b>percent</b> (e.g. 20):');
  }
  if (session.step === 'awaiting_percent') {
    const percent = parseFloat(text.replace(/[^0-9.]/g, ''));
    if (Number.isNaN(percent)) return sendMessage(env, chatId, 'Please send a valid number.');
    await setSession(db, chatId, 'add_discount', 'awaiting_scope', { ...session.data, percent });
    return sendMessage(env, chatId, 'Send the package id(s) this applies to, comma-separated (see 📦 Packages menu for ids):');
  }
  if (session.step === 'awaiting_scope') {
    const packageIds = text.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n));
    const id = await upsertDiscount(db, { label: session.data.label, percent: session.data.percent, appliesTo: { packages: packageIds, services: [] }, active: 1 }, chatId);
    await clearSession(db, chatId);
    return sendMessage(env, chatId, `✅ Discount "${session.data.label}" (${session.data.percent}%) added for packages [${packageIds.join(', ')}] (id ${id}).`);
  }
}
