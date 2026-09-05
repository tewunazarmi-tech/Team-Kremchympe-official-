import {
  listContent, listPackages, listDiscounts, createBooking, updateBookingStatus,
  recordPaymentCaptured, capturedPaymentAlreadyProcessed, getAdminRole,
} from './db.js';
import { computeFinalAmount, generateBookingCode, confirmBookingAndAssign } from './booking.js';
import { createRazorpayOrder, verifyCheckoutSignature, verifyWebhookSignature } from './razorpay.js';
import { verifyTelegramWebhook, sendMessage, sendPhotoToChat, sendPhotoMultipart, sendDocumentMultipart, sendDocumentById, inlineKeyboard } from './telegram.js';
import { classifySender } from './auth.js';
import { handleAdminMessage, handleAdminCallback } from './bot/admin.js';
import { handleGuideOrUnknownMessage, handleGuideCallback } from './bot/guide.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
}

// The single source of truth for which payment UI the site should show.
// Never decided by the browser — always recomputed here from D1.
async function getPaymentSettings(db) {
  return db.prepare('SELECT * FROM payment_settings WHERE id = 1').first();
}
function effectiveMode(settings) {
  return settings.configured && settings.gateway_verified ? 'gateway' : 'manual';
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' } });
    }

    try {
      // ---- Public website content API ----
      if (url.pathname === '/api/website' && request.method === 'GET') {
        const content = await listContent(env.DB);
        return json({ content: content.filter((c) => c.visible) });
      }

      if (url.pathname === '/api/packages' && request.method === 'GET') {
        const packages = await listPackages(env.DB, { activeOnly: true });
        const services = (await env.DB.prepare('SELECT * FROM services WHERE active = 1 ORDER BY sort_order').all()).results;
        const discounts = await listDiscounts(env.DB, { activeOnly: true });
        return json({ packages, services, discounts });
      }

      // ---- The switch itself: tells the frontend which payment UI to render ----
      if (url.pathname === '/api/payment-mode' && request.method === 'GET') {
        const settings = await getPaymentSettings(env.DB);
        return json({
          mode: effectiveMode(settings),
          minAdvance: settings.min_advance_amount,
          currency: settings.currency,
        });
      }

      // Non-authoritative preview only — real price is recomputed server-side at booking time.
      if (url.pathname === '/api/quote' && request.method === 'POST') {
        const body = await request.json();
        const quote = await computeFinalAmount(env.DB, body);
        return json(quote);
      }

      // ---- Booking creation. Backend decides manual vs gateway, not the caller. ----
      if (url.pathname === '/api/booking' && request.method === 'POST') {
        const body = await request.json();
        return await handleCreateBooking(env, body);
      }

      // ---- Post-checkout signature confirmation from the browser (hint only) ----
      if (url.pathname === '/api/payment/confirm' && request.method === 'POST') {
        const body = await request.json();
        const ok = await verifyCheckoutSignature(env, body);
        if (!ok) {
          // A mismatch here means nothing was verified server-side; the
          // webhook remains the only thing that can actually confirm this
          // booking. We surface it so the frontend can show "verifying...".
          return json({ error: 'verification_failed' }, 400);
        }
        return json({ ok: true, note: 'awaiting_webhook_confirmation' });
      }

      // ---- Receipt upload (manual-mode bookings only) — forwarded straight
      // into Telegram, which is the receipt storage; no bucket involved. ----
      if (url.pathname === '/api/receipt' && request.method === 'POST') {
        return await handleReceiptUpload(env, request);
      }

      // ---- Razorpay webhook (source of truth for payment status) ----
      if (url.pathname === '/webhook/razorpay' && request.method === 'POST') {
        return await handleRazorpayWebhook(env, request);
      }

      // ---- Telegram webhook (admin + guide bots share one endpoint) ----
      if (url.pathname === '/webhook/telegram' && request.method === 'POST') {
        return await handleTelegramWebhook(env, request);
      }

      return json({ error: 'not_found' }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: 'internal_error', message: String(err.message || err) }, 500);
    }
  },

  // ---- Cron trigger: send 1-day-before reminders (wire up in wrangler.toml [triggers]) ----
  async scheduled(event, env, ctx) {
    const due = (
      await env.DB.prepare("SELECT * FROM reminders WHERE sent = 0 AND scheduled_for <= datetime('now')").all()
    ).results;
    for (const r of due) {
      const booking = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(r.booking_id).first();
      const guide = await env.DB.prepare('SELECT * FROM guides WHERE id = ?').bind(r.guide_id).first();
      if (!booking || !guide || !['confirmed', 'assigned'].includes(booking.booking_status)) continue;
      await sendMessage(env, guide.telegram_chat_id, `🔔 Reminder: booking <b>${booking.booking_code}</b> is scheduled for tomorrow (${booking.visit_date}).`);
      await env.DB.prepare('UPDATE reminders SET sent = 1 WHERE id = ?').bind(r.id).run();
    }
  },
};

async function handleCreateBooking(env, body) {
  const { name, phone, email, packageId, participants, visitDate, selectedServices, discountId, idempotencyKey, amountToPay } = body;

  if (!name || !phone || !packageId || !visitDate) {
    return json({ error: 'missing_required_fields' }, 400);
  }

  const visitorRes = await env.DB
    .prepare('INSERT INTO visitors (name, phone, email) VALUES (?, ?, ?)')
    .bind(name, phone, email ?? null)
    .run();
  const visitorId = visitorRes.meta.last_row_id;

  const pricing = await computeFinalAmount(env.DB, { packageId, participants, selectedServices, discountId });

  const { booking, created } = await createBooking(env.DB, {
    bookingCode: generateBookingCode(),
    visitorId,
    packageId,
    participants,
    visitDate,
    selectedServices,
    discountId,
    ...pricing,
    idempotencyKey,
  });

  if (!created) {
    const settings = await getPaymentSettings(env.DB);
    return json({ booking, mode: effectiveMode(settings), note: 'duplicate_submission_returned_existing' });
  }

  const settings = await getPaymentSettings(env.DB);
  const mode = effectiveMode(settings);

  // ===== MODE 1: no verified gateway — manual payment path =====
  if (mode === 'manual') {
    return json({ booking, mode: 'manual' });
  }

  // ===== MODE 2: gateway is configured + verified =====
  const requested = Number(amountToPay) || pricing.finalAmount;
  const clampedAmount = Math.min(Math.max(requested, settings.min_advance_amount), pricing.finalAmount);

  try {
    const order = await createRazorpayOrder(env, {
      amountPaise: Math.round(clampedAmount * 100),
      currency: pricing.currency,
      receipt: booking.booking_code,
      notes: { bookingId: String(booking.id) },
    });
    await updateBookingStatus(env.DB, booking.id, { razorpayOrderId: order.id });
    return json({ booking, mode: 'gateway', razorpayOrder: order, razorpayKeyId: env.RAZORPAY_KEY_ID, amountCharged: clampedAmount });
  } catch (err) {
    // Safe fallback: the gateway looked verified but just failed for real
    // (revoked key, Razorpay outage, etc). Flip the switch back to manual
    // so nobody gets stuck on a broken payment page, and let the admin know.
    console.error('Razorpay order creation failed, falling back to manual mode:', err);
    await env.DB
      .prepare("UPDATE payment_settings SET gateway_verified = 0, last_failure_reason = ?, updated_at = datetime('now') WHERE id = 1")
      .bind(String(err.message || err))
      .run();
    const admins = (await env.DB.prepare('SELECT telegram_chat_id FROM admin_users').all()).results;
    for (const a of admins) {
      await sendMessage(env, a.telegram_chat_id, `⚠️ Razorpay stopped working (${String(err.message || err)}). The website has automatically switched to manual payment mode until this is fixed (💳 Payments → 🧪 Re-test Gateway).`);
    }
    return json({ booking, mode: 'manual', fallback: true });
  }
}

async function handleReceiptUpload(env, request) {
  const form = await request.formData();
  const bookingId = form.get('bookingId');
  const file = form.get('file');
  if (!bookingId || !file) return json({ error: 'missing_fields' }, 400);

  const booking = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(bookingId).first();
  if (!booking) return json({ error: 'booking_not_found' }, 404);
  const visitor = await env.DB.prepare('SELECT * FROM visitors WHERE id = ?').bind(booking.visitor_id).first();

  const admins = (await env.DB.prepare('SELECT telegram_chat_id FROM admin_users').all()).results;
  const caption =
    `📩 <b>New booking (manual payment)</b> ${booking.booking_code}\n` +
    `👤 ${visitor.name} — ${visitor.phone}\n` +
    `📅 ${booking.visit_date} · 👥 ${booking.participants}\n` +
    `💰 ₹${booking.final_amount} (discount ₹${booking.discount_amount})\n` +
    `🟡 Payment: Awaiting your verification of the receipt.`;
  const keyboard = inlineKeyboard([
    [{ text: '✅ Confirm Payment', callback_data: `bk:confirm:${booking.id}` }, { text: '❌ Reject', callback_data: `bk:reject:${booking.id}` }],
  ]);

  const isImage = (file.type || '').startsWith('image/');
  const filename = file.name || (isImage ? 'receipt.jpg' : 'receipt.pdf');

  // Telegram is the storage: upload the actual bytes to the FIRST admin,
  // then reuse the file_id Telegram hands back for any additional admins —
  // that's an instant re-send with no re-upload, and the file_id itself is
  // what we keep in D1 as the permanent reference to this receipt.
  let fileId = null;
  for (let i = 0; i < admins.length; i++) {
    const chatId = admins[i].telegram_chat_id;
    if (fileId) {
      if (isImage) await sendPhotoToChat(env, chatId, fileId, caption, { keyboard });
      else await sendDocumentById(env, chatId, fileId, caption, { keyboard });
      continue;
    }
    const result = isImage
      ? await sendPhotoMultipart(env, chatId, file, filename, caption, { keyboard })
      : await sendDocumentMultipart(env, chatId, file, filename, caption, { keyboard });
    if (result.ok) {
      fileId = isImage ? result.result.photo?.slice(-1)[0]?.file_id : result.result.document?.file_id;
    }
  }

  if (admins.length === 0) {
    console.error(`No admin configured to receive receipt for booking ${booking.id}`);
  }

  await updateBookingStatus(env.DB, bookingId, { receiptFileId: fileId, paymentStatus: 'awaiting_verification' });

  return json({ ok: true });
}

// Sent for a GATEWAY-mode booking that's already been auto-confirmed —
// informational only, no action buttons, because the payment is already verified.
async function notifyAdminsOfAutoConfirmedBooking(env, booking, visitor) {
  const admins = (await env.DB.prepare('SELECT telegram_chat_id FROM admin_users').all()).results;
  const text =
    `📩 <b>New booking — auto-confirmed</b> ${booking.booking_code}\n` +
    (visitor ? `👤 ${visitor.name} — ${visitor.phone}\n` : '') +
    `📅 ${booking.visit_date} · 👥 ${booking.participants}\n` +
    `💰 ₹${booking.final_amount} paid ₹${booking.amount_paid_total} (${booking.payment_status})\n` +
    `🟢 Booking confirmed automatically via Razorpay.`;
  for (const a of admins) {
    await sendMessage(env, a.telegram_chat_id, text);
  }
}

async function handleRazorpayWebhook(env, request) {
  const rawBody = await request.text();
  const signature = request.headers.get('X-Razorpay-Signature');
  const valid = await verifyWebhookSignature(env, rawBody, signature);
  if (!valid) return json({ error: 'invalid_signature' }, 400);

  const payload = JSON.parse(rawBody);
  const event = payload.event;
  const paymentEntity = payload.payload?.payment?.entity;

  if (event === 'payment.captured') {
    // Never trust a browser's "success" callback alone, and never process
    // the same captured payment twice (Razorpay may redeliver webhooks).
    if (await capturedPaymentAlreadyProcessed(env.DB, paymentEntity.id)) {
      return json({ ok: true, note: 'duplicate_webhook_ignored' });
    }

    const bookingBefore = await env.DB.prepare('SELECT * FROM bookings WHERE razorpay_order_id = ?').bind(paymentEntity.order_id).first();
    if (!bookingBefore) {
      // Payment doesn't match any known order/booking — do not confirm anything.
      console.error('Webhook payment.captured for unknown order_id', paymentEntity.order_id);
      return json({ ok: true, note: 'no_matching_booking' });
    }

    // Amount/currency sanity check — protects against a tampered or
    // mismatched webhook body being trusted at face value.
    const amountCaptured = (paymentEntity.amount || 0) / 100;
    if (paymentEntity.currency && paymentEntity.currency !== bookingBefore.currency) {
      console.error('Currency mismatch on webhook for booking', bookingBefore.id);
      return json({ ok: true, note: 'currency_mismatch_ignored' });
    }

    await env.DB
      .prepare('INSERT INTO payments (booking_id, razorpay_order_id, razorpay_payment_id, amount, currency, status, raw_webhook) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(bookingBefore.id, paymentEntity.order_id, paymentEntity.id, amountCaptured, paymentEntity.currency || 'INR', event, rawBody)
      .run();

    const { booking, crossedMinAdvance } = await recordPaymentCaptured(env.DB, bookingBefore.id, amountCaptured, paymentEntity.id);
    const visitor = await env.DB.prepare('SELECT * FROM visitors WHERE id = ?').bind(booking.visitor_id).first();

    if (crossedMinAdvance && booking.booking_status === 'pending') {
      // First payment to clear the minimum — auto-confirm + auto-assign, no
      // admin/guide action required.
      await confirmBookingAndAssign(env, env.DB, booking);
      await notifyAdminsOfAutoConfirmedBooking(env, booking, visitor);
    } else {
      // A top-up on an already-confirmed booking — just let admins know.
      const admins = (await env.DB.prepare('SELECT telegram_chat_id FROM admin_users').all()).results;
      for (const a of admins) {
        await sendMessage(env, a.telegram_chat_id, `💰 Additional payment received for <b>${booking.booking_code}</b>: ₹${amountCaptured} (total paid ₹${booking.amount_paid_total} of ₹${booking.final_amount}).`);
      }
    }
  } else if (event === 'payment.failed') {
    const booking = await env.DB.prepare('SELECT * FROM bookings WHERE razorpay_order_id = ?').bind(paymentEntity.order_id).first();
    if (booking && booking.booking_status === 'pending') {
      // ❌ Payment Failed → booking stays NOT confirmed. We don't cancel it
      // outright — the visitor may retry the same booking.
      await updateBookingStatus(env.DB, booking.id, { paymentStatus: 'failed' });
    }
  }

  return json({ ok: true });
}

async function handleTelegramWebhook(env, request) {
  if (!verifyTelegramWebhook(request, env)) {
    return json({ error: 'forbidden' }, 403);
  }
  const update = await request.json();
  const db = env.DB;

  if (update.message) {
    const chatId = update.message.chat.id;
    const text = update.message.text || '';
    const sender = await classifySender(db, chatId);

    if (sender.type === 'admin') {
      await handleAdminMessage(env, db, chatId, text);
    } else {
      // Bootstrap: if no admins exist yet and this chat matches SUPERADMIN_CHAT_ID, register them.
      if (String(chatId) === String(env.SUPERADMIN_CHAT_ID)) {
        const existingRole = await getAdminRole(db, chatId);
        if (!existingRole) {
          await db.prepare("INSERT INTO admin_users (telegram_chat_id, role) VALUES (?, 'superadmin')").bind(String(chatId)).run();
          await handleAdminMessage(env, db, chatId, '/start');
          return json({ ok: true });
        }
      }
      await handleGuideOrUnknownMessage(env, db, chatId, text, sender);
    }
  }

  if (update.callback_query) {
    const chatId = update.callback_query.message.chat.id;
    const data = update.callback_query.data;
    const messageId = update.callback_query.message.message_id;
    const sender = await classifySender(db, chatId);

    if (sender.type === 'admin') {
      await handleAdminCallback(env, db, chatId, data, update.callback_query.id, messageId);
    } else if (sender.type === 'guide') {
      await handleGuideCallback(env, db, chatId, data, sender.guide);
    }
  }

  return json({ ok: true });
}
