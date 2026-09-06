-- Krem Chympe CMS + Booking + Guide + Payment System
-- Cloudflare D1 (SQLite) schema

-- ===== Admin / access control =====
CREATE TABLE IF NOT EXISTS admin_users (
  telegram_chat_id TEXT PRIMARY KEY,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'admin', -- 'admin' | 'superadmin'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== Website content (fully editable via Telegram) =====
-- One row per editable "block" (hero text, a section, a button, an image, etc).
-- section = logical grouping (e.g. 'hero','packages','faq','footer','buttons')
-- key = unique field name inside that section (e.g. 'title','subtitle','cta_label')
CREATE TABLE IF NOT EXISTS website_content (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,                 -- text, URL, or JSON depending on content_type
  content_type TEXT NOT NULL DEFAULT 'text', -- text | image | video | url | json
  visible INTEGER NOT NULL DEFAULT 1,
  highlighted INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(section, key)
);

-- ===== Packages / Services / Add-ons (all admin-editable, all priced) =====
CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  base_price REAL NOT NULL,
  image_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  highlighted INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id INTEGER REFERENCES packages(id), -- NULL = standalone / add-on-style service
  name TEXT NOT NULL,
  price REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  highlighted INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== Discounts =====
CREATE TABLE IF NOT EXISTS discounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  percent REAL NOT NULL,
  applies_to TEXT NOT NULL, -- JSON: {"packages":[1,2],"services":[5]}
  stackable INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== Visitors =====
CREATE TABLE IF NOT EXISTS visitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== Guides =====
CREATE TABLE IF NOT EXISTS guides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_chat_id TEXT UNIQUE,
  name TEXT NOT NULL,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'active',       -- active | inactive
  access_removed INTEGER NOT NULL DEFAULT 0,   -- booking access revoked without deleting guide
  eligible_scope TEXT NOT NULL DEFAULT '{}',   -- JSON: {"packages":[1,2],"all":false}
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS guide_codes (
  code TEXT PRIMARY KEY,
  scope TEXT NOT NULL,           -- JSON, same shape as guides.eligible_scope
  guide_name_hint TEXT,
  used INTEGER NOT NULL DEFAULT 0,
  used_by_guide_id INTEGER REFERENCES guides(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);

-- ===== Bookings =====
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_code TEXT UNIQUE NOT NULL,      -- e.g. KC-20260905-AB12
  visitor_id INTEGER NOT NULL REFERENCES visitors(id),
  package_id INTEGER REFERENCES packages(id),
  participants INTEGER NOT NULL DEFAULT 1,
  visit_date TEXT NOT NULL,
  selected_services TEXT NOT NULL DEFAULT '[]', -- JSON [{service_id, qty}]
  discount_id INTEGER REFERENCES discounts(id),
  base_amount REAL NOT NULL,
  discount_amount REAL NOT NULL DEFAULT 0,
  addon_amount REAL NOT NULL DEFAULT 0,
  final_amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  payment_status TEXT NOT NULL DEFAULT 'pending',
  -- pending              = no payment attempt yet (manual mode: awaiting gateway/manual choice)
  -- awaiting_verification = manual mode: receipt uploaded, admin hasn't acted yet
  -- partial              = gateway mode: at least the minimum advance captured, balance still due
  -- verified             = fully paid (gateway auto, or admin manually approved a manual booking)
  -- failed               = gateway payment failed
  -- rejected             = admin rejected a manual booking after reviewing the receipt
  booking_status TEXT NOT NULL DEFAULT 'pending',
  -- pending | confirmed | guide_required | assigned | guide_accepted | in_progress
  -- | completed | rejected | cancelled
  -- 'confirmed'      = payment accepted, no guide assignment attempted/settled yet
  -- 'guide_required' = payment accepted but no eligible active guide was found — needs admin action
  -- 'assigned'       = confirmed AND a guide has been assigned, awaiting their accept/decline
  -- 'guide_accepted' = the assigned guide tapped ✅ Accept
  -- 'in_progress'    = guide tapped ✅ Mark Started
  -- 'completed'      = guide tapped 🏁 Mark Completed
  -- 'cancelled'      = admin cancelled (see cancel_reason/cancelled_by/cancelled_at)
  razorpay_order_id TEXT,
  razorpay_payment_id TEXT,
  amount_paid_total REAL NOT NULL DEFAULT 0, -- sum of all captured payments (supports advance + later top-ups)
  receipt_file_id TEXT,        -- Telegram file_id (manual-mode payment proof, stored via the bot)
  receipt_is_image INTEGER,    -- 1 = photo file_id (use sendPhoto), 0 = document file_id (use sendDocument), NULL = unknown/legacy
  guide_id INTEGER REFERENCES guides(id),
  idempotency_key TEXT UNIQUE, -- prevents duplicate submissions from double-clicks/retries
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  razorpay_order_id TEXT,
  razorpay_payment_id TEXT,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL,        -- created|authorized|captured|failed|refunded
  raw_webhook TEXT,            -- JSON, for audit
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Lookup index for duplicate-webhook checks (see paymentAlreadyProcessed in
-- db.js) — deliberately NOT unique, since a single Razorpay payment id can
-- legitimately appear across multiple lifecycle events (authorized, then
-- captured). De-duplication is handled at the application level by checking
-- for an existing 'payment.captured' row before crediting a booking again.
CREATE INDEX IF NOT EXISTS idx_payments_payment_id ON payments(razorpay_payment_id);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  guide_id INTEGER NOT NULL REFERENCES guides(id),
  kind TEXT NOT NULL DEFAULT '24h', -- '24h' | '2h' | '30m'
  scheduled_for TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(booking_id, guide_id, kind)
);

-- ===== Payment gateway config (NON-secret metadata only) =====
-- Real secrets (Key Secret, Webhook Secret) are stored as Cloudflare Worker
-- encrypted secrets via the API, NEVER in this table or in Telegram messages.
CREATE TABLE IF NOT EXISTS payment_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL DEFAULT 'test',   -- test | live (auto-detected from key prefix at configure time)
  currency TEXT NOT NULL DEFAULT 'INR',
  key_id_last4 TEXT,                   -- last 4 chars only, for admin confirmation display
  min_advance_amount REAL NOT NULL DEFAULT 500, -- minimum deposit a visitor may pay to secure a booking
  configured INTEGER NOT NULL DEFAULT 0,        -- admin has entered credentials
  gateway_verified INTEGER NOT NULL DEFAULT 0,  -- credentials passed a live test call against Razorpay
  webhook_configured INTEGER NOT NULL DEFAULT 0,
  last_verified_at TEXT,
  last_failure_reason TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO payment_settings (id) VALUES (1);
-- Effective payment mode for the whole site = 'gateway' only when BOTH
-- configured = 1 AND gateway_verified = 1. Anything else (not configured,
-- test call failed, or gateway later found invalid) = 'manual'. This is
-- always computed server-side (see GET /api/payment-mode) — the frontend
-- never decides this for itself.

-- ===== Bot conversation state (multi-step admin/guide flows) =====
CREATE TABLE IF NOT EXISTS bot_sessions (
  telegram_chat_id TEXT PRIMARY KEY,
  flow TEXT NOT NULL,          -- e.g. 'configure_razorpay', 'add_package', 'add_discount'
  step TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}', -- JSON accumulator for the in-progress flow
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== Audit log =====
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_chat_id TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(booking_status);
CREATE INDEX IF NOT EXISTS idx_bookings_guide ON bookings(guide_id);
CREATE INDEX IF NOT EXISTS idx_reminders_pending ON reminders(sent, scheduled_for);

-- ===== Migration additions (bookings/guides/discounts lifecycle + guide availability) =====
-- Bookings: cancellation, refund, guide accept/decline, in-progress/completed tracking, contact/meeting info
ALTER TABLE bookings ADD COLUMN cancel_reason TEXT;
ALTER TABLE bookings ADD COLUMN cancelled_by TEXT;
ALTER TABLE bookings ADD COLUMN cancelled_at TEXT;
ALTER TABLE bookings ADD COLUMN refund_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN refunded_at TEXT;
-- guide_accept_status: NULL (no guide yet) | pending | accepted | declined
ALTER TABLE bookings ADD COLUMN guide_accept_status TEXT;
ALTER TABLE bookings ADD COLUMN decline_reason TEXT;
ALTER TABLE bookings ADD COLUMN started_at TEXT;
ALTER TABLE bookings ADD COLUMN completed_at TEXT;
ALTER TABLE bookings ADD COLUMN meeting_point TEXT;
-- booking_status now also uses: guide_required | guide_accepted | in_progress | cancelled (in addition to the original set)

-- Guides: manual availability toggle + workload cap + soft profile fields
ALTER TABLE guides ADD COLUMN available INTEGER NOT NULL DEFAULT 1; -- guide's own 🟢/🔴 toggle
ALTER TABLE guides ADD COLUMN max_bookings_per_day INTEGER NOT NULL DEFAULT 5;
ALTER TABLE guides ADD COLUMN admin_override_available INTEGER; -- admin can force-override availability (NULL = no override)
ALTER TABLE guides ADD COLUMN pin TEXT; -- optional guide-set PIN (⚙️ Guide Settings)
ALTER TABLE guides ADD COLUMN notify_new_booking INTEGER NOT NULL DEFAULT 1;
ALTER TABLE guides ADD COLUMN reminder_24h INTEGER NOT NULL DEFAULT 1;
ALTER TABLE guides ADD COLUMN reminder_2h INTEGER NOT NULL DEFAULT 1;
ALTER TABLE guides ADD COLUMN reminder_30m INTEGER NOT NULL DEFAULT 1;

-- Bookings: a specific time-of-day for the tour, needed for 24h/2h/30m reminders
ALTER TABLE bookings ADD COLUMN visit_time TEXT NOT NULL DEFAULT '09:00';

-- Per-weekday availability schedule for a guide (spec section 19)
CREATE TABLE IF NOT EXISTS guide_schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guide_id INTEGER NOT NULL REFERENCES guides(id),
  day_of_week INTEGER NOT NULL,   -- 0=Sunday .. 6=Saturday
  available INTEGER NOT NULL DEFAULT 1,
  start_time TEXT,                -- 'HH:MM'
  end_time TEXT,                  -- 'HH:MM'
  UNIQUE(guide_id, day_of_week)
);

-- Specific one-off unavailable dates for a guide (overrides the weekday schedule)
CREATE TABLE IF NOT EXISTS guide_unavailable_dates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guide_id INTEGER NOT NULL REFERENCES guides(id),
  date TEXT NOT NULL,             -- 'YYYY-MM-DD'
  UNIQUE(guide_id, date)
);

-- Discounts: coupon codes, scheduling window, usage caps (spec section 6)
ALTER TABLE discounts ADD COLUMN coupon_code TEXT;
ALTER TABLE discounts ADD COLUMN start_date TEXT;
ALTER TABLE discounts ADD COLUMN end_date TEXT;
ALTER TABLE discounts ADD COLUMN max_usage INTEGER;
ALTER TABLE discounts ADD COLUMN used_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE discounts ADD COLUMN min_booking_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE discounts ADD COLUMN discount_type TEXT NOT NULL DEFAULT 'percent'; -- percent | fixed

-- Links a guide code to the specific pre-created guide profile it's meant to
-- activate (from ➕ Add Guide), so redemption links Telegram to THAT guide
-- rather than creating a duplicate. NULL = generic code (👥 Guides →
-- 🔑 Generate Code (any)), which creates a fresh guide record on redemption.
ALTER TABLE guide_codes ADD COLUMN guide_id INTEGER REFERENCES guides(id);

-- Site-wide settings not tied to payments (spec section 4 / 30, ⚙️ Settings)
CREATE TABLE IF NOT EXISTS site_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  site_enabled INTEGER NOT NULL DEFAULT 1, -- 🟢 Enable / 🔴 Disable whole website
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO site_settings (id) VALUES (1);
