// WYWHOT Flutterwave v4 server helper. SERVER-SIDE ONLY.
const crypto = require('crypto');

const TOKEN_URL = 'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token';
const BASE_URL = process.env.FLW_API_BASE_URL || (
  process.env.FLW_ENV === 'production'
    ? 'https://f4bexperience.flutterwave.com'
    : 'https://developersandbox-api.flutterwave.com'
);

function planFor(currency) {
  if (currency === 'NGN') return { amount: 1000, currency: 'NGN' };
  if (currency === 'USD') return { amount: 1, currency: 'USD' };
  throw new Error('Unsupported Pro currency');
}

function idempotencyKey(prefix='wywhot') {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function getAccessToken() {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.FLW_CLIENT_ID || '',
      client_secret: process.env.FLW_CLIENT_SECRET || '',
      grant_type: 'client_credentials'
    })
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.access_token) throw new Error(body.message || 'Flutterwave OAuth authentication failed');
  return body.access_token;
}

async function flwRequest(path, options = {}) {
  const token = await getAccessToken();
  const trace = options.trace || crypto.randomUUID();
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Trace-Id': trace,
    ...(options.idempotency ? { 'X-Idempotency-Key': options.idempotency } : {}),
    ...(options.headers || {})
  };
  const r = await fetch(`${BASE_URL}${path}`, { method: options.method || 'GET', headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = body?.error?.message || body?.message || `Flutterwave API error (${r.status})`;
    const e = new Error(msg); e.status = r.status; e.body = body; throw e;
  }
  return body;
}

async function findOrCreateCustomer(email, name='WYWHOT Player') {
  const found = await flwRequest('/customers/search?page=1&size=10', { method: 'POST', body: { email } });
  const list = Array.isArray(found.data) ? found.data : [];
  const existing = list.find(c => String(c.email || '').toLowerCase() === email.toLowerCase());
  if (existing?.id) return existing;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (await flwRequest('/customers', {
    method: 'POST', idempotency: idempotencyKey('customer'),
    body: { email, name: { first: parts[0] || 'WYWHOT', last: parts.slice(1).join(' ') || 'Player' } }
  })).data;
}

async function createPaymentMethod(customerId, card) {
  return (await flwRequest('/payment-methods', {
    method: 'POST', idempotency: idempotencyKey('pmd'),
    body: { type: 'card', customer_id: customerId, card }
  })).data;
}

async function createCharge({ amount, currency, reference, customerId, paymentMethodId, redirectUrl, meta }) {
  return (await flwRequest('/charges', {
    method: 'POST', idempotency: idempotencyKey('charge'),
    body: { amount, currency, reference, customer_id: customerId, payment_method_id: paymentMethodId, redirect_url: redirectUrl, meta }
  })).data;
}

async function getCharge(id) {
  return (await flwRequest(`/charges/${encodeURIComponent(id)}`)).data;
}

async function listChargesByReference(reference) {
  return (await flwRequest(`/charges?reference=${encodeURIComponent(reference)}&size=10`)).data || [];
}

function validWebhookSignature(rawBody, signature, secretHash) {
  if (!signature || !secretHash) return false;
  const expected = crypto.createHmac('sha256', secretHash).update(rawBody).digest('base64');
  const a = Buffer.from(expected); const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { BASE_URL, planFor, idempotencyKey, getAccessToken, flwRequest, findOrCreateCustomer, createPaymentMethod, createCharge, getCharge, listChargesByReference, validWebhookSignature };
