import { getAdminRole, findGuideByChatId } from './db.js';

export async function classifySender(db, chatId) {
  const role = await getAdminRole(db, chatId);
  if (role) return { type: 'admin', role };

  const guide = await findGuideByChatId(db, chatId);
  if (guide) return { type: 'guide', guide };

  return { type: 'unknown' };
}

export function randomGuideCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let out = '';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  for (let i = 0; i < 8; i++) out += chars[bytes[i] % chars.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export async function redeemGuideCode(db, code, chatId, guideName) {
  const row = await db.prepare('SELECT * FROM guide_codes WHERE code = ?').bind(code).first();
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.used) return { ok: false, reason: 'already_used' };
  if (row.expires_at && new Date(row.expires_at) < new Date()) return { ok: false, reason: 'expired' };

  let guideId;

  // This code was generated for a specific pre-created guide profile
  // (➕ Add Guide) — link Telegram to THAT record instead of creating a
  // duplicate guide.
  if (row.guide_id) {
    guideId = row.guide_id;
    await db
      .prepare("UPDATE guides SET telegram_chat_id = ?, status='active', access_removed=0 WHERE id=?")
      .bind(String(chatId), guideId)
      .run();
  } else {
    const existing = await db.prepare('SELECT * FROM guides WHERE telegram_chat_id = ?').bind(String(chatId)).first();
    if (existing) {
      guideId = existing.id;
      await db
        .prepare("UPDATE guides SET status='active', access_removed=0, eligible_scope=? WHERE id=?")
        .bind(row.scope, guideId)
        .run();
    } else {
      const res = await db
        .prepare(
          `INSERT INTO guides (telegram_chat_id, name, status, eligible_scope) VALUES (?, ?, 'active', ?)`
        )
        .bind(String(chatId), guideName || row.guide_name_hint || 'Guide', row.scope)
        .run();
      guideId = res.meta.last_row_id;
    }
  }

  await db
    .prepare('UPDATE guide_codes SET used = 1, used_by_guide_id = ? WHERE code = ?')
    .bind(guideId, code)
    .run();

  return { ok: true, guideId };
}
