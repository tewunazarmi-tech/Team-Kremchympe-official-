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

export async function upsertContent(db, { section, key, value, contentType, visible, highlighted, sortOrder, actorChatId }) {
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

export async function updateBookingStatus(db, bookingId, { paymentStatus, bookingStatus, razorpayOrderId, razorpayPaymentId, guideId, receiptFileId }) {
  await db
    .prepare(
      `UPDATE bookings SET
         payment_status = COALESCE(?, payment_status),
         booking_status = COALESCE(?, booking_status),
         razorpay_order_id = COALESCE(?, razorpay_order_id),
         razorpay_payment_id = COALESCE(?, razorpay_payment_id),
         guide_id = COALESCE(?, guide_id),
         receipt_file_id = COALESCE(?, receipt_file_id),
         updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(paymentStatus ?? null, bookingStatus ?? null, razorpayOrderId ?? null, razorpayPaymentId ?? null, guideId ?? null, receiptFileId ?? null, bookingId)
    .run();
}
