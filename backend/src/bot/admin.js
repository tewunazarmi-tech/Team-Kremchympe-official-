import { sendMessage, inlineKeyboard, answerCallback, sendPhotoToChat, sendDocumentById } from '../telegram.js';
import {
  getSession, setSession, clearSession, upsertPackage, listPackages, upsertDiscount, logAudit,
  listBookingsByFilter, searchBookings, getBookingFull, getBookingByCode, cancelBooking, recordRefund, editBookingField,
  setBookingGuide, listActiveEligibleGuides,
  listGuides, searchGuides, getGuide, createGuideProfile, setGuideStatus, removeGuideAccess, resetGuideAccount,
  generateGuideCodeFor, getGuideWorkload, listBookingsForGuide,
  listDiscountsGrouped, getDiscount, editDiscountField, removeDiscount, getDiscountUsageReport,
  editPackageField, archivePackage, resetPackageConfig,
  listContent, upsertContent, getSiteSettings, setSiteEnabled, setMinAdvanceAmount,
  getDashboardStats, getRevenueAnalytics, getPackagePerformance, getGuidePerformance, getPaymentAnalytics,
} from '../db.js';
import { setWorkerSecret, testRazorpayCredentials, createRazorpayRefund } from '../razorpay.js';
import { randomGuideCode } from '../auth.js';
import { confirmBookingAndAssign, notifyGuideOfAssignment } from '../booking.js';

export function mainMenu() {
  return inlineKeyboard([
    [{ text: '🌐 Website', callback_data: 'menu:website' }, { text: '📦 Packages', callback_data: 'menu:packages' }],
    [{ text: '🏷️ Discounts', callback_data: 'menu:discounts' }, { text: '💳 Payments', callback_data: 'menu:payments' }],
    [{ text: '👥 Guides', callback_data: 'menu:guides' }, { text: '📅 Bookings', callback_data: 'menu:bookings' }],
    [{ text: '📊 Dashboard', callback_data: 'menu:dashboard' }, { text: '⚙️ Settings', callback_data: 'menu:settings' }],
  ]);
}

function back(to = 'menu:root') {
  return [{ text: '⬅️ Back', callback_data: to }];
}

function paymentStatusBadge(s) {
  return { pending: '🟡', awaiting_verification: '🟡', partial: '🟡', verified: '🟢', failed: '❌', rejected: '❌', refunded: '↩️' }[s] || '⚪';
}
function bookingStatusBadge(s) {
  return {
    pending: '🟡', confirmed: '🔵', guide_required: '🟠', assigned: '🔵', guide_accepted: '🟢',
    in_progress: '🚶', completed: '🏁', cancelled: '❌', rejected: '❌',
  }[s] || '⚪';
}

function paymentMenu() {
  return inlineKeyboard([
    [{ text: '🔑 Configure Razorpay', callback_data: 'pay:configure' }],
    [{ text: '🧪 Re-test Gateway', callback_data: 'pay:retest' }],
    [{ text: '🔗 Webhook Status', callback_data: 'pay:webhook_status' }],
    [{ text: '💰 Payment History', callback_data: 'pay:history' }, { text: '📊 Payment Summary', callback_data: 'pay:summary' }],
    back(),
  ]);
}

// =====================================================================
// MESSAGE (free-text) HANDLER — multi-step session flows
// =====================================================================

export async function handleAdminMessage(env, db, chatId, text) {
  const session = await getSession(db, chatId);

  if (session) {
    const handler = TEXT_FLOWS[session.flow];
    if (handler) return handler(env, db, chatId, text, session);
  }

  if (text === '/start' || text === '/menu') {
    await clearSession(db, chatId);
    return sendMessage(env, chatId, '👋 <b>Krem Chympe Admin</b>\nChoose a section:', { keyboard: mainMenu() });
  }

  // Free-text that isn't a command or an active flow: treat it as a
  // pasted booking code (e.g. copied from a visitor's "no response yet"
  // WhatsApp message) and look it up directly — no need to open /menu
  // first. Tells the admin which guide has it and re-sends the receipt
  // so they can verify without digging through the Bookings menu.
  if (await handleBookingCodeLookup(env, db, chatId, text)) return;

  return sendMessage(env, chatId, "Use /menu to open the admin panel, or tap a button on a previous message.");
}

// =====================================================================
// Booking-code lookup — triggered by any free-text message that isn't a
// command or mid-flow input (see handleAdminMessage above). Matches the
// exact booking code first (case-insensitive, since it's often pasted
// from a chat), then falls back to the same fuzzy search the 🔎 Bookings
// search uses (name/phone/partial code) in case of a typo or partial code.
// =====================================================================

async function handleBookingCodeLookup(env, db, chatId, rawText) {
  const term = rawText.trim();
  if (!term || term.length < 3) return false;

  let booking = await getBookingByCode(db, term.toUpperCase());
  let matches = booking ? [booking] : await searchBookings(db, term, { limit: 5 });
  if (!booking && matches.length === 1) booking = matches[0];

  if (!booking) {
    if (matches.length > 1) {
      const buttons = matches.map((b) => [
        { text: `${bookingStatusBadge(b.booking_status)} ${b.booking_code} — ${b.visitor_name}`, callback_data: `bkv:${b.id}` },
      ]);
      await sendMessage(env, chatId, `🔎 Found ${matches.length} bookings matching "${term}" — which one?`, {
        keyboard: inlineKeyboard([...buttons, back('menu:bookings')]),
      });
      return true;
    }
    return false; // no match at all — let the caller show the generic help text
  }

  await sendBookingCodeLookupResult(env, db, chatId, booking);
  return true;
}

async function sendBookingCodeLookupResult(env, db, chatId, b) {
  const cancellable = !['cancelled', 'rejected', 'completed'].includes(b.booking_status);
  await sendMessage(env, chatId, `🔑 <b>Booking code match</b>\n\n${bookingDetailText(b)}`, {
    keyboard: inlineKeyboard(
      [
        [{ text: b.guide_id ? '🔄 Reassign Guide' : '👥 Assign Guide', callback_data: `bka:${b.id}` }],
        [{ text: '✏️ Edit', callback_data: `bke:${b.id}` }],
        cancellable ? [{ text: '❌ Cancel', callback_data: `bkc:${b.id}` }] : [],
        b.amount_paid_total > 0 ? [{ text: '↩️ Refund', callback_data: `bkf:${b.id}` }] : [],
        back('menu:bookings'),
      ].filter((r) => r.length)
    ),
  });

  if (!b.receipt_file_id) {
    return sendMessage(env, chatId, 'ℹ️ No receipt on file for this booking (gateway payment, or nothing uploaded yet).');
  }

  const caption = `🧾 Receipt for ${b.booking_code} — verify before confirming.`;
  if (b.receipt_is_image === 0) {
    return sendDocumentById(env, chatId, b.receipt_file_id, caption);
  }
  const result = await sendPhotoToChat(env, chatId, b.receipt_file_id, caption);
  if (!result.ok) {
    // Legacy row with unknown/mismatched type — one fallback attempt as a document.
    await sendDocumentById(env, chatId, b.receipt_file_id, caption);
  }
}

const TEXT_FLOWS = {
  configure_razorpay: continueConfigureRazorpay,
  add_package: continueAddPackage,
  add_discount: continueAddDiscount,
  add_guide: continueAddGuide,
  edit_package_field: continueEditPackageField,
  edit_discount_field: continueEditDiscountField,
  edit_booking_field: continueEditBookingField,
  edit_guide_field: continueEditGuideField,
  cancel_booking: continueCancelBooking,
  refund_booking: continueRefundBooking,
  search_bookings: continueSearchBookings,
  search_guides: continueSearchGuides,
  guide_decline_reason: continueGuideDeclineReason,
  edit_website_key: continueEditWebsiteKey,
  add_website_field: continueAddWebsiteField,
  set_min_advance: continueSetMinAdvance,
};

// =====================================================================
// CALLBACK (button) HANDLER
// =====================================================================

export async function handleAdminCallback(env, db, chatId, data, callbackQueryId, messageId) {
  await answerCallback(env, callbackQueryId, '');

  // ---- Manual-mode booking approval (Mode 1) ----
  if (data.startsWith('bk:confirm:') || data.startsWith('bk:reject:')) {
    return handleManualBookingDecision(env, db, chatId, data);
  }

  if (data === 'menu:root') return sendMessage(env, chatId, 'Main menu:', { keyboard: mainMenu() });

  // ---- Dashboard / Analytics ----
  if (data === 'menu:dashboard') return showDashboard(env, db, chatId);
  if (data === 'dash:revenue') return showRevenueAnalytics(env, db, chatId);
  if (data === 'dash:packages') return showPackagePerformance(env, db, chatId);
  if (data === 'dash:guides') return showGuidePerformance(env, db, chatId);
  if (data === 'dash:payments') return showPaymentAnalytics(env, db, chatId);
  if (data === 'dash:discounts') return showDiscountUsage(env, db, chatId);

  // ---- Payments (existing) ----
  if (data === 'menu:payments') return showPaymentsMenu(env, db, chatId);
  if (data === 'pay:configure') {
    await setSession(db, chatId, 'configure_razorpay', 'awaiting_key_id', {});
    return sendMessage(env, chatId, '🔑 Send your <b>Razorpay Key ID</b> now (starts with rzp_test_ or rzp_live_).\n\nThis will be stored as an encrypted server secret — never shown again in chat.');
  }
  if (data === 'pay:retest') return retestGateway(env, db, chatId);
  if (data === 'pay:webhook_status') {
    const s = await db.prepare('SELECT * FROM payment_settings WHERE id = 1').first();
    return sendMessage(env, chatId, s.webhook_configured ? '🔗 Webhook: <b>configured</b> ✅' : '🔗 Webhook: <b>not configured</b> ❌\nSee README for the Razorpay dashboard webhook URL to add.');
  }
  if (data === 'pay:history' || data === 'pay:summary') {
    const rows = (await db.prepare('SELECT * FROM payments ORDER BY created_at DESC LIMIT 10').all()).results;
    const lines = rows.map((p) => `${p.status === 'payment.captured' ? '🟢' : p.status === 'payment.failed' ? '❌' : '•'} ₹${p.amount} — booking #${p.booking_id} (${p.status})`);
    return sendMessage(env, chatId, `💰 <b>Recent Payments</b>\n${lines.join('\n') || '(none yet)'}`, { keyboard: inlineKeyboard([back('menu:payments')]) });
  }

  // ---- Bookings ----
  if (data === 'menu:bookings') return showBookingsMenu(env, chatId);
  if (data.startsWith('bkl:')) return showBookingList(env, db, chatId, data.split(':')[1]);
  if (data === 'bks') {
    await setSession(db, chatId, 'search_bookings', 'awaiting_term', {});
    return sendMessage(env, chatId, '🔎 Send a booking code, customer name, or phone number to search:');
  }
  if (data.startsWith('bkv:')) return showBookingDetail(env, db, chatId, parseInt(data.split(':')[1], 10));
  if (data.startsWith('bka:')) return showAssignGuideOptions(env, db, chatId, parseInt(data.split(':')[1], 10));
  if (data.startsWith('bkag:')) {
    const [, idStr, gidStr] = data.split(':');
    return doAssignGuide(env, db, chatId, parseInt(idStr, 10), parseInt(gidStr, 10));
  }
  if (data.startsWith('bkc:')) {
    const id = parseInt(data.split(':')[1], 10);
    await setSession(db, chatId, 'cancel_booking', 'awaiting_reason', { id });
    return sendMessage(env, chatId, '❌ Send a reason for cancelling this booking (or "-" for none):');
  }
  if (data.startsWith('bkf:')) {
    const id = parseInt(data.split(':')[1], 10);
    const booking = await getBookingFull(db, id);
    await setSession(db, chatId, 'refund_booking', 'awaiting_amount', { id });
    return sendMessage(env, chatId, `↩️ Send the refund amount (max ₹${booking.amount_paid_total}), or "full" for the full paid amount:`);
  }
  if (data.startsWith('bke:')) return showEditBookingFields(env, chatId, parseInt(data.split(':')[1], 10));
  if (data.startsWith('bkef:')) {
    const [, idStr, field] = data.split(':');
    await setSession(db, chatId, 'edit_booking_field', 'awaiting_value', { id: parseInt(idStr, 10), field });
    return sendMessage(env, chatId, `Send the new value for <b>${field}</b>:`);
  }

  // ---- Guides ----
  if (data === 'menu:guides') return showGuidesMenu(env, chatId);
  if (data === 'guide:list') return showGuideList(env, db, chatId);
  if (data === 'guide:search') {
    await setSession(db, chatId, 'search_guides', 'awaiting_term', {});
    return sendMessage(env, chatId, '🔎 Send the guide name or phone number to search:');
  }
  if (data === 'guide:add') {
    await setSession(db, chatId, 'add_guide', 'awaiting_name', {});
    return sendMessage(env, chatId, '➕ Send the new guide\'s <b>name</b>:');
  }
  if (data === 'guide:gen:all') {
    const code = randomGuideCode();
    await generateGuideCodeFor(db, { code, scope: { all: true } });
    await logAudit(db, { actorChatId: chatId, action: 'guide_code.generate', entity: 'guide_codes', entityId: code, after: { scope: 'all' } });
    return sendMessage(env, chatId, `✅ New guide code (all services): <code>${code}</code>\nGive this to the guide — they send it to this bot to activate their account.`);
  }
  if (data.startsWith('gv:')) return showGuideDetail(env, db, chatId, parseInt(data.split(':')[1], 10));
  if (data.startsWith('genable:')) return toggleGuideStatus(env, db, chatId, parseInt(data.split(':')[1], 10), 'active');
  if (data.startsWith('gdisable:')) return toggleGuideStatus(env, db, chatId, parseInt(data.split(':')[1], 10), 'inactive');
  if (data.startsWith('gcode:')) {
    const id = parseInt(data.split(':')[1], 10);
    const guide = await getGuide(db, id);
    const code = randomGuideCode();
    await generateGuideCodeFor(db, { code, scope: JSON.parse(guide.eligible_scope), guideNameHint: guide.name });
    await logAudit(db, { actorChatId: chatId, action: 'guide_code.generate', entity: 'guides', entityId: id });
    return sendMessage(env, chatId, `✅ New code for <b>${guide.name}</b>: <code>${code}</code>`, { keyboard: inlineKeyboard([back(`gv:${id}`)]) });
  }
  if (data.startsWith('gbookings:')) return showGuideBookingsForAdmin(env, db, chatId, parseInt(data.split(':')[1], 10));
  if (data.startsWith('gedit:')) return showEditGuideFields(env, chatId, parseInt(data.split(':')[1], 10));
  if (data.startsWith('geditf:')) {
    const [, idStr, field] = data.split(':');
    await setSession(db, chatId, 'edit_guide_field', 'awaiting_value', { id: parseInt(idStr, 10), field });
    return sendMessage(env, chatId, `Send the new value for <b>${field}</b>:`);
  }
  if (data.startsWith('gremove:')) return showRemoveGuideOptions(env, db, chatId, parseInt(data.split(':')[1], 10));
  if (data.startsWith('gremove_opt:')) {
    const [, idStr, opt] = data.split(':');
    const id = parseInt(idStr, 10);
    if (opt === 'leave') {
      await removeGuideAccess(db, id, { actorChatId: chatId });
      return sendMessage(env, chatId, '✅ Guide removed. Their bookings are now unassigned and marked 🟠 Guide Required.', { keyboard: inlineKeyboard([back('guide:list')]) });
    }
    return showReassignTargetOptions(env, db, chatId, id);
  }
  if (data.startsWith('gremove_to:')) {
    const [, idStr, toIdStr] = data.split(':');
    await removeGuideAccess(db, parseInt(idStr, 10), { reassignBookingsToGuideId: parseInt(toIdStr, 10), actorChatId: chatId });
    return sendMessage(env, chatId, '✅ Guide removed and their active bookings were reassigned.', { keyboard: inlineKeyboard([back('guide:list')]) });
  }
  if (data.startsWith('greset:')) return showResetGuideOptions(env, chatId, parseInt(data.split(':')[1], 10));
  if (data.startsWith('greset_do:')) {
    const [, idStr, part] = data.split(':');
    const id = parseInt(idStr, 10);
    if (part === 'telegram') {
      await resetGuideAccount(db, id, { unlinkTelegram: true, actorChatId: chatId });
      return sendMessage(env, chatId, '✅ Telegram connection reset. The guide must send a new code to relink.', { keyboard: inlineKeyboard([back(`gv:${id}`)]) });
    }
    if (part === 'code') {
      const guide = await getGuide(db, id);
      const code = randomGuideCode();
      await generateGuideCodeFor(db, { code, scope: JSON.parse(guide.eligible_scope), guideNameHint: guide.name });
      return sendMessage(env, chatId, `✅ New guide code: <code>${code}</code>`, { keyboard: inlineKeyboard([back(`gv:${id}`)]) });
    }
    if (part === 'full') {
      await resetGuideAccount(db, id, { unlinkTelegram: true, actorChatId: chatId });
      return sendMessage(env, chatId, '✅ Guide account reset (Telegram unlinked). Historical bookings, payments and audit logs were kept.', { keyboard: inlineKeyboard([back(`gv:${id}`)]) });
    }
  }

  // ---- Packages ----
  if (data === 'menu:packages') return showPackagesMenu(env, db, chatId);
  if (data === 'pkg:add') {
    await setSession(db, chatId, 'add_package', 'awaiting_name', {});
    return sendMessage(env, chatId, 'Send the new package <b>name</b>:');
  }
  if (data.startsWith('pkgv:')) return showPackageDetail(env, db, chatId, parseInt(data.split(':')[1], 10));
  if (data.startsWith('pkge:')) return showEditPackageFields(env, chatId, parseInt(data.split(':')[1], 10));
  if (data.startsWith('pkgef:')) {
    const [, idStr, field] = data.split(':');
    await setSession(db, chatId, 'edit_package_field', 'awaiting_value', { id: parseInt(idStr, 10), field });
    return sendMessage(env, chatId, `Send the new value for <b>${field}</b>:`);
  }
  if (data.startsWith('pkgarchive:')) {
    const id = parseInt(data.split(':')[1], 10);
    await archivePackage(db, id, chatId);
    return sendMessage(env, chatId, '🗑️ Package archived (removed from the site). Historical bookings/payments referencing it are untouched.', { keyboard: inlineKeyboard([back('menu:packages')]) });
  }
  if (data.startsWith('pkgreset:')) {
    const id = parseInt(data.split(':')[1], 10);
    await resetPackageConfig(db, id, chatId);
    return sendMessage(env, chatId, '🔄 Package restored to active without touching historical records.', { keyboard: inlineKeyboard([back('menu:packages')]) });
  }

  // ---- Discounts ----
  if (data === 'menu:discounts') return showDiscountsMenu(env, chatId);
  if (data === 'disc:add') {
    await setSession(db, chatId, 'add_discount', 'awaiting_label', {});
    return sendMessage(env, chatId, 'Send a short <b>label</b> for this discount (e.g. "Monsoon 20% off"):');
  }
  if (data.startsWith('discl:')) return showDiscountList(env, db, chatId, data.split(':')[1]);
  if (data === 'disc:usage') return showDiscountUsage(env, db, chatId);
  if (data.startsWith('discv:')) return showDiscountDetail(env, db, chatId, parseInt(data.split(':')[1], 10));
  if (data.startsWith('disce:')) return showEditDiscountFields(env, chatId, parseInt(data.split(':')[1], 10));
  if (data.startsWith('discef:')) {
    const [, idStr, field] = data.split(':');
    await setSession(db, chatId, 'edit_discount_field', 'awaiting_value', { id: parseInt(idStr, 10), field });
    return sendMessage(env, chatId, `Send the new value for <b>${field}</b>:`);
  }
  if (data.startsWith('discremove:')) {
    const id = parseInt(data.split(':')[1], 10);
    await removeDiscount(db, id, chatId);
    return sendMessage(env, chatId, '🗑️ Discount removed (deactivated). Usage history is kept.', { keyboard: inlineKeyboard([back('menu:discounts')]) });
  }

  // ---- Website ----
  if (data === 'menu:website') return showWebsiteMenu(env, db, chatId);
  if (data === 'web:sections') return showWebsiteSections(env, db, chatId);
  if (data === 'web:addfield') {
    await setSession(db, chatId, 'add_website_field', 'awaiting_section', {});
    return sendMessage(env, chatId, '📝 Send the section name for this new field (e.g. "hero", "policies", "contact"):');
  }
  if (data.startsWith('web:sec:')) return showWebsiteSectionKeys(env, db, chatId, data.split(':')[2]);
  if (data.startsWith('web:key:')) {
    const [, , section, key] = data.split(':');
    await setSession(db, chatId, 'edit_website_key', 'awaiting_value', { section, key });
    return sendMessage(env, chatId, `Send the new value for <b>${section}.${key}</b>:`);
  }
  if (data === 'web:enable' || data === 'web:disable' || data === 'set:enable' || data === 'set:disable') {
    const enable = data.endsWith('enable');
    await setSiteEnabled(db, enable, chatId);
    return sendMessage(env, chatId, enable ? '🟢 Website enabled — visitors can book again.' : '🔴 Website disabled — new bookings are blocked until re-enabled.', { keyboard: inlineKeyboard([back('menu:settings')]) });
  }
  if (data === 'web:publish') {
    return sendMessage(env, chatId, '🔄 Changes are already live — every edit you make here applies to the website immediately.', { keyboard: inlineKeyboard([back('menu:website')]) });
  }

  // ---- Settings ----
  if (data === 'menu:settings') return showSettingsMenu(env, db, chatId);
  if (data === 'set:minadv') {
    await setSession(db, chatId, 'set_min_advance', 'awaiting_value', {});
    return sendMessage(env, chatId, 'Send the new minimum advance amount (numbers only, e.g. 500):');
  }
  if (data === 'set:audit') return showRecentAudit(env, db, chatId);

  return sendMessage(env, chatId, 'Unknown option.');
}

// =====================================================================
// DASHBOARD / ANALYTICS
// =====================================================================

async function showDashboard(env, db, chatId) {
  const s = await getDashboardStats(db);
  const text =
    `📊 <b>Dashboard</b>\n\n` +
    `📅 Today's Bookings: ${s.today}\n📆 Upcoming: ${s.upcoming}\n🟢 Confirmed: ${s.confirmed}\n🟡 Pending: ${s.pending}\n❌ Cancelled: ${s.cancelled}\n\n` +
    `💰 Today's Revenue: ₹${s.revenueToday}\n💰 Monthly Revenue: ₹${s.revenueMonth}\n💳 Pending Payments: ${s.pendingPayments}\n` +
    `👥 Active Guides: ${s.activeGuides}\n⚠️ Action Required: ${s.actionRequired}`;
  return sendMessage(env, chatId, text, {
    keyboard: inlineKeyboard([
      [{ text: '📈 Revenue', callback_data: 'dash:revenue' }, { text: '📦 Packages', callback_data: 'dash:packages' }],
      [{ text: '👥 Guides', callback_data: 'dash:guides' }, { text: '💳 Payments', callback_data: 'dash:payments' }],
      [{ text: '🏷️ Discount Usage', callback_data: 'dash:discounts' }],
      back(),
    ]),
  });
}

async function showRevenueAnalytics(env, db, chatId) {
  const rows = await getRevenueAnalytics(db);
  const lines = rows.map((r) => `${r.day}: ₹${r.revenue}`);
  return sendMessage(env, chatId, `📈 <b>Revenue — last 14 days</b>\n${lines.join('\n') || '(no data yet)'}`, { keyboard: inlineKeyboard([back('menu:dashboard')]) });
}
async function showPackagePerformance(env, db, chatId) {
  const rows = await getPackagePerformance(db);
  const lines = rows.map((r) => `${r.name}: ${r.bookings} bookings, ₹${r.revenue}`);
  return sendMessage(env, chatId, `📦 <b>Package Performance</b>\n${lines.join('\n') || '(none yet)'}`, { keyboard: inlineKeyboard([back('menu:dashboard')]) });
}
async function showGuidePerformance(env, db, chatId) {
  const rows = await getGuidePerformance(db);
  const lines = rows.map((r) => `${r.name}: ${r.assigned} assigned, ${r.completed} completed, ${r.declined} declined`);
  return sendMessage(env, chatId, `👥 <b>Guide Performance</b>\n${lines.join('\n') || '(none yet)'}`, { keyboard: inlineKeyboard([back('menu:dashboard')]) });
}
async function showPaymentAnalytics(env, db, chatId) {
  const r = await getPaymentAnalytics(db);
  return sendMessage(
    env, chatId,
    `💳 <b>Payment Analytics</b>\n✅ Captured: ₹${r.captured || 0}\n❌ Failed: ${r.failed_count || 0} (₹${r.failed_amount || 0})\n📊 Total events: ${r.total_events || 0}`,
    { keyboard: inlineKeyboard([back('menu:dashboard')]) }
  );
}
async function showDiscountUsage(env, db, chatId) {
  const rows = await getDiscountUsageReport(db);
  const lines = rows.map((r) => `${r.active ? '🟢' : '⚪'} ${r.label} (${r.percent}%): used ${r.used_count}${r.max_usage ? `/${r.max_usage}` : ''}`);
  return sendMessage(env, chatId, `🏷️ <b>Discount Usage</b>\n${lines.join('\n') || '(none yet)'}`, { keyboard: inlineKeyboard([back('menu:dashboard')]) });
}

// =====================================================================
// PAYMENTS
// =====================================================================

async function showPaymentsMenu(env, db, chatId) {
  const s = await db.prepare('SELECT * FROM payment_settings WHERE id = 1').first();
  const status = s.configured && s.gateway_verified
    ? `🟢 <b>GATEWAY MODE ACTIVE</b> (${s.mode}, key …${s.key_id_last4})`
    : s.configured && !s.gateway_verified
      ? `🟡 <b>MANUAL MODE</b> — Razorpay configured but not currently verified${s.last_failure_reason ? `\nLast issue: ${s.last_failure_reason}` : ''}`
      : `⚪ <b>MANUAL MODE</b> — Razorpay not configured yet`;
  return sendMessage(env, chatId, `💳 <b>Payment Settings</b>\n${status}`, { keyboard: paymentMenu() });
}

async function retestGateway(env, db, chatId) {
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
      : '⚠️ No eligible active guide — assign manually from 📅 Bookings.';
    return sendMessage(env, chatId, `✅ Booking ${booking.booking_code} confirmed. ${guideNote}`);
  }

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

// =====================================================================
// PACKAGES
// =====================================================================

async function showPackagesMenu(env, db, chatId) {
  const packages = await listPackages(db);
  const lines = packages.map((p) => `${p.active ? '🟢' : '⚪'}${p.highlighted ? ' ⭐' : ''} <b>${p.name}</b> — ₹${p.base_price} (id ${p.id})`);
  const buttons = packages.slice(0, 10).map((p) => [{ text: `${p.active ? '🟢' : '⚪'} ${p.name}`, callback_data: `pkgv:${p.id}` }]);
  return sendMessage(env, chatId, `📦 <b>Packages</b>\n${lines.join('\n') || '(none yet)'}`, {
    keyboard: inlineKeyboard([[{ text: '➕ Add package', callback_data: 'pkg:add' }], ...buttons, back()]),
  });
}

async function showPackageDetail(env, db, chatId, id) {
  const p = await db.prepare('SELECT * FROM packages WHERE id = ?').bind(id).first();
  if (!p) return sendMessage(env, chatId, 'Package not found.');
  const text = `📦 <b>${p.name}</b> (id ${p.id})\n${p.description || '(no description)'}\n💰 ₹${p.base_price}\nStatus: ${p.active ? '🟢 Active' : '⚪ Archived'}`;
  return sendMessage(env, chatId, text, {
    keyboard: inlineKeyboard([
      [{ text: '✏️ Edit', callback_data: `pkge:${id}` }],
      p.active ? [{ text: '🗑️ Remove', callback_data: `pkgarchive:${id}` }] : [{ text: '🔄 Reset (restore)', callback_data: `pkgreset:${id}` }],
      back('menu:packages'),
    ]),
  });
}

function showEditPackageFields(env, chatId, id) {
  return sendMessage(env, chatId, 'Which field do you want to edit?', {
    keyboard: inlineKeyboard([
      [{ text: 'Name', callback_data: `pkgef:${id}:name` }, { text: 'Description', callback_data: `pkgef:${id}:description` }],
      [{ text: 'Price', callback_data: `pkgef:${id}:base_price` }],
      back(`pkgv:${id}`),
    ]),
  });
}

async function continueEditPackageField(env, db, chatId, text, session) {
  const { id, field } = session.data;
  const value = field === 'base_price' ? parseFloat(text.replace(/[^0-9.]/g, '')) : text.trim();
  await editPackageField(db, id, field, value, chatId);
  await clearSession(db, chatId);
  return sendMessage(env, chatId, `✅ Updated ${field}.`, { keyboard: inlineKeyboard([back(`pkgv:${id}`)]) });
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

// =====================================================================
// DISCOUNTS
// =====================================================================

function showDiscountsMenu(env, chatId) {
  return sendMessage(env, chatId, '🏷️ <b>Discounts</b>', {
    keyboard: inlineKeyboard([
      [{ text: '➕ Add discount', callback_data: 'disc:add' }],
      [{ text: '📋 Active', callback_data: 'discl:active' }, { text: '⏰ Scheduled', callback_data: 'discl:scheduled' }],
      [{ text: '⌛ Expired', callback_data: 'discl:expired' }, { text: '📊 Usage', callback_data: 'disc:usage' }],
      back(),
    ]),
  });
}

async function showDiscountList(env, db, chatId, group) {
  const grouped = await listDiscountsGrouped(db);
  const rows = grouped[group] || [];
  const titles = { active: '📋 Active', scheduled: '⏰ Scheduled', expired: '⌛ Expired' };
  const buttons = rows.slice(0, 10).map((d) => [{ text: `${d.label} (${d.percent}${d.discount_type === 'fixed' ? '₹' : '%'})`, callback_data: `discv:${d.id}` }]);
  return sendMessage(env, chatId, `${titles[group] || group} <b>Discounts</b>\n${rows.length ? '' : '(none)'}`, {
    keyboard: inlineKeyboard([...buttons, back('menu:discounts')]),
  });
}

async function showDiscountDetail(env, db, chatId, id) {
  const d = await getDiscount(db, id);
  if (!d) return sendMessage(env, chatId, 'Discount not found.');
  const text =
    `🏷️ <b>${d.label}</b> (id ${d.id})\n${d.discount_type === 'fixed' ? `₹${d.percent} off` : `${d.percent}% off`}\n` +
    `Coupon: ${d.coupon_code || '(none)'}\nWindow: ${d.start_date || 'anytime'} → ${d.end_date || 'no end'}\n` +
    `Min booking: ₹${d.min_booking_amount || 0}\nUsage: ${d.used_count}${d.max_usage ? `/${d.max_usage}` : ''}\n` +
    `Status: ${d.active ? '🟢 Active' : '⚪ Removed'}`;
  return sendMessage(env, chatId, text, {
    keyboard: inlineKeyboard([
      [{ text: '✏️ Edit', callback_data: `disce:${id}` }],
      d.active ? [{ text: '🗑️ Remove', callback_data: `discremove:${id}` }] : [],
      back('menu:discounts'),
    ].filter((r) => r.length)),
  });
}

function showEditDiscountFields(env, chatId, id) {
  return sendMessage(env, chatId, 'Which field do you want to edit?', {
    keyboard: inlineKeyboard([
      [{ text: 'Label', callback_data: `discef:${id}:label` }, { text: 'Percent/Amount', callback_data: `discef:${id}:percent` }],
      [{ text: 'Coupon code', callback_data: `discef:${id}:coupon_code` }],
      [{ text: 'Start date', callback_data: `discef:${id}:start_date` }, { text: 'End date', callback_data: `discef:${id}:end_date` }],
      [{ text: 'Max usage', callback_data: `discef:${id}:max_usage` }, { text: 'Min booking ₹', callback_data: `discef:${id}:min_booking_amount` }],
      back(`discv:${id}`),
    ]),
  });
}

async function continueEditDiscountField(env, db, chatId, text, session) {
  const { id, field } = session.data;
  const numericFields = ['percent', 'max_usage', 'min_booking_amount'];
  const value = numericFields.includes(field) ? parseFloat(text.replace(/[^0-9.]/g, '')) : text.trim();
  await editDiscountField(db, id, field, value, chatId);
  await clearSession(db, chatId);
  return sendMessage(env, chatId, `✅ Updated ${field}.`, { keyboard: inlineKeyboard([back(`discv:${id}`)]) });
}

async function continueAddDiscount(env, db, chatId, text, session) {
  if (session.step === 'awaiting_label') {
    await setSession(db, chatId, 'add_discount', 'awaiting_percent', { label: text.trim() });
    return sendMessage(env, chatId, 'Send the discount <b>percent</b> (e.g. 20) — use a plain number for percent-off:');
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
    return sendMessage(env, chatId, `✅ Discount "${session.data.label}" (${session.data.percent}%) added for packages [${packageIds.join(', ')}] (id ${id}).\n\nYou can set a coupon code, date window, usage cap, and minimum booking amount from 🏷️ Discounts → open it → ✏️ Edit.`);
  }
}

// =====================================================================
// BOOKINGS
// =====================================================================

function showBookingsMenu(env, chatId) {
  return sendMessage(env, chatId, '📅 <b>Bookings</b>', {
    keyboard: inlineKeyboard([
      [{ text: '🔴 Action Required', callback_data: 'bkl:action_required' }],
      [{ text: "📆 Today's", callback_data: 'bkl:today' }, { text: '🔵 Upcoming', callback_data: 'bkl:upcoming' }],
      [{ text: '🟢 Confirmed', callback_data: 'bkl:confirmed' }, { text: '🟡 Pending Payment', callback_data: 'bkl:pending_payment' }],
      [{ text: '❌ Cancelled', callback_data: 'bkl:cancelled' }, { text: '📋 All', callback_data: 'bkl:all' }],
      [{ text: '🔎 Search', callback_data: 'bks' }],
      back(),
    ]),
  });
}

async function showBookingList(env, db, chatId, filter) {
  const rows = await listBookingsByFilter(db, filter);
  if (rows.length === 0) return sendMessage(env, chatId, 'No bookings match this filter.', { keyboard: inlineKeyboard([back('menu:bookings')]) });
  const buttons = rows.slice(0, 12).map((b) => [
    { text: `${bookingStatusBadge(b.booking_status)} ${b.booking_code} — ${b.visitor_name || '?'} (${b.visit_date})`, callback_data: `bkv:${b.id}` },
  ]);
  return sendMessage(env, chatId, `📅 <b>Bookings — ${filter}</b> (${rows.length})`, { keyboard: inlineKeyboard([...buttons, back('menu:bookings')]) });
}

async function continueSearchBookings(env, db, chatId, text) {
  const rows = await searchBookings(db, text.trim());
  await clearSession(db, chatId);
  if (rows.length === 0) return sendMessage(env, chatId, 'No matching bookings found.', { keyboard: inlineKeyboard([back('menu:bookings')]) });
  const buttons = rows.slice(0, 12).map((b) => [{ text: `${bookingStatusBadge(b.booking_status)} ${b.booking_code} — ${b.visitor_name}`, callback_data: `bkv:${b.id}` }]);
  return sendMessage(env, chatId, `🔎 <b>Search results</b> (${rows.length})`, { keyboard: inlineKeyboard([...buttons, back('menu:bookings')]) });
}

function bookingDetailText(b) {
  return (
    `📄 <b>${b.booking_code}</b>\n` +
    `👤 ${b.visitor_name || '?'} · ${b.visitor_phone || '?'}\n` +
    `📦 ${b.package_name || b.package_id} · 📅 ${b.visit_date} · 👥 ${b.participants}\n` +
    `💰 ₹${b.final_amount} (discount ₹${b.discount_amount}) · Paid ₹${b.amount_paid_total}\n` +
    `${paymentStatusBadge(b.payment_status)} Payment: ${b.payment_status}\n` +
    `${bookingStatusBadge(b.booking_status)} Booking: ${b.booking_status}\n` +
    `👥 Guide: ${b.guide_name || '(unassigned)'}${b.guide_accept_status ? ` (${b.guide_accept_status})` : ''}\n` +
    `${b.meeting_point ? `📍 ${b.meeting_point}\n` : ''}` +
    `🕐 Created: ${b.created_at}\n` +
    `${b.cancel_reason ? `❌ Cancel reason: ${b.cancel_reason}\n` : ''}` +
    `${b.refund_amount ? `↩️ Refunded: ₹${b.refund_amount}\n` : ''}`
  );
}

async function showBookingDetail(env, db, chatId, id) {
  const b = await getBookingFull(db, id);
  if (!b) return sendMessage(env, chatId, 'Booking not found.');
  const cancellable = !['cancelled', 'rejected', 'completed'].includes(b.booking_status);
  return sendMessage(env, chatId, bookingDetailText(b), {
    keyboard: inlineKeyboard(
      [
        [{ text: b.guide_id ? '🔄 Reassign Guide' : '👥 Assign Guide', callback_data: `bka:${id}` }],
        [{ text: '✏️ Edit', callback_data: `bke:${id}` }],
        cancellable ? [{ text: '❌ Cancel', callback_data: `bkc:${id}` }] : [],
        b.amount_paid_total > 0 ? [{ text: '↩️ Refund', callback_data: `bkf:${id}` }] : [],
        back('menu:bookings'),
      ].filter((r) => r.length)
    ),
  });
}

async function showAssignGuideOptions(env, db, chatId, id) {
  const b = await getBookingFull(db, id);
  const eligible = await listActiveEligibleGuides(db, b.package_id);
  if (eligible.length === 0) return sendMessage(env, chatId, 'No active eligible guides available.', { keyboard: inlineKeyboard([back(`bkv:${id}`)]) });
  const buttons = eligible.map((g) => [{ text: g.name, callback_data: `bkag:${id}:${g.id}` }]);
  return sendMessage(env, chatId, 'Choose a guide to assign:', { keyboard: inlineKeyboard([...buttons, back(`bkv:${id}`)]) });
}

async function doAssignGuide(env, db, chatId, id, guideId) {
  await setBookingGuide(db, id, guideId, { actorChatId: chatId });
  const booking = await getBookingFull(db, id);
  const guide = await getGuide(db, guideId);
  await notifyGuideOfAssignment(env, guide, booking);
  return sendMessage(env, chatId, `✅ ${booking.booking_code} assigned to ${guide.name}. They've been notified and asked to Accept/Decline.`, { keyboard: inlineKeyboard([back(`bkv:${id}`)]) });
}

async function continueCancelBooking(env, db, chatId, text, session) {
  const reason = text.trim() === '-' ? null : text.trim();
  await cancelBooking(db, { id: session.data.id, reason, actorChatId: chatId });
  await clearSession(db, chatId);
  return sendMessage(env, chatId, '❌ Booking cancelled. It remains in your records for audit purposes.', { keyboard: inlineKeyboard([back(`bkv:${session.data.id}`)]) });
}

async function continueRefundBooking(env, db, chatId, text, session) {
  const booking = await getBookingFull(db, session.data.id);
  const amount = text.trim().toLowerCase() === 'full' ? booking.amount_paid_total : parseFloat(text.replace(/[^0-9.]/g, ''));
  if (Number.isNaN(amount) || amount <= 0 || amount > booking.amount_paid_total) {
    return sendMessage(env, chatId, `Please send a valid amount up to ₹${booking.amount_paid_total}, or "full".`);
  }

  if (booking.razorpay_payment_id) {
    const result = await createRazorpayRefund(env, { paymentId: booking.razorpay_payment_id, amount });
    if (!result.ok) {
      await clearSession(db, chatId);
      return sendMessage(env, chatId, `❌ Razorpay refund failed: ${result.reason}. No refund was recorded.`, { keyboard: inlineKeyboard([back(`bkv:${session.data.id}`)]) });
    }
  }

  await recordRefund(db, { id: session.data.id, amount, actorChatId: chatId });
  await clearSession(db, chatId);
  return sendMessage(env, chatId, `✅ Refunded ₹${amount} for ${booking.booking_code}.`, { keyboard: inlineKeyboard([back(`bkv:${session.data.id}`)]) });
}

function showEditBookingFields(env, chatId, id) {
  return sendMessage(env, chatId, 'Which field do you want to edit?', {
    keyboard: inlineKeyboard([
      [{ text: 'Visit date', callback_data: `bkef:${id}:visit_date` }, { text: 'Visit time', callback_data: `bkef:${id}:visit_time` }],
      [{ text: 'Participants', callback_data: `bkef:${id}:participants` }, { text: 'Meeting point', callback_data: `bkef:${id}:meeting_point` }],
      back(`bkv:${id}`),
    ]),
  });
}

async function continueEditBookingField(env, db, chatId, text, session) {
  const { id, field } = session.data;
  const value = field === 'participants' ? parseInt(text.replace(/[^0-9]/g, ''), 10) : text.trim();
  await editBookingField(db, id, field, value, chatId);
  await clearSession(db, chatId);
  return sendMessage(env, chatId, `✅ Updated ${field}.`, { keyboard: inlineKeyboard([back(`bkv:${id}`)]) });
}

// =====================================================================
// GUIDES
// =====================================================================

function showGuidesMenu(env, chatId) {
  return sendMessage(env, chatId, '👥 <b>Guides</b>', {
    keyboard: inlineKeyboard([
      [{ text: '➕ Add Guide', callback_data: 'guide:add' }, { text: '📋 All Guides', callback_data: 'guide:list' }],
      [{ text: '🔎 Search', callback_data: 'guide:search' }, { text: '🔑 Generate Code (any)', callback_data: 'guide:gen:all' }],
      back(),
    ]),
  });
}

async function showGuideList(env, db, chatId) {
  const guides = await listGuides(db);
  const buttons = guides.slice(0, 15).map((g) => [{ text: `${g.status === 'active' ? '🟢' : '🔴'} ${g.name}`, callback_data: `gv:${g.id}` }]);
  return sendMessage(env, chatId, `📋 <b>All Guides</b> (${guides.length})`, { keyboard: inlineKeyboard([...buttons, back('menu:guides')]) });
}

async function continueSearchGuides(env, db, chatId, text) {
  const rows = await searchGuides(db, text.trim());
  await clearSession(db, chatId);
  if (rows.length === 0) return sendMessage(env, chatId, 'No matching guides found.', { keyboard: inlineKeyboard([back('menu:guides')]) });
  const buttons = rows.map((g) => [{ text: g.name, callback_data: `gv:${g.id}` }]);
  return sendMessage(env, chatId, `🔎 <b>Results</b> (${rows.length})`, { keyboard: inlineKeyboard([...buttons, back('menu:guides')]) });
}

async function continueAddGuide(env, db, chatId, text, session) {
  if (session.step === 'awaiting_name') {
    await setSession(db, chatId, 'add_guide', 'awaiting_phone', { name: text.trim() });
    return sendMessage(env, chatId, 'Send their <b>phone number</b>:');
  }
  if (session.step === 'awaiting_phone') {
    await setSession(db, chatId, 'add_guide', 'awaiting_scope', { ...session.data, phone: text.trim() });
    return sendMessage(env, chatId, 'Send the package id(s) they can guide, comma-separated (or "all"):');
  }
  if (session.step === 'awaiting_scope') {
    const scope = text.trim().toLowerCase() === 'all'
      ? { all: true }
      : { all: false, packages: text.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n)) };
    const id = await createGuideProfile(db, { name: session.data.name, phone: session.data.phone, scope }, chatId);
    const code = randomGuideCode();
    await generateGuideCodeFor(db, { code, scope, guideNameHint: session.data.name });
    await clearSession(db, chatId);
    return sendMessage(
      env, chatId,
      `✅ Guide <b>${session.data.name}</b> created (id ${id}).\n\nStatus: 🟡 Awaiting Authentication\nGuide Code: <code>${code}</code>\n\nGive this code to the guide — they send it to this bot to activate their account.`
    );
  }
}

async function showGuideDetail(env, db, chatId, id) {
  const g = await getGuide(db, id);
  if (!g) return sendMessage(env, chatId, 'Guide not found.');
  const workload = await getGuideWorkload(db, id);
  const scope = JSON.parse(g.eligible_scope || '{}');
  const text =
    `👤 <b>${g.name}</b> (id ${g.id})\n📞 ${g.phone || '(none)'}\n` +
    `Status: ${g.status === 'active' ? '🟢 Active' : '🔴 Disabled'}${g.access_removed ? ' · Access removed' : ''}\n` +
    `Availability toggle: ${g.available ? '🟢 Available' : '🔴 Unavailable'}\n` +
    `Eligible: ${scope.all ? 'All packages' : (scope.packages || []).join(', ') || '(none)'}\n` +
    `Linked Telegram: ${g.telegram_chat_id ? '✅' : '❌ not linked'}\n\n` +
    `📅 Today: ${workload.today} · 📆 Upcoming: ${workload.upcoming} · 📋 Total: ${workload.total}`;
  return sendMessage(env, chatId, text, {
    keyboard: inlineKeyboard([
      [{ text: '📋 Bookings', callback_data: `gbookings:${id}` }, { text: '✏️ Edit', callback_data: `gedit:${id}` }],
      [
        g.status === 'active' ? { text: '🔴 Disable', callback_data: `gdisable:${id}` } : { text: '🟢 Enable', callback_data: `genable:${id}` },
        { text: '🔑 New Code', callback_data: `gcode:${id}` },
      ],
      [{ text: '🔄 Reset', callback_data: `greset:${id}` }, { text: '🗑️ Remove', callback_data: `gremove:${id}` }],
      back('guide:list'),
    ]),
  });
}

async function toggleGuideStatus(env, db, chatId, id, status) {
  if (status === 'inactive') {
    const workload = await getGuideWorkload(db, id);
    if (workload.upcoming > 0) {
      // Still disable, but warn (spec 24: admin should be warned about upcoming bookings)
      await setGuideStatus(db, id, status, chatId);
      return sendMessage(env, chatId, `🔴 Guide disabled.\n⚠️ They still have ${workload.upcoming} upcoming booking(s) — those remain assigned; reassign manually if needed.`, { keyboard: inlineKeyboard([back(`gv:${id}`)]) });
    }
  }
  await setGuideStatus(db, id, status, chatId);
  return sendMessage(env, chatId, status === 'active' ? '🟢 Guide enabled.' : '🔴 Guide disabled.', { keyboard: inlineKeyboard([back(`gv:${id}`)]) });
}

async function showGuideBookingsForAdmin(env, db, chatId, id) {
  const rows = await listBookingsForGuide(db, id, 'all', { limit: 12 });
  const lines = rows.map((b) => `${bookingStatusBadge(b.booking_status)} ${b.booking_code} — ${b.visit_date}`);
  return sendMessage(env, chatId, `📋 <b>Bookings</b>\n${lines.join('\n') || '(none)'}`, { keyboard: inlineKeyboard([back(`gv:${id}`)]) });
}

function showEditGuideFields(env, chatId, id) {
  return sendMessage(env, chatId, 'Which field do you want to edit?', {
    keyboard: inlineKeyboard([
      [{ text: 'Name', callback_data: `geditf:${id}:name` }, { text: 'Phone', callback_data: `geditf:${id}:phone` }],
      [{ text: 'Max bookings/day', callback_data: `geditf:${id}:max_bookings_per_day` }],
      back(`gv:${id}`),
    ]),
  });
}

async function continueEditGuideField(env, db, chatId, text, session) {
  const { id, field } = session.data;
  const value = field === 'max_bookings_per_day' ? parseInt(text.replace(/[^0-9]/g, ''), 10) : text.trim();
  await db.prepare(`UPDATE guides SET ${field} = ? WHERE id = ?`).bind(value, id).run();
  await logAudit(db, { actorChatId: chatId, action: 'guide.edit', entity: 'guides', entityId: id, after: { [field]: value } });
  await clearSession(db, chatId);
  return sendMessage(env, chatId, `✅ Updated ${field}.`, { keyboard: inlineKeyboard([back(`gv:${id}`)]) });
}

async function showRemoveGuideOptions(env, db, chatId, id) {
  const g = await getGuide(db, id);
  const workload = await getGuideWorkload(db, id);
  const text = `🗑️ <b>Remove ${g.name}</b>\n📅 Today: ${workload.today} · 📆 Upcoming: ${workload.upcoming} · 📋 Total: ${workload.total}\n\nWhat should happen to their active/upcoming bookings?`;
  return sendMessage(env, chatId, text, {
    keyboard: inlineKeyboard([
      [{ text: '🔄 Reassign bookings', callback_data: `gremove_opt:${id}:reassign` }],
      [{ text: '⚠️ Leave unassigned', callback_data: `gremove_opt:${id}:leave` }],
      back(`gv:${id}`),
    ]),
  });
}

async function showReassignTargetOptions(env, db, chatId, id) {
  const others = (await listGuides(db)).filter((g) => g.id !== id);
  if (others.length === 0) return sendMessage(env, chatId, 'No other guide available to reassign to — bookings will be left unassigned.', { keyboard: inlineKeyboard([back(`gv:${id}`)]) });
  const buttons = others.map((g) => [{ text: g.name, callback_data: `gremove_to:${id}:${g.id}` }]);
  return sendMessage(env, chatId, 'Reassign their bookings to:', { keyboard: inlineKeyboard([...buttons, back(`gv:${id}`)]) });
}

function showResetGuideOptions(env, chatId, id) {
  return sendMessage(env, chatId, '🔄 <b>Reset Guide</b>', {
    keyboard: inlineKeyboard([
      [{ text: '📱 Reset Telegram Connection', callback_data: `greset_do:${id}:telegram` }],
      [{ text: '🔄 Generate New Code', callback_data: `greset_do:${id}:code` }],
      [{ text: '♻️ Full Reset', callback_data: `greset_do:${id}:full` }],
      back(`gv:${id}`),
    ]),
  });
}

// =====================================================================
// WEBSITE (spec section 4)
// =====================================================================

async function showWebsiteMenu(env, db, chatId) {
  const site = await getSiteSettings(db);
  return sendMessage(env, chatId, `🌐 <b>Website</b>\nStatus: ${site.site_enabled ? '🟢 Enabled' : '🔴 Disabled'}`, {
    keyboard: inlineKeyboard([
      [{ text: '📝 Edit Sections', callback_data: 'web:sections' }],
      [{ text: '➕ Add Content Field', callback_data: 'web:addfield' }],
      [{ text: '👁️ Preview', callback_data: 'web:publish' }],
      site.site_enabled ? [{ text: '🔴 Disable Site', callback_data: 'web:disable' }] : [{ text: '🟢 Enable Site', callback_data: 'web:enable' }],
      [{ text: '🔄 Publish / Update', callback_data: 'web:publish' }],
      back(),
    ]),
  });
}

async function showWebsiteSections(env, db, chatId) {
  const all = await listContent(db);
  const sections = [...new Set(all.map((c) => c.section))];
  const buttons = sections.map((s) => [{ text: s, callback_data: `web:sec:${s}` }]);
  return sendMessage(env, chatId, `📝 <b>Sections</b>\n${sections.length ? '' : '(no editable content rows yet — add some directly via the API/DB, then edit here)'}`, {
    keyboard: inlineKeyboard([...buttons, back('menu:website')]),
  });
}

async function showWebsiteSectionKeys(env, db, chatId, section) {
  const rows = await listContent(db, section);
  const buttons = rows.map((r) => [{ text: `${r.visible ? '🟢' : '⚪'} ${r.key}`, callback_data: `web:key:${section}:${r.key}` }]);
  return sendMessage(env, chatId, `📝 <b>${section}</b>`, { keyboard: inlineKeyboard([...buttons, back('web:sections')]) });
}

async function continueEditWebsiteKey(env, db, chatId, text, session) {
  const { section, key } = session.data;
  await upsertContent(db, { section, key, value: text.trim(), actorChatId: chatId });
  await clearSession(db, chatId);
  return sendMessage(env, chatId, `✅ Updated <b>${section}.${key}</b>. This is live on the website immediately.`, { keyboard: inlineKeyboard([back(`web:sec:${section}`)]) });
}

async function continueAddWebsiteField(env, db, chatId, text, session) {
  if (session.step === 'awaiting_section') {
    await setSession(db, chatId, 'add_website_field', 'awaiting_key', { section: text.trim() });
    return sendMessage(env, chatId, 'Send a short key name for this field (e.g. "title", "note", "phone"):');
  }
  if (session.step === 'awaiting_key') {
    await setSession(db, chatId, 'add_website_field', 'awaiting_value', { ...session.data, key: text.trim() });
    return sendMessage(env, chatId, 'Now send the text (or image URL) for this field:');
  }
  if (session.step === 'awaiting_value') {
    const { section, key } = session.data;
    await upsertContent(db, { section, key, value: text.trim(), actorChatId: chatId });
    await clearSession(db, chatId);
    return sendMessage(
      env, chatId,
      `✅ Added <b>${section}.${key}</b>.\n\nNote: this only appears on the live site if a matching <code>data-cms="${section}.${key}"</code> tag exists in the page — ask your developer to add one if this is a brand-new spot, or use this to update an existing tagged field.`,
      { keyboard: inlineKeyboard([back('web:sections')]) }
    );
  }
}

// =====================================================================
// SETTINGS (spec section 30)
// =====================================================================

async function showSettingsMenu(env, db, chatId) {
  const p = await db.prepare('SELECT * FROM payment_settings WHERE id = 1').first();
  const site = await getSiteSettings(db);
  return sendMessage(
    env, chatId,
    `⚙️ <b>Settings</b>\n\n🌐 Website: ${site.site_enabled ? '🟢 Enabled' : '🔴 Disabled'}\n💰 Minimum advance: ₹${p.min_advance_amount}`,
    {
      keyboard: inlineKeyboard([
        [{ text: '💰 Min Advance Amount', callback_data: 'set:minadv' }],
        site.site_enabled ? [{ text: '🔴 Disable Website', callback_data: 'set:disable' }] : [{ text: '🟢 Enable Website', callback_data: 'set:enable' }],
        [{ text: '📜 Recent Audit Log', callback_data: 'set:audit' }],
        back(),
      ]),
    }
  );
}

async function continueSetMinAdvance(env, db, chatId, text, session) {
  const amount = parseFloat(text.replace(/[^0-9.]/g, ''));
  if (Number.isNaN(amount) || amount <= 0) return sendMessage(env, chatId, 'Please send a valid positive number.');
  await setMinAdvanceAmount(db, amount, chatId);
  await clearSession(db, chatId);
  return sendMessage(env, chatId, `✅ Minimum advance amount set to ₹${amount}.`, { keyboard: inlineKeyboard([back('menu:settings')]) });
}

async function showRecentAudit(env, db, chatId) {
  const rows = (await db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 15').all()).results;
  const lines = rows.map((r) => `${r.created_at} — ${r.action} (${r.entity || ''}${r.entity_id ? `#${r.entity_id}` : ''})`);
  return sendMessage(env, chatId, `📜 <b>Recent Audit Log</b>\n${lines.join('\n') || '(none yet)'}`, { keyboard: inlineKeyboard([back('menu:settings')]) });
}

// =====================================================================
// Guide decline reason (admin-side text handler is unused directly — kept
// for symmetry; the actual decline-reason prompt happens in the guide bot,
// but if a guide's session is ever misclassified as admin this is a no-op
// safeguard so /menu still works).
// =====================================================================
async function continueGuideDeclineReason(env, db, chatId, text, session) {
  await clearSession(db, chatId);
  return sendMessage(env, chatId, 'Use /menu to open the admin panel.');
}
