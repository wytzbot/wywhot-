const { createClient } = require('@supabase/supabase-js');
function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase server environment is not configured');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
function json(res, status, body) { res.status(status).json(body); }
async function readRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === 'string') return Buffer.from(req.rawBody);
  return await new Promise((resolve, reject) => {
    const chunks=[]; req.on('data', c=>chunks.push(Buffer.from(c))); req.on('end',()=>resolve(Buffer.concat(chunks))); req.on('error',reject);
  });
}
function isoPlusDays(days) { return new Date(Date.now() + days*86400000).toISOString(); }
async function activatePro({ reference, chargeId, email, amount, currency, payload }) {
  const sb = supabaseAdmin();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const { data: existingOrder } = await sb.from('pro_orders').select('*').eq('reference', reference).maybeSingle();
  if (!existingOrder || String(existingOrder.email).toLowerCase() !== normalizedEmail) throw new Error('Payment reference/email mismatch');
  if (Number(existingOrder.amount) !== Number(amount) || existingOrder.currency !== currency) throw new Error('Payment amount/currency mismatch');

  // Idempotency: Flutterwave can retry webhooks and the redirect verifier can
  // run after a webhook. Never extend the same successful order twice.
  if (existingOrder.status === 'paid' && String(existingOrder.charge_id || '') === String(chargeId || '')) {
    const { data: current } = await sb.from('pro_entitlements').select('expires_at').eq('email', normalizedEmail).maybeSingle();
    return { email: normalizedEmail, expires_at: current?.expires_at || null, alreadyActivated: true };
  }

  const { data: currentByReference } = await sb.from('pro_entitlements').select('expires_at').eq('flutterwave_reference', reference).maybeSingle();
  if (currentByReference) {
    return { email: normalizedEmail, expires_at: currentByReference.expires_at, alreadyActivated: true };
  }

  const { data: old } = await sb.from('pro_entitlements').select('expires_at').eq('email', normalizedEmail).maybeSingle();
  const base = old?.expires_at && new Date(old.expires_at).getTime() > Date.now() ? new Date(old.expires_at) : new Date();
  const expiry = new Date(base.getTime() + 30 * 86400000).toISOString();

  const { error: entitlementError } = await sb.from('pro_entitlements').upsert({
    email: normalizedEmail,
    status: 'active',
    expires_at: expiry,
    flutterwave_reference: reference,
    updated_at: new Date().toISOString()
  }, { onConflict: 'email' });
  if (entitlementError) throw entitlementError;

  const { error: orderError } = await sb.from('pro_orders').update({
    status: 'paid',
    charge_id: String(chargeId),
    paid_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }).eq('reference', reference);
  if (orderError) throw orderError;

  return { email: normalizedEmail, expires_at: expiry, alreadyActivated: false };
}
module.exports = { supabaseAdmin, json, readRawBody, isoPlusDays, activatePro };
