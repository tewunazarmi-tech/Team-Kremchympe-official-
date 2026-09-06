import { listActiveEligibleGuides, updateBookingStatus, logAudit, setBookingGuide, incrementDiscountUsage, setGuideAcceptStatus, scheduleRemindersForBooking, cancelRemindersForBooking } from './db.js';
import { sendMessage, inlineKeyboard } from './telegram.js';

export function generateBookingCode() {
  const d = new Date();
  const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const rand = crypto.getRandomValues(new Uint8Array(3));
  const suffix = [...rand].map((b) => b.toString(16)).join('').toUpperCase();
  return `KC-${stamp}-${suffix}`;
}

// The ONLY place the final price is computed. The browser's number is
// never trusted — it's only used to render a preview before submit.
export async function computeFinalAmount(db, { packageId, participants, selectedServices, discountId }) {
  const pkg = await db.prepare('SELECT * FROM packages WHERE id = ? AND active = 1').bind(packageId).first();
  if (!pkg) throw new Error('Invalid or inactive package');

  const baseAmount = pkg.base_price * Math.max(1, participants | 0);

  let addonAmount = 0;
  for (const sel of selectedServices || []) {
    const svc = await db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').bind(sel.serviceId).first();
    if (!svc) throw new Error(`Invalid or inactive service: ${sel.serviceId}`);
    addonAmount += svc.price * Math.max(1, sel.qty | 0);
  }

  let discountAmount = 0;
  let appliedDiscountId = null;
  if (discountId) {
    const discount = await db.prepare('SELECT * FROM discounts WHERE id = ? AND active = 1').bind(discountId).first();
    if (discount) {
      const appliesTo = JSON.parse(discount.applies_to);
      const inScope =
        (appliesTo.packages || []).includes(packageId) ||
        (selectedServices || []).some((s) => (appliesTo.services || []).includes(s.serviceId));
      const today = new Date().toISOString().slice(0, 10);
      const withinWindow = (!discount.start_date || discount.start_date <= today) && (!discount.end_date || discount.end_date >= today);
      const preAmount = baseAmount + addonAmount;
      const meetsMinimum = preAmount >= (discount.min_booking_amount || 0);
      const underUsageCap = discount.max_usage == null || discount.used_count < discount.max_usage;

      if (inScope && withinWindow && meetsMinimum && underUsageCap) {
        discountAmount = discount.discount_type === 'fixed' ? discount.percent : (preAmount * discount.percent) / 100;
        appliedDiscountId = discount.id;
      }
    }
  }

  const finalAmount = Math.max(0, baseAmount + addonAmount - discountAmount);
  return { baseAmount, addonAmount, discountAmount, finalAmount, currency: 'INR', appliedDiscountId };
}

// Atomic-ish assignment: pick the least-loaded eligible active guide, then
// use a conditional UPDATE (guide_id IS NULL) so a concurrent assignment
// attempt on the same booking can't double-assign it. D1 executes writes
// to a given database serially, which makes this safe in practice; the
// guard is kept anyway as defense in depth.
export async function assignGuide(env, db, booking, { excludeGuideIds = [] } = {}) {
  let eligible = await listActiveEligibleGuides(db, booking.package_id);
  eligible = eligible.filter((g) => g.available && !excludeGuideIds.includes(g.id));
  if (eligible.length === 0) {
    return { assigned: false, reason: 'no_eligible_guide' };
  }

  const loadCounts = await Promise.all(
    eligible.map(async (g) => {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS c FROM bookings
           WHERE guide_id = ? AND booking_status IN ('assigned','guide_accepted','in_progress')`
        )
        .bind(g.id)
        .first();
      return { guide: g, load: row.c };
    })
  );
  loadCounts.sort((a, b) => a.load - b.load);
  const eligibleUnderCap = loadCounts.filter((lc) => lc.load < (lc.guide.max_bookings_per_day || 5));
  const pick = (eligibleUnderCap.length ? eligibleUnderCap : loadCounts)[0];
  const chosen = pick.guide;

  const res = await db
    .prepare("UPDATE bookings SET guide_id = ?, booking_status = 'assigned', guide_accept_status = 'pending', updated_at = datetime('now') WHERE id = ? AND guide_id IS NULL")
    .bind(chosen.id, booking.id)
    .run();

  if (res.meta.changes === 0) {
    // Someone else already assigned it between our SELECT and UPDATE.
    return { assigned: false, reason: 'already_assigned' };
  }

  await logAudit(db, { actorChatId: 'system', action: 'booking.assigned', entity: 'bookings', entityId: booking.id, after: { guideId: chosen.id } });
  return { assigned: true, guide: chosen };
}

// Called when a guide declines an assignment (spec section 21): removes them
// from consideration and tries the next eligible guide. Never cancels the
// customer's booking just because one guide declined.
export async function reassignAfterDecline(env, db, booking, declinedGuideId) {
  const assignment = await assignGuide(env, db, booking, { excludeGuideIds: [declinedGuideId] });

  if (assignment.assigned) {
    const refreshed = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(booking.id).first();
    await notifyGuideOfAssignment(env, assignment.guide, { ...booking, ...refreshed });
    await scheduleRemindersForBooking(db, refreshed, assignment.guide);
  } else {
    await db.prepare("UPDATE bookings SET booking_status='guide_required', guide_id=NULL, guide_accept_status=NULL, updated_at=datetime('now') WHERE id=?").bind(booking.id).run();
    const admins = (await db.prepare('SELECT telegram_chat_id FROM admin_users').all()).results;
    for (const a of admins) {
      await sendMessage(env, a.telegram_chat_id, `⚠️ Guide declined booking <b>${booking.booking_code}</b> and no other eligible guide is available.\nPlease assign manually from 📅 Bookings.`);
    }
  }
  return assignment;
}

export async function notifyGuideOfAssignment(env, guide, booking) {
  const keyboard = inlineKeyboard([
    [{ text: '📄 View Booking', callback_data: `g:view:${booking.id}` }],
    [{ text: '✅ Accept', callback_data: `g:accept:${booking.id}` }, { text: '❌ Decline', callback_data: `g:decline:${booking.id}` }],
  ]);
  await sendMessage(
    env,
    guide.telegram_chat_id,
    `🔔 <b>NEW BOOKING</b>\n\nBooking ID: #${booking.booking_code}\n\n📦 Package: ${booking.package_name || booking.package_id}\n📅 Date: ${booking.visit_date}\n👥 Guests: ${booking.participants}\n${booking.meeting_point ? `📍 Meeting Point: ${booking.meeting_point}\n` : ''}\n💳 Payment: ${booking.payment_status.toUpperCase()}\n🟢 Booking: ${booking.booking_status.toUpperCase()}`,
    { keyboard }
  );
}

// Shared "payment accepted" path used by BOTH modes: called once a gateway
// payment clears (webhook) or an admin manually approves a receipt. Marks
// the booking confirmed, tries to assign a guide, and notifies everyone —
// a successfully paid/approved booking is never rejected just because no
// guide is free right now (it stays confirmed with guide = unassigned).
export async function confirmBookingAndAssign(env, db, booking) {
  await updateBookingStatus(db, booking.id, { bookingStatus: 'confirmed' });

  if (booking.discount_id) {
    await incrementDiscountUsage(db, booking.discount_id);
  }

  const assignment = await assignGuide(env, db, booking);

  if (assignment.assigned) {
    await notifyGuideOfAssignment(env, assignment.guide, booking);
    await scheduleRemindersForBooking(db, booking, assignment.guide);
  } else if (assignment.reason === 'no_eligible_guide') {
    await db.prepare("UPDATE bookings SET booking_status='guide_required', updated_at=datetime('now') WHERE id=?").bind(booking.id).run();
    const admins = (await db.prepare('SELECT telegram_chat_id FROM admin_users').all()).results;
    for (const a of admins) {
      await sendMessage(
        env,
        a.telegram_chat_id,
        `⚠️ NO ACTIVE ELIGIBLE GUIDE AVAILABLE for booking <b>${booking.booking_code}</b>.\nPayment is verified and the booking is confirmed — please assign a guide manually.`
      );
    }
  }

  return assignment;
}
