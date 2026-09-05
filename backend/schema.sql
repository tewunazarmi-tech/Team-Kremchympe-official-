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
  -- pending | confirmed | assigned | completed | rejected | cancelled
  -- 'confirmed' = payment accepted (gateway verified/partial, or admin-approved manual) but no
  --               guide assigned yet (either not attempted, or none eligible)
  -- 'assigned'  = confirmed AND a guide has been assigned
  razorpay_order_id TEXT,
  razorpay_payment_id TEXT,
  amount_paid_total REAL NOT NULL DEFAULT 0, -- sum of all captured payments (supports advance + later top-ups)
  receipt_file_id TEXT,        -- R2 object key (manual-mode payment proof upload)
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
  scheduled_for TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
