import { sendMessage, inlineKeyboard } from '../telegram.js';
import { redeemGuideCode } from '../auth.js';

function guideMenu() {
  return inlineKeyboard([
    [{ text: '📊 Dashboard', callback_data: 'g:dashboard' }, { text: "📅 Today's Bookings", callback_data: 'g:today' }],
    [{ text: '🔜 Future Bookings', callback_data: 'g:future' }, { text: '📋 All Bookings', callback_data: 'g:all' }],
    [{ text: '📈 Booking Summary', callback_data: 'g:summary' }, { text: '📦 My Services', callback_data: 'g:services' }],
    [{ text: '👤 My Account', callback_data: 'g:account' }],
  ]);
}

export async function handleGuideOrUnknownMessage(env, db, chatId, text, sender) {
  const trimmed = text.trim();

  // Looks like a guide code (XXXX-XXXX format from randomGuideCode)
  if (/^[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(trimmed)) {
    const result = await redeemGuideCode(db, trimmed.toUpperCase(), chatId, null);
    if (result.ok) {
      return sendMessage(env, chatId, '✅ Guide access activated! Here is your dashboard:', { keyboard: guideMenu() });
    }
    const reasons = {
      not_found: 'That code was not found.',
      already_used: 'That code has already been used.',
      expired: 'That code has expired.',
    };
    return sendMessage(env, chatId, `❌ ${reasons[result.reason] || 'Could not activate that code.'}`);
  }

  if (sender.type === 'guide') {
    if (trimmed === '/start' || trimmed === '/menu') {
      return sendMessage(env, chatId, `👋 Welcome back, ${sender.guide.name}.`, { keyboard: guideMenu() });
    }
    return sendMessage(env, chatId, 'Use /menu to see your dashboard.');
  }

  return sendMessage(env, chatId, 'Welcome. If you were given a guide code, send it here to activate your account.');
}

export async function handleGuideCallback(env, db, chatId, data, guide) {
  if (data === 'g:dashboard' || data === 'g:today' || data === 'g:future' || data === 'g:all' || data === 'g:summary') {
    const rows = (
      await db.prepare('SELECT booking_code, visit_date, booking_status FROM bookings WHERE guide_id = ? ORDER BY visit_date').bind(guide.id).all()
    ).results;
    const lines = rows.map((r) => `• ${r.booking_code} — ${r.visit_date} — ${r.booking_status}`);
    return sendMessage(env, chatId, lines.join('\n') || 'No bookings yet.');
  }
  if (data === 'g:services') {
    const scope = JSON.parse(guide.eligible_scope || '{}');
    return sendMessage(env, chatId, scope.all ? 'You are eligible for: All services.' : `Eligible package ids: ${(scope.packages || []).join(', ') || '(none)'}`);
  }
  if (data === 'g:account') {
    return sendMessage(env, chatId, `Name: ${guide.name}\nStatus: ${guide.status}\nAccess: ${guide.access_removed ? 'removed' : 'active'}`);
  }
  return sendMessage(env, chatId, 'Unknown option.');
}
