# Krem Chympe Backend

Cloudflare Worker backend for the Telegram-controlled CMS + booking + guide +
payment system, with **automatic two-mode payments**:

- **Manual mode** (default, no gateway or an unverified one): visitor sees
  your existing UPI/QR/bank instructions, uploads a payment receipt, and an
  admin manually confirms or rejects the booking from Telegram.
- **Gateway mode** (Razorpay configured AND verified): visitor pays through
  a real Razorpay Checkout on the site, the booking is confirmed and a guide
  assigned automatically the moment the webhook verifies payment — no admin
  or guide action required.

The mode is decided **entirely server-side** (`GET /api/payment-mode`) and
the frontend just asks and renders accordingly. If a verified gateway later
starts failing (bad key, Razorpay outage), the backend automatically flips
back to manual mode and tells the admin, instead of showing a broken
payment page.

## What's real vs. stubbed

**Fully working:**
- D1 schema for every entity in the spec
- Public website content + packages API
- Server-side price calculation (never trusts the browser)
- **Two-mode payment switching**, decided by `payment_settings.configured`
  AND `payment_settings.gateway_verified` — both must be true for gateway
  mode. Razorpay credentials are tested live (a real API call) before
  they're ever saved, so a typo can't "configure" a broken gateway.
- **Manual mode:** booking created with `payment_status='pending'`; receipt
  upload sets `payment_status='awaiting_verification'` and sends admins the
  receipt image with ✅ Confirm / ❌ Reject buttons. Nothing is auto-marked
  paid — a human decides.
- **Gateway mode:** Razorpay order creation, webhook signature verification,
  amount/currency sanity checks, and duplicate-webhook protection (a
  captured payment is only ever applied once, even if Razorpay redelivers
  the event).
- Partial/advance payments in gateway mode: visitors can pay the full total
  or a minimum advance (`payment_settings.min_advance_amount`, defaults to
  ₹500). The browser's requested amount is clamped server-side to
  `[min_advance, final_amount]` before an order is created.
  `bookings.amount_paid_total` accumulates across payments.
- **Automatic guide assignment** the moment a booking is confirmed (gateway
  auto-confirm, or admin manual-confirm) — least-loaded eligible active
  guide, conditional UPDATE to prevent double-assignment. A booking is never
  rejected for lack of a guide: it stays confirmed with guide unassigned and
  admin gets a ⚠️ NO ACTIVE ELIGIBLE GUIDE AVAILABLE alert.
- 1-day-before reminder scheduling + a cron handler to send them
- Admin bot: main menu, Razorpay configuration (test → save as encrypted
  Worker secrets, never stored in D1 or re-shown in chat), 🧪 Re-test
  Gateway, add package, add discount, generate guide code, payment
  history/status
- Guide bot: code redemption, dashboard/bookings list, account info
- Audit log on every admin-driven change
- `index.html` shows whichever payment UI the backend reports, with a safe
  fallback if gateway mode drops out mid-flow. See "Frontend" below.

**Stubbed / next stage:**
- Website "🌐 Website" menu (editing hero/sections/buttons from Telegram) —
  the `website_content` table and `upsertContent()` helper already exist;
  the bot menu wiring for it is next
- 📅 Bookings / 📊 Analytics / ⚙️ Settings admin menus (currently placeholders)
- Editing/deleting existing packages, services, discounts (add-only so far)
- Admin bot control over `min_advance_amount` (currently only settable
  directly in the DB; the site's `MIN_ADVANCE` JS constant would need
  updating to match if you change it)
- Guide deactivation / "remove booking access" admin commands
- Discount stacking rules beyond the basic single-discount case
- A "pay remaining balance" flow for gateway visitors who paid only the
  advance (collecting the balance is currently a manual/offline step)
- Rate limiting
- The old client-side "secret admin mode" in `index.html` (5-taps-on-title,
  hardcoded passcode) is still present and untouched — it isn't real access
  control (the passcode is visible in page source and nothing syncs to a
  server) and shouldn't be treated as the CMS.

## Deploy steps

1. **Install Wrangler** (Cloudflare's CLI): `npm install -g wrangler`
2. **Create the D1 database:**
   ```
   wrangler d1 create kremchympe-db
   ```
   Copy the `database_id` it prints into `wrangler.toml`.
3. **Load the schema and seed data:**
   ```
   wrangler d1 execute kremchympe-db --file=./schema.sql
   wrangler d1 execute kremchympe-db --file=./seed.sql
   ```
4. **Create the R2 bucket for receipts:**
   ```
   wrangler r2 bucket create kremchympe-receipts
   ```
5. **Create a Telegram bot** via [@BotFather](https://t.me/BotFather) and get
   the bot token.
6. **Create a Cloudflare API token** (My Profile → API Tokens) with
   "Edit Cloudflare Workers" permission — this lets the bot write new
   Razorpay secrets on your behalf when you configure them via Telegram.
7. **Set secrets** (never put these in `wrangler.toml` or commit them):
   ```
   wrangler secret put TELEGRAM_BOT_TOKEN
   wrangler secret put TELEGRAM_WEBHOOK_SECRET   # any random string you invent
   wrangler secret put SUPERADMIN_CHAT_ID        # your personal Telegram chat id
   wrangler secret put CF_API_TOKEN
   wrangler secret put CF_ACCOUNT_ID
   wrangler secret put CF_WORKER_NAME            # kremchympe-backend
   ```
   (Get your chat id by messaging [@userinfobot](https://t.me/userinfobot).)
8. **Deploy:**
   ```
   wrangler deploy
   ```
9. **Register the Telegram webhook** (replace values):
   ```
   curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<your-worker>.workers.dev/webhook/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
   ```
10. **Message your bot** with `/start` from the SUPERADMIN_CHAT_ID account —
    this bootstraps you as the first admin and opens the main menu.
11. **At this point you're already live in manual mode** — visitors can book
    using the existing UPI/QR/bank instructions and admins get receipts to
    confirm/reject. No further setup is required to accept bookings.
12. **To switch on gateway mode**, from the bot: 💳 Payments → 🔑 Configure
    Razorpay, then paste your Key ID, Key Secret, and Webhook Secret when
    prompted. The bot tests them live against Razorpay before saving —
    if they're valid, the site switches to gateway mode immediately.
13. **Add the Razorpay webhook** in the Razorpay dashboard pointing to:
    `https://<your-worker>.workers.dev/webhook/razorpay`
    (events: `payment.captured`, `payment.failed`)
14. **Enable the cron trigger** for reminders — add to `wrangler.toml`:
    ```
    [triggers]
    crons = ["0 * * * *"]
    ```

## Frontend integration

`index.html` calls `GET /api/payment-mode` when the visitor reaches Step 3
and shows the matching section — nothing about which mode is active is
decided in the browser:

- **Manual mode:** the original UPI/QR/bank cards plus a receipt file
  upload. `submitManualBooking()` creates the booking (if not already
  created) and uploads the receipt via `POST /api/receipt`. The visitor
  lands on the thank-you screen with a "pending verification" message.
- **Gateway mode:** the breakdown + advance-amount field + "Pay Now with
  Razorpay" button, same as before. `payWithRazorpay()` now also
  double-checks the mode returned by `POST /api/booking` itself — if the
  backend reports `mode: 'manual'` (a fallback just happened), it switches
  the visitor to the manual section automatically instead of erroring out.

**Before this works, you must edit two things in `index.html`:**
- `const BACKEND_URL = "https://YOUR-WORKER-SUBDOMAIN.workers.dev";` → your
  deployed Worker URL.
- `SERVICE_IDS` — these ids assume a **fresh** database seeded with
  `seed.sql` in the exact order given (package id 1, services 1–19). If you
  add/reorder services later, check the real ids with:
  ```
  wrangler d1 execute kremchympe-db --command="select id, name from services"
  ```
  and update `SERVICE_IDS` to match.
