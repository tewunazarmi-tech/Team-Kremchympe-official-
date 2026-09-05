import { listActiveEligibleGuides, updateBookingStatus, logAudit } from './db.js';
import { sendMessage } from './telegram.js';

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
  if (discountId) {
    const discount = await db.prepare('SELECT * FROM discounts WHERE id = ? AND active = 1').bind(discountId).first();
    if (discount) {
      const appliesTo = JSON.parse(discount.applies_to);
      const applies =
        (appliesTo.packages || []).includes(packageId) ||
        (selectedServices || []).some((s) => (appliesTo.services || []).includes(s.serviceId));
      if (applies) {
        discountAmount = ((baseAmount + addonAmount) * discount.percent) / 100;
      }
    }
  }

  const finalAmount = Math.max(0, baseAmount + addonAmount - discountAmount);
  return { baseAmount, addonAmount, discountAmount, finalAmount, currency: 'INR' };
}

// Atomic-ish assignment: pick the least-loaded eligible active guide, then
// use a conditional UPDATE (guide_id IS NULL) so a concurrent assignment
// attempt on the same booking can't double-assign it. D1 executes writes
// to a given database serially, which makes this safe in practice; the
// guard is kept anyway as defense in depth.
export async function assignGuide(env, db, booking) {
  const eligible = await listActiveEligibleGuides(db, booking.package_id);
  if (eligible.length === 0) {
    return { assigned: false, reason: 'no_eligible_guide' };
  }

  const loadCounts = await Promise.all(
    eligible.map(async (g) => {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS c FROM bookings
           WHERE guide_id = ? AND booking_status IN ('assigned','reminder_scheduled')`
        )
        .bind(g.id)
        .first();
      return { guide: g, load: row.c };
    })
  );
  loadCounts.sort((a, b) => a.load - b.load);
  const chosen = loadCounts[0].guide;

  const res = await db
    .prepare("UPDATE bookings SET guide_id = ?, booking_status = 'assigned', updated_at = datetime('now') WHERE id = ? AND guide_id IS NULL")
    .bind(chosen.id, booking.id)
    .run();

  if (res.meta.changes === 0) {
    // Someone else already assigned it between our SELECT and UPDATE.
    return { assigned: false, reason: 'already_assigned' };
  }

  await logAudit(db, { actorChatId: 'system', action: 'booking.assigned', entity: 'bookings', entityId: booking.id, after: { guideId: chosen.id } });
  return { assigned: true, guide: chosen };
}

// Shared "payment accepted" path used by BOTH modes: called once a gateway
// payment clears (webhook) or an admin manually approves a receipt. Marks
// the booking confirmed, tries to assign a guide, and notifies everyone —
// a successfully paid/approved booking is never rejected just because no
// guide is free right now (it stays confirmed with guide = unassigned).
export async function confirmBookingAndAssign(env, db, booking) {
  await updateBookingStatus(db, booking.id, { bookingStatus: 'confirmed' });

  const assignment = await assignGuide(env, db, booking);

  if (assignment.assigned) {
    await sendMessage(
      env,
      assignment.guide.telegram_chat_id,
      `📩 New booking assigned: <b>${booking.booking_code}</b>\n📅 ${booking.visit_date} · 👥 ${booking.participants}\n💰 ₹${booking.final_amount}`
    );
    const visitDate = new Date(booking.visit_date);
    const reminderTime = new Date(visitDate.getTime() - 24 * 60 * 60 * 1000).toISOString();
    await db
      .prepare('INSERT INTO reminders (booking_id, guide_id, scheduled_for) VALUES (?, ?, ?)')
      .bind(booking.id, assignment.guide.id, reminderTime)
      .run();
  } else if (assignment.reason === 'no_eligible_guide') {
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
