-- Run this ONCE against an already-deployed database:
--   wrangler d1 execute kremchympe-db --file=./migrations/0002_phase2.sql
-- (Fresh installs don't need this — schema.sql already includes it.)

ALTER TABLE bookings ADD COLUMN cancel_reason TEXT;
ALTER TABLE bookings ADD COLUMN cancelled_by TEXT;
ALTER TABLE bookings ADD COLUMN cancelled_at TEXT;
ALTER TABLE bookings ADD COLUMN refund_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN refunded_at TEXT;
ALTER TABLE bookings ADD COLUMN guide_accept_status TEXT;
ALTER TABLE bookings ADD COLUMN decline_reason TEXT;
ALTER TABLE bookings ADD COLUMN started_at TEXT;
ALTER TABLE bookings ADD COLUMN completed_at TEXT;
ALTER TABLE bookings ADD COLUMN meeting_point TEXT;

ALTER TABLE guides ADD COLUMN available INTEGER NOT NULL DEFAULT 1;
ALTER TABLE guides ADD COLUMN max_bookings_per_day INTEGER NOT NULL DEFAULT 5;
ALTER TABLE guides ADD COLUMN admin_override_available INTEGER;

CREATE TABLE IF NOT EXISTS guide_schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guide_id INTEGER NOT NULL REFERENCES guides(id),
  day_of_week INTEGER NOT NULL,
  available INTEGER NOT NULL DEFAULT 1,
  start_time TEXT,
  end_time TEXT,
  UNIQUE(guide_id, day_of_week)
);

CREATE TABLE IF NOT EXISTS guide_unavailable_dates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guide_id INTEGER NOT NULL REFERENCES guides(id),
  date TEXT NOT NULL,
  UNIQUE(guide_id, date)
);

ALTER TABLE discounts ADD COLUMN coupon_code TEXT;
ALTER TABLE discounts ADD COLUMN start_date TEXT;
ALTER TABLE discounts ADD COLUMN end_date TEXT;
ALTER TABLE discounts ADD COLUMN max_usage INTEGER;
ALTER TABLE discounts ADD COLUMN used_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE discounts ADD COLUMN min_booking_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE discounts ADD COLUMN discount_type TEXT NOT NULL DEFAULT 'percent';

ALTER TABLE guide_codes ADD COLUMN guide_id INTEGER REFERENCES guides(id);

ALTER TABLE reminders ADD COLUMN kind TEXT NOT NULL DEFAULT '24h';
ALTER TABLE reminders ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
-- Note: existing deployments can't add the UNIQUE(booking_id, guide_id, kind)
-- constraint via ALTER TABLE; application code checks for an existing row
-- before inserting a new reminder, so duplicates are still prevented.

ALTER TABLE bookings ADD COLUMN visit_time TEXT NOT NULL DEFAULT '09:00';

ALTER TABLE guides ADD COLUMN pin TEXT;
ALTER TABLE guides ADD COLUMN notify_new_booking INTEGER NOT NULL DEFAULT 1;
ALTER TABLE guides ADD COLUMN reminder_24h INTEGER NOT NULL DEFAULT 1;
ALTER TABLE guides ADD COLUMN reminder_2h INTEGER NOT NULL DEFAULT 1;
ALTER TABLE guides ADD COLUMN reminder_30m INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS site_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  site_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO site_settings (id) VALUES (1);
