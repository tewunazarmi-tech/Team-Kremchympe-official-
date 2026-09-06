// Thin helpers over the D1 binding. Keeping all raw SQL here so the rest
// of the codebase never writes ad-hoc queries.

export async function getAdminRole(db, chatId) {
  const row = await db
    .prepare('SELECT role FROM admin_users WHERE telegram_chat_id = ?')
    .bind(String(chatId))
    .first();
  return row ? row.role : null;
}

export async function logAudit(db, { actorChatId, action, entity, entityId, before, after }) {
  await db
    .prepare(
      `INSERT INTO audit_log (actor_chat_id, action, entity, entity_id, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      String(actorChatId ?? ''),
      action,
      entity ?? null,
      entityId != null ? String(entityId) : null,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null
    )
    .run();
}

// ---- Website content (CMS) ----
export async function listContent(db, section) {
  if (section) {
    return (
      await db
        .prepare('SELECT * FROM website_content WHERE section = ? ORDER BY sort_order, id')
        .bind(section)
        .all()
    ).results;
  }
  return (await db.prepare('SELECT * FROM website_content ORDER BY section, sort_order, id').all())
    .results;
}

export async function upsertContent(db, { section, key, value, contentType = null, visible = null, highlighted = null, sortOrder = null, actorChatId }) {
  const existing = await db
    .prepare('SELECT * FROM website_content WHERE section = ? AND key = ?')
    .bind(section, key)
    .first();

  await db
    .prepare(
      `INSERT INTO website_content (section, key, value, content_type, visible, highlighted, sort_order, updated_by, updated_at)
       VALUES (?, ?, ?, COALESCE(?, 'text'), COALESCE(?, 1), COALESCE(?, 0), COALESCE(?, 0), ?, datetime('now'))
       ON CONFLICT(section, key) DO UPDATE SET
         value = excluded.value,
         content_type = excluded.content_type,
         visible = COALESCE(?, website_content.visible),
         highlighted = COALESCE(?, website_content.highlighted),
         sort_order = COALESCE(?, website_content.sort_order),
         updated_by = excluded.updated_by,
         updated_at = datetime('now')`
    )
    .bind(
      section, key, value, contentType, visible, highlighted, sortOrder, String(actorChatId ?? ''),
      visible, highlighted, sortOrder
    )
    .run();

  await logAudit(db, {
    actorChatId,
    action: existing ? 'content.update' : 'content.create',
    entity: 'website_content',
    entityId: `${section}.${key}`,
    before: existing,
    after: { section, key, value, contentType, visible, highlighted, sortOrder },
  });
}

// ---- Packages / services ----
export async function listPackages(db, { activeOnly } = {}) {
  const q = activeOnly
    ? 'SELECT * FROM packages WHERE active = 1 ORDER BY sort_order, id'
    : 'SELECT * FROM packages ORDER BY sort_order, id';
  return (await db.prepare(q).all()).results;
}

export async function upsertPackage(db, pkg, actorChatId) {
  const before = pkg.id
    ? await db.prepare('SELECT * FROM packages WHERE id = ?').bind(pkg.id).first()
    : null;

  let id = pkg.id;
  if (id) {
    await db
      .prepare(
        `UPDATE packages SET name=?, description=?, base_price=?, image_url=?, active=?, highlighted=?, sort_order=?, updated_at=datetime('now')
         WHERE id = ?`
      )
      .bind(pkg.name, pkg.description ?? null, pkg.basePrice, pkg.imageUrl ?? null, pkg.active ?? 1, pkg.highlighted ?? 0, pkg.sortOrder ?? 0, id)
      .run();
  } else {
    const res = await db
      .prepare(
        `INSERT INTO packages (name, description, base_price, image_url, active, highlighted, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(pkg.name, pkg.description ?? null, pkg.basePrice, pkg.imageUrl ?? null, pkg.active ?? 1, pkg.highlighted ?? 0, pkg.sortOrder ?? 0)
      .run();
    id = res.meta.last_row_id;
  }

  await logAudit(db, { actorChatId, action: before ? 'package.update' : 'package.create', entity: 'packages', entityId: id, before, after: pkg });
  return id;
}

export async function deletePackage(db, id, actorChatId) {
  const before = await db.prepare('SELECT * FROM packages WHERE id = ?').bind(id).first();
  await db.prepare('DELETE FROM packages WHERE id = ?').bind(id).run();
  await logAudit(db, { actorChatId, action: 'package.delete', entity: 'packages', entityId: id, before, after: null });
}

// ---- Discounts ----
export async function listDiscounts(db, { activeOnly } = {}) {
  const q = activeOnly ? 'SELECT * FROM discounts WHERE active = 1' : 'SELECT * FROM discounts';
  const rows = (await db.prepare(q).all()).results;
  return rows.map((r) => ({ ...r, applies_to: JSON.parse(r.applies_to) }));
}

export async function upsertDiscount(db, d, actorChatId) {
  const before = d.id ? await db.prepare('SELECT * FROM discounts WHERE id = ?').bind(d.id).first() : null;
  let id = d.id;
  const appliesTo = JSON.stringify(d.appliesTo ?? { packages: [], services: [] });
  if (id) {
    await db
      .prepare('UPDATE discounts SET label=?, percent=?, applies_to=?, stackable=?, active=? WHERE id=?')
      .bind(d.label, d.percent, appliesTo, d.stackable ?? 0, d.active ?? 1, id)
      .run();
  } else {
    const res = await db
      .prepare('INSERT INTO discounts (label, percent, applies_to, stackable, active) VALUES (?, ?, ?, ?, ?)')
      .bind(d.label, d.percent, appliesTo, d.stackable ?? 0, d.active ?? 1)
      .run();
    id = res.meta.last_row_id;
  }
  await logAudit(db, { actorChatId, action: before ? 'discount.update' : 'discount.create', entity: 'discounts', entityId: id, before, after: d });
  return id;
}

// ---- Guides ----
export async function findGuideByChatId(db, chatId) {
  return db.prepare('SELECT * FROM guides WHERE telegram_chat_id = ?').bind(String(chatId)).first();
}

export async function listActiveEligibleGuides(db, packageId) {
  const rows = (
    await db.prepare("SELECT * FROM guides WHERE status = 'active' AND access_removed = 0").all()
  ).results;
  return rows.filter((g) => {
    const scope = JSON.parse(g.eligible_scope || '{}');
    return scope.all === true || (Array.isArray(scope.packages) && scope.packages.includes(packageId));
  });
}

// ---- Bot conversation sessions (multi-step Telegram flows) ----
export async function getSession(db, chatId) {
  const row = await db.prepare('SELECT * FROM bot_sessions WHERE telegram_chat_id = ?').bind(String(chatId)).first();
  if (!row) return null;
  return { ...row, data: JSON.parse(row.data) };
}

export async function setSession(db, chatId, flow, step, data) {
  await db
    .prepare(
      `INSERT INTO bot_sessions (telegram_chat_id, flow, step, data, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(telegram_chat_id) DO UPDATE SET flow=excluded.flow, step=excluded.step, data=excluded.data, updated_at=datetime('now')`
    )
    .bind(String(chatId), flow, step, JSON.stringify(data ?? {}))
    .run();
}

export async function clearSession(db, chatId) {
  await db.prepare('DELETE FROM bot_sessions WHERE telegram_chat_id = ?').bind(String(chatId)).run();
}

// ---- Payments (duplicate-prevention) ----
// Checks specifically for an already-recorded 'payment.captured' event for
// this payment id. A single Razorpay payment can legitimately generate
// several webhook events (authorized → captured) plus retried deliveries of
// the same event — this only blocks re-crediting a booking for a capture
// we've already applied.
export async function capturedPaymentAlreadyProcessed(db, razorpayPaymentId) {
  if (!razorpayPaymentId) return false;
  const row = await db
    .prepare("SELECT id FROM payments WHERE razorpay_payment_id = ? AND status = 'payment.captured'")
    .bind(razorpayPaymentId)
    .first();
  return !!row;
}

// ---- Bookings ----
export async function createBooking(db, b) {
  // idempotency: if a row with this key already exists, return it instead of inserting again
  if (b.idempotencyKey) {
    const existing = await db
      .prepare('SELECT * FROM bookings WHERE idempotency_key = ?')
      .bind(b.idempotencyKey)
      .first();
    if (existing) return { booking: existing, created: false };
  }

  const res = await db
    .prepare(
      `INSERT INTO bookings
       (booking_code, visitor_id, package_id, participants, visit_date, selected_services,
        discount_id, base_amount, discount_amount, addon_amount, final_amount, currency,
        idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      b.bookingCode, b.visitorId, b.packageId, b.participants, b.visitDate,
      JSON.stringify(b.selectedServices ?? []), b.discountId ?? null,
      b.baseAmount, b.discountAmount, b.addonAmount, b.finalAmount, b.currency ?? 'INR',
      b.idempotencyKey ?? null
    )
    .run();

  const booking = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(res.meta.last_row_id).first();
  return { booking, created: true };
}

// Applies a captured Razorpay payment to a booking's running total and
// derives the correct payment_status. Returns the updated booking plus
// whether this was the FIRST payment to clear the minimum advance (the
// signal that guide assignment should now happen).
export async function recordPaymentCaptured(db, bookingId, amount, razorpayPaymentId) {
  const before = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(bookingId).first();
  if (!before) return { booking: null, crossedMinAdvance: false };

  const settings = await db.prepare('SELECT * FROM payment_settings WHERE id = 1').first();
  const newTotal = before.amount_paid_total + amount;
  const wasBelowMin = before.amount_paid_total < settings.min_advance_amount;
  const nowAtOrAboveMin = newTotal >= settings.min_advance_amount;
  const fullyPaid = newTotal >= before.final_amount;

  const paymentStatus = fullyPaid ? 'verified' : nowAtOrAboveMin ? 'partial' : 'submitted';

  await db
    .prepare(
      `UPDATE bookings SET
         amount_paid_total = ?,
         payment_status = ?,
         razorpay_payment_id = COALESCE(?, razorpay_payment_id),
         updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(newTotal, paymentStatus, razorpayPaymentId ?? null, bookingId)
    .run();

  const booking = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(bookingId).first();
  return { booking, crossedMinAdvance: wasBelowMin && nowAtOrAboveMin };
}

export async function updateBookingStatus(db, bookingId, { paymentStatus, bookingStatus, razorpayOrderId, razorpayPaymentId, guideId, receiptFileId, receiptIsImage }) {
  await db
    .prepare(
      `UPDATE bookings SET
         payment_status = COALESCE(?, payment_status),
         booking_status = COALESCE(?, booking_status),
         razorpay_order_id = COALESCE(?, razorpay_order_id),
         razorpay_payment_id = COALESCE(?, razorpay_payment_id),
         guide_id = COALESCE(?, guide_id),
         receipt_file_id = COALESCE(?, receipt_file_id),
         receipt_is_image = COALESCE(?, receipt_is_image),
         updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(
      paymentStatus ?? null,
      bookingStatus ?? null,
      razorpayOrderId ?? null,
      razorpayPaymentId ?? null,
      guideId ?? null,
      receiptFileId ?? null,
      receiptIsImage == null ? null : (receiptIsImage ? 1 : 0),
      bookingId
    )
    .run();
}

// ---- Bookings: lookup / search / filters (📅 Bookings menu) ----

const BOOKING_LIST_SELECT = `
  SELECT b.*, v.name AS visitor_name, v.phone AS visitor_phone, v.email AS visitor_email,
         p.name AS package_name, g.name AS guide_name
  FROM bookings b
  LEFT JOIN visitors v ON v.id = b.visitor_id
  LEFT JOIN packages p ON p.id = b.package_id
  LEFT JOIN guides g ON g.id = b.guide_id
`;

export async function getBookingFull(db, id) {
  return db.prepare(`${BOOKING_LIST_SELECT} WHERE b.id = ?`).bind(id).first();
}

export async function getBookingByCode(db, code) {
  return db.prepare(`${BOOKING_LIST_SELECT} WHERE b.booking_code = ?`).bind(code).first();
}

// filter: 'today' | 'upcoming' | 'confirmed' | 'pending_payment' | 'cancelled' | 'action_required' | 'all'
export async function listBookingsByFilter(db, filter, { limit = 15 } = {}) {
  let where = '1=1';
  if (filter === 'today') where = "date(b.visit_date) = date('now')";
  else if (filter === 'upcoming') where = "date(b.visit_date) > date('now') AND b.booking_status NOT IN ('cancelled','rejected','completed')";
  else if (filter === 'confirmed') where = "b.booking_status IN ('confirmed','assigned','guide_accepted','in_progress')";
  else if (filter === 'pending_payment') where = "b.payment_status IN ('pending','awaiting_verification','partial')";
  else if (filter === 'cancelled') where = "b.booking_status IN ('cancelled','rejected')";
  else if (filter === 'action_required') where = "b.booking_status = 'guide_required' OR b.payment_status = 'awaiting_verification'";
  return (
    await db.prepare(`${BOOKING_LIST_SELECT} WHERE ${where} ORDER BY b.visit_date DESC, b.id DESC LIMIT ?`).bind(limit).all()
  ).results;
}

export async function searchBookings(db, term, { limit = 15 } = {}) {
  const like = `%${term}%`;
  return (
    await db
      .prepare(`${BOOKING_LIST_SELECT} WHERE b.booking_code LIKE ? OR v.name LIKE ? OR v.phone LIKE ? ORDER BY b.id DESC LIMIT ?`)
      .bind(like, like, like, limit)
      .all()
  ).results;
}

export async function listBookingsForGuide(db, guideId, filter, { limit = 15 } = {}) {
  let where = 'b.guide_id = ?';
  if (filter === 'today') where += " AND date(b.visit_date) = date('now')";
  else if (filter === 'future') where += " AND date(b.visit_date) > date('now') AND b.booking_status NOT IN ('cancelled','rejected','completed')";
  else if (filter === 'confirmed') where += " AND b.booking_status IN ('assigned','guide_accepted')";
  else if (filter === 'pending') where += " AND b.booking_status = 'assigned' AND b.guide_accept_status = 'pending'";
  else if (filter === 'completed') where += " AND b.booking_status = 'completed'";
  else if (filter === 'cancelled') where += " AND b.booking_status IN ('cancelled','rejected')";
  return (
    await db.prepare(`${BOOKING_LIST_SELECT} WHERE ${where} ORDER BY b.visit_date ASC LIMIT ?`).bind(guideId, limit).all()
  ).results;
}

export async function searchBookingsForGuide(db, guideId, term, { limit = 15 } = {}) {
  const like = `%${term}%`;
  return (
    await db
      .prepare(`${BOOKING_LIST_SELECT} WHERE b.guide_id = ? AND (b.booking_code LIKE ? OR v.name LIKE ?) ORDER BY b.id DESC LIMIT ?`)
      .bind(guideId, like, like, limit)
      .all()
  ).results;
}

export async function cancelBooking(db, { id, reason, actorChatId, refundAmount = 0 }) {
  const before = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
  await db
    .prepare(
      `UPDATE bookings SET booking_status='cancelled', cancel_reason=?, cancelled_by=?, cancelled_at=datetime('now'),
       refund_amount = refund_amount + ?, updated_at=datetime('now') WHERE id=?`
    )
    .bind(reason ?? null, String(actorChatId ?? ''), refundAmount, id)
    .run();
  await cancelRemindersForBooking(db, id);
  await logAudit(db, { actorChatId, action: 'booking.cancel', entity: 'bookings', entityId: id, before, after: { reason, refundAmount } });
}

export async function recordRefund(db, { id, amount, actorChatId }) {
  const before = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
  await db
    .prepare("UPDATE bookings SET refund_amount = refund_amount + ?, refunded_at = datetime('now'), payment_status='refunded', updated_at=datetime('now') WHERE id=?")
    .bind(amount, id)
    .run();
  await logAudit(db, { actorChatId, action: 'booking.refund', entity: 'bookings', entityId: id, before, after: { amount } });
}

export async function editBookingField(db, id, field, value, actorChatId) {
  const allowed = ['visit_date', 'visit_time', 'participants', 'meeting_point'];
  if (!allowed.includes(field)) throw new Error(`Field not editable: ${field}`);
  const before = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
  await db.prepare(`UPDATE bookings SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`).bind(value, id).run();
  if (field === 'visit_date' || field === 'visit_time') {
    const updated = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
    await rescheduleRemindersForBookingChange(db, updated);
  }
  await logAudit(db, { actorChatId, action: 'booking.edit', entity: 'bookings', entityId: id, before, after: { [field]: value } });
}

export async function setBookingGuide(db, id, guideId, { actorChatId, statusOverride } = {}) {
  const before = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
  await db
    .prepare(
      `UPDATE bookings SET guide_id = ?, booking_status = COALESCE(?, 'assigned'), guide_accept_status = 'pending',
       decline_reason = NULL, updated_at = datetime('now') WHERE id = ?`
    )
    .bind(guideId, statusOverride ?? null, id)
    .run();
  const updated = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
  const newGuide = await db.prepare('SELECT * FROM guides WHERE id = ?').bind(guideId).first();
  await rescheduleRemindersForNewGuide(db, updated, newGuide, before?.guide_id || null);
  await logAudit(db, { actorChatId, action: before?.guide_id ? 'booking.reassign_guide' : 'booking.assign_guide', entity: 'bookings', entityId: id, before, after: { guideId } });
}

export async function setGuideAcceptStatus(db, id, status, { declineReason, actorChatId } = {}) {
  const bookingStatus = status === 'accepted' ? 'guide_accepted' : status === 'declined' ? 'guide_required' : 'assigned';
  const guideIdClear = status === 'declined' ? null : undefined;
  if (guideIdClear === null) {
    const before = await db.prepare('SELECT guide_id FROM bookings WHERE id = ?').bind(id).first();
    await db
      .prepare("UPDATE bookings SET guide_accept_status=?, decline_reason=?, guide_id=NULL, booking_status=?, updated_at=datetime('now') WHERE id=?")
      .bind(status, declineReason ?? null, bookingStatus, id)
      .run();
    if (before?.guide_id) await cancelRemindersForBooking(db, id, before.guide_id);
  } else {
    await db
      .prepare("UPDATE bookings SET guide_accept_status=?, booking_status=?, updated_at=datetime('now') WHERE id=?")
      .bind(status, bookingStatus, id)
      .run();
  }
  await logAudit(db, { actorChatId, action: `booking.guide_${status}`, entity: 'bookings', entityId: id, after: { declineReason } });
}

export async function markBookingStarted(db, id, actorChatId) {
  await db.prepare("UPDATE bookings SET booking_status='in_progress', started_at=datetime('now'), updated_at=datetime('now') WHERE id=?").bind(id).run();
  await logAudit(db, { actorChatId, action: 'booking.started', entity: 'bookings', entityId: id });
}

export async function markBookingCompleted(db, id, actorChatId) {
  await db.prepare("UPDATE bookings SET booking_status='completed', completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?").bind(id).run();
  await cancelRemindersForBooking(db, id);
  await logAudit(db, { actorChatId, action: 'booking.completed', entity: 'bookings', entityId: id });
}

// ---- Reminders (spec: 24h/2h/30m before, reschedule/reassign/cancel-safe) ----

const REMINDER_OFFSETS = { '24h': 24 * 60 * 60 * 1000, '2h': 2 * 60 * 60 * 1000, '30m': 30 * 60 * 1000 };

export async function scheduleRemindersForBooking(db, booking, guide) {
  if (!guide) return;
  const visitDateTime = new Date(`${booking.visit_date}T${booking.visit_time || '09:00'}:00`);
  if (Number.isNaN(visitDateTime.getTime())) return;

  const enabled = {
    '24h': guide.reminder_24h !== 0,
    '2h': guide.reminder_2h !== 0,
    '30m': guide.reminder_30m !== 0,
  };

  for (const kind of Object.keys(REMINDER_OFFSETS)) {
    if (!enabled[kind]) continue;
    const scheduledFor = new Date(visitDateTime.getTime() - REMINDER_OFFSETS[kind]);
    if (scheduledFor.getTime() <= Date.now()) continue; // don't schedule reminders already in the past
    const existing = await db
      .prepare('SELECT id FROM reminders WHERE booking_id = ? AND guide_id = ? AND kind = ?')
      .bind(booking.id, guide.id, kind)
      .first();
    if (existing) continue; // dedupe — never insert the same reminder twice
    await db
      .prepare('INSERT INTO reminders (booking_id, guide_id, kind, scheduled_for) VALUES (?, ?, ?, ?)')
      .bind(booking.id, guide.id, kind, scheduledFor.toISOString())
      .run();
  }
}

// Cancels any not-yet-sent reminders for a booking — used on cancellation,
// completion, reassignment (before scheduling fresh ones), and reschedule.
export async function cancelRemindersForBooking(db, bookingId, guideId) {
  if (guideId) {
    await db.prepare('DELETE FROM reminders WHERE booking_id = ? AND guide_id = ? AND sent = 0').bind(bookingId, guideId).run();
  } else {
    await db.prepare('DELETE FROM reminders WHERE booking_id = ? AND sent = 0').bind(bookingId).run();
  }
}

// Guide reassigned (manual, or after a decline): drop the old guide's
// pending reminders and schedule fresh ones for the new guide.
export async function rescheduleRemindersForNewGuide(db, booking, newGuide, oldGuideId) {
  await cancelRemindersForBooking(db, booking.id, oldGuideId);
  await scheduleRemindersForBooking(db, booking, newGuide);
}

// Booking's date/time changed: wipe and recompute for whichever guide is
// currently assigned.
export async function rescheduleRemindersForBookingChange(db, booking) {
  if (!booking.guide_id) return;
  await cancelRemindersForBooking(db, booking.id, booking.guide_id);
  const guide = await db.prepare('SELECT * FROM guides WHERE id = ?').bind(booking.guide_id).first();
  await scheduleRemindersForBooking(db, booking, guide);
}

// ---- My Tours (guide-side read-only view of assigned packages/services) ----

export async function getEligiblePackagesForGuide(db, guide) {
  const scope = JSON.parse(guide.eligible_scope || '{}');
  const packages = scope.all
    ? (await db.prepare('SELECT * FROM packages WHERE active = 1 ORDER BY sort_order').all()).results
    : (
        await db
          .prepare(`SELECT * FROM packages WHERE active = 1 AND id IN (${(scope.packages || []).map(() => '?').join(',') || 'NULL'}) ORDER BY sort_order`)
          .bind(...(scope.packages || []))
          .all()
      ).results;

  for (const p of packages) {
    p.services = (await db.prepare('SELECT name, price FROM services WHERE package_id = ? AND active = 1 ORDER BY sort_order').bind(p.id).all()).results;
  }
  return packages;
}

// ---- Guests (guide-side, contact-only view across their active bookings) ----

export async function listGuestsForGuide(db, guideId) {
  return (
    await db
      .prepare(
        `SELECT DISTINCT v.id, v.name, v.phone, v.email, b.id AS booking_id, b.booking_code, b.visit_date
         FROM bookings b JOIN visitors v ON v.id = b.visitor_id
         WHERE b.guide_id = ? AND b.booking_status NOT IN ('cancelled','rejected')
         ORDER BY b.visit_date ASC`
      )
      .bind(guideId)
      .all()
  ).results;
}

// ---- Guide self-service settings ----

export async function setGuidePin(db, guideId, pin) {
  await db.prepare('UPDATE guides SET pin = ? WHERE id = ?').bind(pin, guideId).run();
}

export async function setGuideNotifyPref(db, guideId, field, value) {
  const allowed = ['notify_new_booking', 'reminder_24h', 'reminder_2h', 'reminder_30m'];
  if (!allowed.includes(field)) throw new Error(`Not a valid preference: ${field}`);
  await db.prepare(`UPDATE guides SET ${field} = ? WHERE id = ?`).bind(value ? 1 : 0, guideId).run();
}

export async function logoutGuide(db, guideId) {
  await db.prepare('UPDATE guides SET telegram_chat_id = NULL WHERE id = ?').bind(guideId).run();
}

export async function listGuides(db, { includeRemoved = false } = {}) {
  const q = includeRemoved ? 'SELECT * FROM guides ORDER BY name' : 'SELECT * FROM guides WHERE access_removed = 0 ORDER BY name';
  return (await db.prepare(q).all()).results;
}

export async function searchGuides(db, term) {
  const like = `%${term}%`;
  return (await db.prepare('SELECT * FROM guides WHERE name LIKE ? OR phone LIKE ? ORDER BY name').bind(like, like).all()).results;
}

export async function getGuide(db, id) {
  return db.prepare('SELECT * FROM guides WHERE id = ?').bind(id).first();
}

export async function createGuideProfile(db, { name, phone, email, scope }, actorChatId) {
  const res = await db
    .prepare('INSERT INTO guides (name, phone, eligible_scope, status) VALUES (?, ?, ?, ?)')
    .bind(name, phone ?? null, JSON.stringify(scope ?? { all: false, packages: [] }), 'active')
    .run();
  const id = res.meta.last_row_id;
  await logAudit(db, { actorChatId, action: 'guide.create', entity: 'guides', entityId: id, after: { name, phone, scope } });
  return id;
}

export async function setGuideStatus(db, id, status, actorChatId) {
  const before = await getGuide(db, id);
  await db.prepare("UPDATE guides SET status = ? WHERE id = ?").bind(status, id).run();
  await logAudit(db, { actorChatId, action: status === 'active' ? 'guide.enable' : 'guide.disable', entity: 'guides', entityId: id, before });
}

export async function setGuideAvailable(db, id, available) {
  await db.prepare('UPDATE guides SET available = ? WHERE id = ?').bind(available ? 1 : 0, id).run();
}

export async function removeGuideAccess(db, id, { reassignBookingsToGuideId, actorChatId }) {
  const before = await getGuide(db, id);
  await db.prepare('UPDATE guides SET access_removed = 1, status = ? WHERE id = ?').bind('inactive', id).run();

  if (reassignBookingsToGuideId) {
    await db
      .prepare("UPDATE bookings SET guide_id = ?, guide_accept_status = 'pending', updated_at = datetime('now') WHERE guide_id = ? AND booking_status NOT IN ('cancelled','rejected','completed')")
      .bind(reassignBookingsToGuideId, id)
      .run();
  } else {
    await db
      .prepare("UPDATE bookings SET guide_id = NULL, booking_status = 'guide_required', guide_accept_status = NULL, updated_at = datetime('now') WHERE guide_id = ? AND booking_status NOT IN ('cancelled','rejected','completed')")
      .bind(id)
      .run();
  }
  await logAudit(db, { actorChatId, action: 'guide.remove', entity: 'guides', entityId: id, before, after: { reassignBookingsToGuideId } });
}

// Resets guide state WITHOUT touching historical bookings/payments/audit logs.
export async function resetGuideAccount(db, id, { unlinkTelegram = true, actorChatId }) {
  const before = await getGuide(db, id);
  if (unlinkTelegram) {
    await db.prepare('UPDATE guides SET telegram_chat_id = NULL WHERE id = ?').bind(id).run();
  }
  await logAudit(db, { actorChatId, action: 'guide.reset', entity: 'guides', entityId: id, before, after: { unlinkTelegram } });
}

export async function generateGuideCodeFor(db, { code, scope, guideNameHint, expiresAt, guideId }) {
  await db
    .prepare('INSERT INTO guide_codes (code, scope, guide_name_hint, expires_at, guide_id) VALUES (?, ?, ?, ?, ?)')
    .bind(code, JSON.stringify(scope ?? { all: false }), guideNameHint ?? null, expiresAt ?? null, guideId ?? null)
    .run();
}

export async function getGuideWorkload(db, guideId) {
  const today = (
    await db.prepare("SELECT COUNT(*) AS c FROM bookings WHERE guide_id = ? AND date(visit_date) = date('now') AND booking_status NOT IN ('cancelled','rejected')").bind(guideId).first()
  ).c;
  const upcoming = (
    await db.prepare("SELECT COUNT(*) AS c FROM bookings WHERE guide_id = ? AND date(visit_date) >= date('now') AND booking_status NOT IN ('cancelled','rejected','completed')").bind(guideId).first()
  ).c;
  const total = (await db.prepare('SELECT COUNT(*) AS c FROM bookings WHERE guide_id = ?').bind(guideId).first()).c;
  return { today, upcoming, total };
}

// ---- Guide availability schedule (spec section 19) ----

export async function setGuideScheduleDay(db, guideId, dayOfWeek, { available, startTime, endTime }) {
  await db
    .prepare(
      `INSERT INTO guide_schedule (guide_id, day_of_week, available, start_time, end_time) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(guide_id, day_of_week) DO UPDATE SET available=excluded.available, start_time=excluded.start_time, end_time=excluded.end_time`
    )
    .bind(guideId, dayOfWeek, available ? 1 : 0, startTime ?? null, endTime ?? null)
    .run();
}

export async function getGuideSchedule(db, guideId) {
  return (await db.prepare('SELECT * FROM guide_schedule WHERE guide_id = ? ORDER BY day_of_week').bind(guideId).all()).results;
}

// ---- Discounts: edit/remove/scheduling/usage (spec section 6) ----

export async function listDiscountsGrouped(db) {
  const rows = (await db.prepare('SELECT * FROM discounts ORDER BY id DESC').all()).results;
  const parsed = rows.map((r) => ({ ...r, applies_to: JSON.parse(r.applies_to) }));
  const now = new Date().toISOString().slice(0, 10);
  return {
    active: parsed.filter((d) => d.active && (!d.end_date || d.end_date >= now) && (!d.start_date || d.start_date <= now)),
    scheduled: parsed.filter((d) => d.active && d.start_date && d.start_date > now),
    expired: parsed.filter((d) => !d.active || (d.end_date && d.end_date < now)),
  };
}

export async function getDiscount(db, id) {
  const r = await db.prepare('SELECT * FROM discounts WHERE id = ?').bind(id).first();
  return r ? { ...r, applies_to: JSON.parse(r.applies_to) } : null;
}

export async function editDiscountField(db, id, field, value, actorChatId) {
  const allowed = ['label', 'percent', 'coupon_code', 'start_date', 'end_date', 'max_usage', 'min_booking_amount', 'active'];
  if (!allowed.includes(field)) throw new Error(`Field not editable: ${field}`);
  const before = await getDiscount(db, id);
  await db.prepare(`UPDATE discounts SET ${field} = ? WHERE id = ?`).bind(value, id).run();
  await logAudit(db, { actorChatId, action: 'discount.edit', entity: 'discounts', entityId: id, before, after: { [field]: value } });
}

export async function removeDiscount(db, id, actorChatId) {
  const before = await getDiscount(db, id);
  await db.prepare('UPDATE discounts SET active = 0 WHERE id = ?').bind(id).run();
  await logAudit(db, { actorChatId, action: 'discount.remove', entity: 'discounts', entityId: id, before });
}

export async function incrementDiscountUsage(db, id) {
  await db.prepare('UPDATE discounts SET used_count = used_count + 1 WHERE id = ?').bind(id).run();
}

// ---- Packages: edit/archive (spec section 5) ----

export async function editPackageField(db, id, field, value, actorChatId) {
  const allowed = ['name', 'description', 'base_price', 'active', 'highlighted'];
  if (!allowed.includes(field)) throw new Error(`Field not editable: ${field}`);
  const before = await db.prepare('SELECT * FROM packages WHERE id = ?').bind(id).first();
  await db.prepare(`UPDATE packages SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`).bind(value, id).run();
  await logAudit(db, { actorChatId, action: 'package.edit', entity: 'packages', entityId: id, before, after: { [field]: value } });
}

// Safe "remove": archives (active=0) rather than deleting, so historical
// bookings/payments referencing this package_id stay intact and auditable.
export async function archivePackage(db, id, actorChatId) {
  const before = await db.prepare('SELECT * FROM packages WHERE id = ?').bind(id).first();
  await db.prepare("UPDATE packages SET active = 0, updated_at = datetime('now') WHERE id = ?").bind(id).run();
  await logAudit(db, { actorChatId, action: 'package.archive', entity: 'packages', entityId: id, before });
}

// Restores a package's configuration to visible/active without touching any
// historical booking/payment rows that reference it.
export async function resetPackageConfig(db, id, actorChatId) {
  const before = await db.prepare('SELECT * FROM packages WHERE id = ?').bind(id).first();
  await db.prepare("UPDATE packages SET active = 1, updated_at = datetime('now') WHERE id = ?").bind(id).run();
  await logAudit(db, { actorChatId, action: 'package.reset', entity: 'packages', entityId: id, before });
}

// ---- Site settings (⚙️ Settings menu) ----

export async function getSiteSettings(db) {
  return db.prepare('SELECT * FROM site_settings WHERE id = 1').first();
}

export async function setSiteEnabled(db, enabled, actorChatId) {
  await db.prepare("UPDATE site_settings SET site_enabled = ?, updated_at = datetime('now') WHERE id = 1").bind(enabled ? 1 : 0).run();
  await logAudit(db, { actorChatId, action: enabled ? 'site.enable' : 'site.disable', entity: 'site_settings', entityId: 1 });
}

export async function setMinAdvanceAmount(db, amount, actorChatId) {
  await db.prepare("UPDATE payment_settings SET min_advance_amount = ?, updated_at = datetime('now') WHERE id = 1").bind(amount).run();
  await logAudit(db, { actorChatId, action: 'settings.min_advance', entity: 'payment_settings', entityId: 1, after: { amount } });
}

// ---- Analytics (📊 Dashboard/Analytics — spec sections 3 & 25) ----

export async function getDashboardStats(db) {
  const q = (sql) => db.prepare(sql).first();
  const [today, upcoming, confirmed, pending, cancelled, revenueToday, revenueMonth, pendingPayments, activeGuides, actionRequired] = await Promise.all([
    q("SELECT COUNT(*) AS c FROM bookings WHERE date(visit_date) = date('now') AND booking_status NOT IN ('cancelled','rejected')"),
    q("SELECT COUNT(*) AS c FROM bookings WHERE date(visit_date) > date('now') AND booking_status NOT IN ('cancelled','rejected','completed')"),
    q("SELECT COUNT(*) AS c FROM bookings WHERE booking_status IN ('confirmed','assigned','guide_accepted','in_progress')"),
    q("SELECT COUNT(*) AS c FROM bookings WHERE payment_status IN ('pending','awaiting_verification','partial')"),
    q("SELECT COUNT(*) AS c FROM bookings WHERE booking_status IN ('cancelled','rejected')"),
    q("SELECT COALESCE(SUM(amount_paid_total),0) AS s FROM bookings WHERE date(updated_at) = date('now') AND payment_status IN ('verified','partial')"),
    q("SELECT COALESCE(SUM(amount_paid_total),0) AS s FROM bookings WHERE strftime('%Y-%m', updated_at) = strftime('%Y-%m','now') AND payment_status IN ('verified','partial')"),
    q("SELECT COUNT(*) AS c FROM bookings WHERE payment_status = 'awaiting_verification'"),
    q("SELECT COUNT(*) AS c FROM guides WHERE status='active' AND access_removed=0"),
    q("SELECT COUNT(*) AS c FROM bookings WHERE booking_status = 'guide_required'"),
  ]);
  return {
    today: today.c, upcoming: upcoming.c, confirmed: confirmed.c, pending: pending.c, cancelled: cancelled.c,
    revenueToday: revenueToday.s, revenueMonth: revenueMonth.s, pendingPayments: pendingPayments.c,
    activeGuides: activeGuides.c, actionRequired: actionRequired.c,
  };
}

export async function getRevenueAnalytics(db) {
  return (
    await db
      .prepare(
        `SELECT strftime('%Y-%m-%d', updated_at) AS day, SUM(amount_paid_total) AS revenue
         FROM bookings WHERE payment_status IN ('verified','partial') AND updated_at >= datetime('now','-14 days')
         GROUP BY day ORDER BY day DESC`
      )
      .all()
  ).results;
}

export async function getPackagePerformance(db) {
  return (
    await db
      .prepare(
        `SELECT p.name, COUNT(b.id) AS bookings, COALESCE(SUM(b.amount_paid_total),0) AS revenue
         FROM packages p LEFT JOIN bookings b ON b.package_id = p.id AND b.booking_status NOT IN ('cancelled','rejected')
         GROUP BY p.id ORDER BY revenue DESC`
      )
      .all()
  ).results;
}

export async function getGuidePerformance(db) {
  return (
    await db
      .prepare(
        `SELECT g.name,
           COUNT(b.id) AS assigned,
           SUM(CASE WHEN b.booking_status='completed' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN b.guide_accept_status='declined' THEN 1 ELSE 0 END) AS declined
         FROM guides g LEFT JOIN bookings b ON b.guide_id = g.id
         GROUP BY g.id ORDER BY completed DESC`
      )
      .all()
  ).results;
}

export async function getPaymentAnalytics(db) {
  return db
    .prepare(
      `SELECT
         SUM(CASE WHEN status='payment.captured' THEN amount ELSE 0 END) AS captured,
         SUM(CASE WHEN status='payment.failed' THEN amount ELSE 0 END) AS failed_amount,
         COUNT(CASE WHEN status='payment.failed' THEN 1 END) AS failed_count,
         COUNT(*) AS total_events
       FROM payments`
    )
    .first();
}

export async function getDiscountUsageReport(db) {
  return (await db.prepare('SELECT label, percent, used_count, max_usage, active FROM discounts ORDER BY used_count DESC').all()).results;
}
