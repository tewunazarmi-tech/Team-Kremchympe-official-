import { sendMessage, inlineKeyboard, answerCallback } from '../telegram.js';
import { redeemGuideCode } from '../auth.js';
import {
  getSession, setSession, clearSession,
  listBookingsForGuide, searchBookingsForGuide, getBookingFull, setGuideAcceptStatus,
  markBookingStarted, markBookingCompleted, setGuideAvailable, getGuideSchedule, setGuideScheduleDay,
  getGuide, getGuideWorkload, getEligiblePackagesForGuide, listGuestsForGuide,
  setGuidePin, setGuideNotifyPref, logoutGuide,
} from '../db.js';
import { reassignAfterDecline } from '../booking.js';

const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

function back(to = 'g:menu') {
  return [{ text: '⬅️ Back', callback_data: to }, { text: '🏠 Home', callback_data: 'g:menu' }];
}

function bookingStatusBadge(s) {
  return {
    pending: '🟡', confirmed: '🔵', guide_required: '🟠', assigned: '🔵', guide_accepted: '🟢',
    in_progress: '🚶', completed: '🏁', cancelled: '❌', rejected: '❌',
  }[s] || '⚪';
}

function guideMenu() {
  return inlineKeyboard([
    [{ text: '📊 Dashboard', callback_data: 'g:dashboard' }, { text: "📅 Today's Bookings", callback_data: 'g:today' }],
    [{ text: '🗓️ Future Bookings', callback_data: 'g:future' }, { text: '📋 All Bookings', callback_data: 'g:all' }],
    [{ text: '👤 Guests', callback_data: 'g:guests' }, { text: '🗺️ My Tours', callback_data: 'g:mytours' }],
    [{ text: '🟢 Availability', callback_data: 'g:avail' }, { text: '⚙️ Guide Settings', callback_data: 'g:settings' }],
    [{ text: 'ℹ️ What do these do?', callback_data: 'g:help' }],
  ]);
}

// =====================================================================
// MESSAGES
// =====================================================================

export async function handleGuideOrUnknownMessage(env, db, chatId, text, sender) {
  const trimmed = text.trim();

  // Looks like a guide code (XXXX-XXXX format from randomGuideCode)
  if (/^[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(trimmed)) {
    const result = await redeemGuideCode(db, trimmed.toUpperCase(), chatId, null);
    if (result.ok) {
      return sendMessage(env, chatId, '✅ Guide Account Activated!\n\n👥 <b>Guide Menu</b>', { keyboard: guideMenu() });
    }
    const reasons = { not_found: 'That code was not found.', already_used: 'That code has already been used.', expired: 'That code has expired.' };
    return sendMessage(env, chatId, `❌ ${reasons[result.reason] || 'Could not activate that code.'}`);
  }

  if (sender.type === 'guide') {
    const session = await getSession(db, chatId);
    if (session && GUIDE_TEXT_FLOWS[session.flow]) {
      return GUIDE_TEXT_FLOWS[session.flow](env, db, chatId, text, session, sender.guide);
    }
    if (trimmed === '/start' || trimmed === '/menu') {
      await clearSession(db, chatId);
      return sendMessage(env, chatId, `👋 Welcome back, ${sender.guide.name}.`, { keyboard: guideMenu() });
    }
    return sendMessage(env, chatId, 'Use /menu to see your dashboard.');
  }

  return sendMessage(env, chatId, '👋 Welcome Guide.\n\nPlease enter your Guide Code to activate your account.');
}

async function continueSearchBooking(env, db, chatId, text, session, guide) {
  const rows = await searchBookingsForGuide(db, guide.id, text.trim());
  await clearSession(db, chatId);
  if (rows.length === 0) return sendMessage(env, chatId, 'No matching bookings found.', { keyboard: inlineKeyboard([back()]) });
  const buttons = rows.map((b) => [{ text: `${bookingStatusBadge(b.booking_status)} ${b.booking_code} — ${b.visit_date}`, callback_data: `g:view:${b.id}` }]);
  return sendMessage(env, chatId, `🔎 <b>Results</b> (${rows.length})`, { keyboard: inlineKeyboard([...buttons, back()]) });
}

async function continueDeclineReason(env, db, chatId, text, session, guide) {
  const bookingId = session.data.id;
  await setGuideAcceptStatus(db, bookingId, 'declined', { declineReason: text.trim(), actorChatId: chatId });
  await clearSession(db, chatId);
  const booking = await getBookingFull(db, bookingId);
  await reassignAfterDecline(env, db, booking, guide.id);
  return sendMessage(env, chatId, '❌ Booking declined. We\'ve tried to find another guide — thanks for letting us know.', { keyboard: inlineKeyboard([back()]) });
}

async function continueScheduleTime(env, db, chatId, text, session) {
  const { dayOfWeek } = session.data;
  const match = text.trim().match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (!match) return sendMessage(env, chatId, 'Please send a time range like "09:00 - 18:00", or send "off" to mark the day unavailable.');
  await setGuideScheduleDay(db, session.data.guideId, dayOfWeek, { available: true, startTime: match[1], endTime: match[2] });
  await clearSession(db, chatId);
  return sendMessage(env, chatId, `✅ ${DAYS[dayOfWeek]}: 🟢 Available ${match[1]} - ${match[2]}`, { keyboard: inlineKeyboard([back('g:avail:schedule')]) });
}

const GUIDE_TEXT_FLOWS = {
  guide_search_booking: continueSearchBooking,
  guide_decline_reason: continueDeclineReason,
  guide_schedule_time: continueScheduleTime,
  guide_set_pin: continueSetPin,
};

// =====================================================================
// CALLBACKS
// =====================================================================

export async function handleGuideCallback(env, db, chatId, data, guide, callbackQueryId) {
  if (callbackQueryId) await answerCallback(env, callbackQueryId, '');

  if (data === 'g:menu') return sendMessage(env, chatId, '👥 <b>Guide Menu</b>', { keyboard: guideMenu() });

  if (data === 'g:dashboard' || data === 'g:refresh:dashboard') return showDashboard(env, db, chatId, guide);
  if (data === 'g:today' || data === 'g:refresh:today') return showBookingList(env, db, chatId, guide, 'today');
  if (data === 'g:future' || data === 'g:refresh:future') return showFutureBookings(env, db, chatId, guide);
  if (data === 'g:all') return showAllBookingsFilters(env, chatId);
  if (data.startsWith('g:all:')) return showBookingList(env, db, chatId, guide, data.split(':')[2]);
  if (data === 'g:search') {
    await setSession(db, chatId, 'guide_search_booking', 'awaiting_term', {});
    return sendMessage(env, chatId, '🔎 Send a booking code or customer name:');
  }
  if (data === 'g:guests' || data === 'g:refresh:guests') return showGuests(env, db, chatId, guide);
  if (data === 'g:mytours' || data === 'g:refresh:mytours') return showMyTours(env, db, chatId, guide);
  if (data === 'g:help') return showHelp(env, chatId);

  if (data.startsWith('g:view:')) return showBookingDetail(env, db, chatId, guide, parseInt(data.split(':')[2], 10));
  if (data.startsWith('g:viewfull:')) {
    const id = parseInt(data.split(':')[2], 10);
    const b = await getBookingFull(db, id);
    if (!b || b.guide_id !== guide.id) return sendMessage(env, chatId, 'Booking not found.', { keyboard: inlineKeyboard([back()]) });
    const detailedText = await generateDetailedBookingMessage(db, b);
    return sendMessage(env, chatId, detailedText, { keyboard: inlineKeyboard([back(`g:view:${id}`)]) });
  }

  // Accept / decline a new assignment
  if (data.startsWith('g:accept:')) return doAccept(env, db, chatId, guide, parseInt(data.split(':')[2], 10));
  if (data.startsWith('g:decline:')) {
    const id = parseInt(data.split(':')[2], 10);
    await setSession(db, chatId, 'guide_decline_reason', 'awaiting_reason', { id });
    return sendMessage(env, chatId, '❌ Please send a short reason for declining this booking:');
  }

  // In-progress actions
  if (data.startsWith('g:started:')) {
    const id = parseInt(data.split(':')[2], 10);
    await markBookingStarted(db, id, chatId);
    return sendMessage(env, chatId, '✅ Marked as started.', { keyboard: inlineKeyboard([back(`g:view:${id}`)]) });
  }
  if (data.startsWith('g:completed:')) {
    const id = parseInt(data.split(':')[2], 10);
    await markBookingCompleted(db, id, chatId);
    return sendMessage(env, chatId, '🏁 Marked as completed.', { keyboard: inlineKeyboard([back(`g:view:${id}`)]) });
  }
  if (data.startsWith('g:contact:')) {
    const id = parseInt(data.split(':')[2], 10);
    const b = await getBookingFull(db, id);
    return sendMessage(env, chatId, `📞 <b>${b.visitor_name}</b>\n${b.visitor_phone}${b.visitor_email ? `\n${b.visitor_email}` : ''}`, { keyboard: inlineKeyboard([back(`g:view:${id}`)]) });
  }

  // Availability
  if (data === 'g:avail') return showAvailabilityMenu(env, db, chatId, guide);
  if (data === 'g:avail:toggle_on' || data === 'g:avail:toggle_off') {
    await setGuideAvailable(db, guide.id, data.endsWith('on'));
    return showAvailabilityMenu(env, db, chatId, guide);
  }
  if (data === 'g:avail:schedule') return showScheduleMenu(env, db, chatId, guide);
  if (data.startsWith('g:avail:day:')) return showScheduleDayOptions(env, chatId, guide.id, parseInt(data.split(':')[3], 10));
  if (data.startsWith('g:avail:setoff:')) {
    const dayOfWeek = parseInt(data.split(':')[3], 10);
    await setGuideScheduleDay(db, guide.id, dayOfWeek, { available: false });
    return sendMessage(env, chatId, `✅ ${DAYS[dayOfWeek]}: 🔴 Unavailable`, { keyboard: inlineKeyboard([back('g:avail:schedule')]) });
  }
  if (data.startsWith('g:avail:settime:')) {
    const dayOfWeek = parseInt(data.split(':')[3], 10);
    await setSession(db, chatId, 'guide_schedule_time', 'awaiting_time', { dayOfWeek, guideId: guide.id });
    return sendMessage(env, chatId, `Send available hours for ${DAYS[dayOfWeek]} as "09:00 - 18:00":`);
  }

  if (data === 'g:profile') return showProfile(env, db, chatId, guide);
  if (data === 'g:settings') return showSettings(env, chatId, guide);
  if (data === 'g:relink') {
    await db.prepare('UPDATE guides SET telegram_chat_id = NULL WHERE id = ?').bind(guide.id).run();
    return sendMessage(env, chatId, '🔑 Your Telegram connection has been unlinked. Ask an admin for a fresh Guide Code, then send it here to relink.');
  }
  if (data === 'g:logout') {
    await logoutGuide(db, guide.id);
    return sendMessage(env, chatId, '👋 You have been logged out. Send your Guide Code any time to log back in.');
  }
  if (data === 'g:setpin') {
    await setSession(db, chatId, 'guide_set_pin', 'awaiting_pin', {});
    return sendMessage(env, chatId, '🔐 Send a new 4–6 digit PIN:');
  }
  if (data === 'g:notifprefs') return showNotificationPrefs(env, chatId, guide);
  if (data.startsWith('g:notiftoggle:')) {
    const field = data.split(':')[2];
    await setGuideNotifyPref(db, guide.id, field, !guide[field]);
    const updated = await getGuide(db, guide.id);
    return showNotificationPrefs(env, chatId, updated);
  }
  if (data === 'g:cancel') {
    await clearSession(db, chatId);
    return sendMessage(env, chatId, '❎ Cancelled.', { keyboard: guideMenu() });
  }

  return sendMessage(env, chatId, 'Unknown option.');
}

// =====================================================================

async function showDashboard(env, db, chatId, guide) {
  const workload = await getGuideWorkload(db, guide.id);
  const rows = await listBookingsForGuide(db, guide.id, 'future', { limit: 1 });
  const next = rows[0];
  const text =
    `👥 <b>GUIDE DASHBOARD</b>\n\n👤 ${guide.name}\n\n` +
    `📅 Today: ${workload.today} bookings\n📆 Upcoming: ${workload.upcoming}\n📋 Total: ${workload.total}\n\n` +
    (next
      ? `Next Booking:\n${next.visit_date}\n${next.package_name || ''}\n👥 ${next.participants} Guests\n\nStatus: ${bookingStatusBadge(next.booking_status)} ${next.booking_status}`
      : '(no upcoming bookings)') +
    `\n\nAvailability: ${guide.available ? '🟢 Available' : '🔴 Unavailable'}`;
  return sendMessage(env, chatId, text, { keyboard: inlineKeyboard([[{ text: '🔄 Refresh', callback_data: 'g:refresh:dashboard' }], back()]) });
}

async function showBookingList(env, db, chatId, guide, filter) {
  const rows = await listBookingsForGuide(db, guide.id, filter);
  const refreshData = filter === 'today' ? 'g:refresh:today' : `g:all:${filter}`;
  if (rows.length === 0) return sendMessage(env, chatId, 'No bookings.', { keyboard: inlineKeyboard([[{ text: '🔄 Refresh', callback_data: refreshData }], back()]) });
  const buttons = rows.map((b) => [{ text: `${bookingStatusBadge(b.booking_status)} ${b.booking_code} — ${b.visit_date}`, callback_data: `g:view:${b.id}` }]);
  return sendMessage(env, chatId, `📅 <b>Bookings</b> (${rows.length})`, { keyboard: inlineKeyboard([...buttons, [{ text: '🔄 Refresh', callback_data: refreshData }], back()]) });
}

async function showFutureBookings(env, db, chatId, guide) {
  const rows = await listBookingsForGuide(db, guide.id, 'future', { limit: 30 });
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const groups = { Today: [], Tomorrow: [], 'This Week': [], Later: [] };
  const weekOut = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  for (const b of rows) {
    if (b.visit_date === today) groups.Today.push(b);
    else if (b.visit_date === tomorrow) groups.Tomorrow.push(b);
    else if (b.visit_date <= weekOut) groups['This Week'].push(b);
    else groups.Later.push(b);
  }
  const lines = Object.entries(groups)
    .filter(([, list]) => list.length)
    .map(([label, list]) => `<b>${label}</b>\n${list.map((b) => `${bookingStatusBadge(b.booking_status)} ${b.booking_code} — ${b.visit_date}`).join('\n')}`);
  const buttons = rows.slice(0, 12).map((b) => [{ text: `${b.booking_code}`, callback_data: `g:view:${b.id}` }]);
  return sendMessage(env, chatId, `📆 <b>Future Bookings</b>\n\n${lines.join('\n\n') || '(none)'}`, { keyboard: inlineKeyboard([...buttons, [{ text: '🔄 Refresh', callback_data: 'g:refresh:future' }], back()]) });
}

function showAllBookingsFilters(env, chatId) {
  return sendMessage(env, chatId, '📋 <b>All My Bookings</b> — filter:', {
    keyboard: inlineKeyboard([
      [{ text: '🟢 Confirmed', callback_data: 'g:all:confirmed' }, { text: '🟡 Pending', callback_data: 'g:all:pending' }],
      [{ text: '🏁 Completed', callback_data: 'g:all:completed' }, { text: '❌ Cancelled', callback_data: 'g:all:cancelled' }],
      [{ text: '🔎 Search', callback_data: 'g:search' }],
      back(),
    ]),
  });
}

async function generateDetailedBookingMessage(db, b) {
  // Fetch all services to get their names and details
  const allServices = (await db.prepare('SELECT * FROM services WHERE active = 1').all()).results;
  const serviceMap = {};
  allServices.forEach(s => { serviceMap[s.id] = s; });

  // Parse selected services from JSON
  let selected = [];
  try {
    selected = JSON.parse(b.selected_services || '[]');
  } catch (e) {
    selected = [];
  }

  // Build the detailed message
  let message = `📋 <b>Booking Confirmation - Krem Chympe Adventure & Camping</b>\n\n`;
  message += `👤 Name: ${b.visitor_name || '?'}\n`;
  message += `📱 WhatsApp: ${b.visitor_phone || '?'}\n`;
  message += `📧 Email: ${b.visitor_email || '?'}\n`;
  message += `👥 Number of Persons: ${b.participants}\n`;
  message += `📅 Tour Date: ${b.visit_date}\n\n`;

  // Group services
  const adventureServices = [];
  const campingServices = [];
  const extraFoodServices = [];
  let lunchPackSelected = false;

  selected.forEach(sel => {
    const service = serviceMap[sel.serviceId];
    if (service) {
      const item = { name: service.name, price: service.price, qty: sel.qty };
      if (service.name.includes('Lunch') || service.name.includes('Thali')) {
        if (service.name.includes('Pack') || service.name.includes('packed')) {
          lunchPackSelected = true;
        } else {
          adventureServices.push(item);
        }
      } else if (service.name.includes('Tent') || service.name.includes('Camping') || service.name.includes('Overnight')) {
        campingServices.push(item);
      } else if (service.name.includes('Bamboo') || service.name.includes('Fish') || service.name.includes('Sabji') || service.name.includes('Egg') || service.name.includes('Chai')) {
        extraFoodServices.push(item);
      } else {
        adventureServices.push(item);
      }
    }
  });

  // Adventure section
  if (adventureServices.length > 0) {
    message += `━━━━━━━━━━━━━━\n🏞️ Adventure (Without Camping)\n━━━━━━━━━━━━━━\n\n`;
    let adventureTotal = 0;
    adventureServices.forEach(item => {
      const subtotal = item.price * item.qty;
      adventureTotal += subtotal;
      message += `• ${item.name}${item.qty > 1 ? ` x${item.qty}` : ''}: ₹${subtotal}\n`;
    });
    message += `\nAdventure Total: ${adventureTotal}\n\n`;
  }

  // Camping section
  if (campingServices.length > 0) {
    message += `━━━━━━━━━━━━━━\n🏕️ Camping\n━━━━━━━━━━━━━━\n\n`;
    let campingTotal = 0;
    campingServices.forEach(item => {
      const subtotal = item.price * item.qty;
      campingTotal += subtotal;
      message += `• ${item.name}${item.qty > 1 ? ` x${item.qty}` : ''}: ₹${subtotal}\n`;
    });
    message += `\nCamping Total: ${campingTotal}\n\n`;
  }

  // Extra Food section
  if (extraFoodServices.length > 0) {
    message += `━━━━━━━━━━━━━━\n🍽️ Extra Food Orders\n━━━━━━━━━━━━━━\n\n`;
    let foodTotal = 0;
    extraFoodServices.forEach(item => {
      const subtotal = item.price * item.qty;
      foodTotal += subtotal;
      message += `• ${item.name}${item.qty > 1 ? ` x${item.qty}` : ''}: ₹${subtotal}\n`;
    });
    message += `\nFood Total: ${foodTotal}\n\n`;
  }

  // Payment section
  message += `━━━━━━━━━━━━━━\n💳 Payment Summary\n━━━━━━━━━━━━━━\n\n`;
  message += `Grand Total: ₹${b.final_amount}\n`;
  message += `Amount Paid: ₹${b.amount_paid_total}\n`;
  message += `Amount Due: ₹${Math.max(0, b.final_amount - b.amount_paid_total)}\n`;
  message += `Payment Mode: ${b.payment_status}\n\n`;

  // LUNCH PACK AT THE BOTTOM
  if (lunchPackSelected) {
    message += `• Lunch Pack ✔️\n`;
  }

  return message;
}

async function showBookingDetail(env, db, chatId, guide, id) {
  const b = await getBookingFull(db, id);
  if (!b || b.guide_id !== guide.id) return sendMessage(env, chatId, 'Booking not found or not assigned to you.', { keyboard: inlineKeyboard([back()]) });
  
  // Generate detailed message
  const detailedText = await generateDetailedBookingMessage(db, b);
  
  const text =
    `📄 <b>${b.booking_code}</b>\n👤 ${b.visitor_name}\n📦 ${b.package_name || b.package_id}\n⏰ ${b.visit_date}\n👥 ${b.participants} Guests\n` +
    `${b.meeting_point ? `📍 ${b.meeting_point}\n` : ''}💳 Payment: ${b.payment_status}\n${bookingStatusBadge(b.booking_status)} Status: ${b.booking_status}`;

  const buttons = [];
  if (b.booking_status === 'assigned' && b.guide_accept_status === 'pending') {
    buttons.push([{ text: '✅ Accept', callback_data: `g:accept:${id}` }, { text: '❌ Decline', callback_data: `g:decline:${id}` }]);
  }
  if (['guide_accepted', 'assigned'].includes(b.booking_status)) buttons.push([{ text: '✅ Mark Started', callback_data: `g:started:${id}` }]);
  if (b.booking_status === 'in_progress') buttons.push([{ text: '🏁 Mark Completed', callback_data: `g:completed:${id}` }]);
  buttons.push([{ text: '📋 Full Details', callback_data: `g:viewfull:${id}` }]);
  buttons.push([{ text: '📞 Contact Customer', callback_data: `g:contact:${id}` }]);
  buttons.push(back());

  return sendMessage(env, chatId, text, { keyboard: inlineKeyboard(buttons) });
}

async function doAccept(env, db, chatId, guide, id) {
  await setGuideAcceptStatus(db, id, 'accepted', { actorChatId: chatId });
  const booking = await getBookingFull(db, id);
  const admins = (await db.prepare('SELECT telegram_chat_id FROM admin_users').all()).results;
  for (const a of admins) {
    await sendMessage(env, a.telegram_chat_id, `🟢 Guide ${guide.name} accepted booking <b>${booking.booking_code}</b>.`);
  }
  return sendMessage(env, chatId, '✅ Accepted. It now shows in your bookings.', { keyboard: inlineKeyboard([back(`g:view:${id}`)]) });
}

// ---- Availability (spec section 19) ----

async function showAvailabilityMenu(env, db, chatId, guide) {
  return sendMessage(env, chatId, `🟢 <b>Availability</b>\n\nOverall toggle: ${guide.available ? '🟢 Available' : '🔴 Unavailable'}`, {
    keyboard: inlineKeyboard([
      [{ text: '🟢 Set Available', callback_data: 'g:avail:toggle_on' }, { text: '🔴 Set Unavailable', callback_data: 'g:avail:toggle_off' }],
      [{ text: '📅 Weekly Schedule', callback_data: 'g:avail:schedule' }],
      back(),
    ]),
  });
}

async function showScheduleMenu(env, db, chatId, guide) {
  const schedule = await getGuideSchedule(db, guide.id);
  const byDay = Object.fromEntries(schedule.map((s) => [s.day_of_week, s]));
  const lines = DAYS.map((name, i) => {
    const s = byDay[i];
    if (!s) return `${name}\n(not set)`;
    return s.available ? `${name}\n🟢 Available ${s.start_time || ''} - ${s.end_time || ''}` : `${name}\n🔴 Unavailable`;
  });
  const buttons = DAYS.map((name, i) => [{ text: name.slice(0, 3), callback_data: `g:avail:day:${i}` }]);
  return sendMessage(env, chatId, lines.join('\n\n'), { keyboard: inlineKeyboard([...chunk(buttons, 4), back('g:avail')]) });
}

function chunk(rows, perRow) {
  const flat = rows.map((r) => r[0]);
  const out = [];
  for (let i = 0; i < flat.length; i += perRow) out.push(flat.slice(i, i + perRow));
  return out;
}

function showScheduleDayOptions(env, chatId, guideId, dayOfWeek) {
  return sendMessage(env, chatId, `${DAYS[dayOfWeek]} — set availability:`, {
    keyboard: inlineKeyboard([
      [{ text: '🟢 Set hours', callback_data: `g:avail:settime:${dayOfWeek}` }],
      [{ text: '🔴 Mark unavailable', callback_data: `g:avail:setoff:${dayOfWeek}` }],
      back('g:avail:schedule'),
    ]),
  });
}

// ---- Profile / Settings ----

async function showProfile(env, db, chatId, guide) {
  const scope = JSON.parse(guide.eligible_scope || '{}');
  const text =
    `👤 <b>${guide.name}</b>\n📞 ${guide.phone || '(none)'}\n` +
    `Status: ${guide.status === 'active' ? '🟢 Active' : '🔴 Disabled'}\n` +
    `Eligible for: ${scope.all ? 'All services' : (scope.packages || []).join(', ') || '(none)'}\n` +
    `Max bookings/day: ${guide.max_bookings_per_day}`;
  return sendMessage(env, chatId, text, { keyboard: inlineKeyboard([back()]) });
}

function showSettings(env, chatId, guide) {
  return sendMessage(env, chatId, '⚙️ <b>Guide Settings</b>', {
    keyboard: inlineKeyboard([
      [{ text: '👤 Profile', callback_data: 'g:profile' }],
      [{ text: '🔐 Change PIN', callback_data: 'g:setpin' }],
      [{ text: '🔔 Notification Preferences', callback_data: 'g:notifprefs' }],
      [{ text: '🔑 Reset/Relink Telegram', callback_data: 'g:relink' }],
      [{ text: 'ℹ️ Help / Guide', callback_data: 'g:help' }],
      [{ text: '🚪 Logout', callback_data: 'g:logout' }],
      back(),
    ]),
  });
}

function showNotificationPrefs(env, chatId, guide) {
  const row = (field, label) => [{
    text: `${guide[field] ? '🟢' : '⚪'} ${label}`,
    callback_data: `g:notiftoggle:${field}`,
  }];
  return sendMessage(env, chatId, '🔔 <b>Notification & Reminder Preferences</b>\nTap to toggle:', {
    keyboard: inlineKeyboard([
      row('notify_new_booking', 'New booking alerts'),
      row('reminder_24h', '24-hour reminders'),
      row('reminder_2h', '2-hour reminders'),
      row('reminder_30m', '30-minute reminders'),
      back('g:settings'),
    ]),
  });
}

async function continueSetPin(env, db, chatId, text, session, guide) {
  const pin = text.trim();
  if (!/^\d{4,6}$/.test(pin)) return sendMessage(env, chatId, 'PIN must be 4–6 digits. Try again, or tap ❎ Cancel.', { keyboard: inlineKeyboard([[{ text: '❎ Cancel', callback_data: 'g:cancel' }]]) });
  await setGuidePin(db, guide.id, pin);
  await clearSession(db, chatId);
  return sendMessage(env, chatId, '✅ PIN updated.', { keyboard: inlineKeyboard([back('g:settings')]) });
}

function showHelp(env, chatId) {
  const text =
    'ℹ️ <b>What each button does</b>\n\n' +
    "📊 Dashboard — today's summary, your next booking, availability status\n" +
    "📅 Today's Bookings — everything scheduled for today\n" +
    '🗓️ Future Bookings — grouped by Today/Tomorrow/This Week/Later\n' +
    '📋 All Bookings — filter by confirmed/pending/completed/cancelled, or search\n' +
    "👤 Guests — contact info for people on your active bookings\n" +
    '🗺️ My Tours — packages you\'re assigned to guide, with meeting points & instructions\n' +
    '🟢 Availability — set yourself available/unavailable and your weekly hours\n' +
    '⚙️ Guide Settings — profile, PIN, notifications, reset your Telegram link, logout';
  return sendMessage(env, chatId, text, { keyboard: inlineKeyboard([back()]) });
}

async function showGuests(env, db, chatId, guide) {
  const rows = await listGuestsForGuide(db, guide.id);
  if (rows.length === 0) return sendMessage(env, chatId, 'No guests on your active bookings yet.', { keyboard: inlineKeyboard([[{ text: '🔄 Refresh', callback_data: 'g:refresh:guests' }], back()]) });
  const lines = rows.slice(0, 20).map((g) => `👤 <b>${g.name}</b> — ${g.booking_code} (${g.visit_date})\n📞 ${g.phone || '(none)'}`);
  return sendMessage(env, chatId, `👤 <b>Guests</b>\n\n${lines.join('\n\n')}`, { keyboard: inlineKeyboard([[{ text: '🔄 Refresh', callback_data: 'g:refresh:guests' }], back()]) });
}

async function showMyTours(env, db, chatId, guide) {
  const packages = await getEligiblePackagesForGuide(db, guide);
  if (packages.length === 0) return sendMessage(env, chatId, 'No tours currently assigned to you.', { keyboard: inlineKeyboard([back()]) });
  const lines = packages.map((p) => {
    const services = p.services.length ? p.services.map((s) => `  • ${s.name}`).join('\n') : '  (none listed)';
    return `🗺️ <b>${p.name}</b>\n${p.description || '(no description on file)'}\nIncluded services:\n${services}`;
  });
  return sendMessage(env, chatId, lines.join('\n\n'), { keyboard: inlineKeyboard([[{ text: '🔄 Refresh', callback_data: 'g:refresh:mytours' }], back()]) });
}
