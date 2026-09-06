// All Razorpay calls happen server-side only. The frontend never sees
// RAZORPAY_KEY_SECRET or the webhook secret.

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Confirms a Key ID / Key Secret pair actually authenticates against
// Razorpay, using the plaintext values the admin just typed into Telegram —
// this runs BEFORE they're persisted as Worker secrets, so a typo or wrong
// key is caught immediately instead of silently "configuring" a broken
// gateway. A lightweight read-only call is enough: it costs nothing and
// requires no test order/payment to exist.
export async function testRazorpayCredentials(keyId, keySecret) {
  try {
    const auth = btoa(`${keyId}:${keySecret}`);
    const res = await fetch('https://api.razorpay.com/v1/payments?count=1', {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    return { ok: false, reason: body?.error?.description || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: String(err.message || err) };
  }
}

export async function createRazorpayOrder(env, { amountPaise, currency, receipt, notes }) {
  const auth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: amountPaise, currency, receipt, notes, payment_capture: 1 }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Razorpay order creation failed: ${res.status} ${body}`);
  }
  return res.json();
}

// Verifies the signature returned to the browser after checkout succeeds
// (razorpay_order_id + razorpay_payment_id + razorpay_signature).
// This is a *hint* only — the webhook below is the source of truth.
export async function verifyCheckoutSignature(env, { orderId, paymentId, signature }) {
  const expected = await hmacSha256Hex(env.RAZORPAY_KEY_SECRET, `${orderId}|${paymentId}`);
  return expected === signature;
}

// Verifies an incoming Razorpay webhook using the raw request body (must be
// the *unparsed* body — do not JSON.stringify(await request.json()) here,
// re-serializing can change byte-for-byte content and break the signature).
export async function verifyWebhookSignature(env, rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const expected = await hmacSha256Hex(env.RAZORPAY_WEBHOOK_SECRET, rawBody);
  return expected === signatureHeader;
}

// Issues a refund against a captured Razorpay payment. Amount is in the
// major currency unit (e.g. rupees) and converted to paise here. Passing no
// amount refunds the full remaining captured amount.
export async function createRazorpayRefund(env, { paymentId, amount }) {
  const auth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  const body = {};
  if (amount != null) body.amount = Math.round(amount * 100);
  const res = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}/refund`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, reason: data?.error?.description || `HTTP ${res.status}` };
  }
  return { ok: true, refund: data };
}

// ---- Admin-configured secrets ----
// The admin bot collects Key ID / Key Secret / Webhook Secret in a private
// Telegram chat, then this function pushes them straight into Cloudflare's
// encrypted Worker secrets store via the Cloudflare API — they are never
// written to D1, logged, or echoed back in any Telegram message.
export async function setWorkerSecret(env, secretName, secretValue) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${env.CF_WORKER_NAME}/secrets`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: secretName, text: secretValue, type: 'secret_text' }),
  });
  const data = await res.json();
  if (!data.success) {
    console.error('Failed to set worker secret', secretName, data.errors);
    return false;
  }
  return true;
}
