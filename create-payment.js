const crypto = require('crypto');
const { planFor, findOrCreateCustomer, createPaymentMethod, createCharge } = require('../../flutterwave');
const { supabaseAdmin, json } = require('../_server');

module.exports = async (req,res) => {
  if (req.method !== 'POST') return json(res,405,{error:'Method not allowed'});
  try {
    const { email, name, currency='NGN', card } = req.body || {};
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return json(res,400,{error:'Valid email is required'});
    const plan=planFor(currency);
    if (!card || !card.encrypted_card_number || !card.encrypted_expiry_month || !card.encrypted_expiry_year || !card.encrypted_cvv || !card.nonce) return json(res,400,{error:'Encrypted card data is required'});
    const reference=`WYH-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
    const customer=await findOrCreateCustomer(email.toLowerCase(),name||'WYWHOT Player');
    const method=await createPaymentMethod(customer.id,card);
    const appUrl=(process.env.NEXT_PUBLIC_APP_URL||'').replace(/\/$/,'');
    if (!appUrl) return json(res,500,{error:'NEXT_PUBLIC_APP_URL is not configured'});
    const redirectUrl=`${appUrl}/?payment=return&reference=${encodeURIComponent(reference)}`;
    const sb=supabaseAdmin();
    await sb.from('pro_orders').insert({reference,email:email.toLowerCase(),amount:plan.amount,currency:plan.currency,status:'pending',created_at:new Date().toISOString()});
    const charge=await createCharge({amount:plan.amount,currency:plan.currency,reference,customerId:customer.id,paymentMethodId:method.id,redirectUrl,meta:{app:'WYWHOT',product:'WYWHOT Pro',email:email.toLowerCase(),plan_days:30}});
    await sb.from('pro_orders').update({charge_id:String(charge.id),customer_id:String(customer.id),payment_method_id:String(method.id)}).eq('reference',reference);
    return json(res,200,{ok:true,reference,charge_id:charge.id,status:charge.status,next_action:charge.next_action||null,redirect_url:charge.next_action?.redirect_url?.url||charge.redirect_url||null});
  } catch(e) { console.error(e); return json(res,e.status||500,{error:e.message||'Unable to create payment'}); }
};
