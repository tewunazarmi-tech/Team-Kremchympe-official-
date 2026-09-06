-- Run this ONCE against an already-deployed database:
--   wrangler d1 execute kremchympe-db --file=./migrations/0003_receipt_type.sql
-- (Fresh installs don't need this — schema.sql already includes it.)

-- Lets the bot know whether a stored receipt_file_id is a Telegram photo
-- file_id (sendPhoto) or a document file_id (sendDocument) — the two are
-- not interchangeable. Existing rows are left NULL (legacy/unknown); the
-- booking-code-lookup feature falls back to trying sendPhoto first for
-- those and reports a plain error if that guess is wrong.
ALTER TABLE bookings ADD COLUMN receipt_is_image INTEGER;
