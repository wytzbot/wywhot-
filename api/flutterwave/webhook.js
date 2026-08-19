const { validWebhookSignature, getCharge } = require('../../flutterwave');
const { supabaseAdmin, readRawBody, json, activatePro } = require('../_server');
const handler = async (req,res) => {
  if(req.method!=='POST') return json(res,405,{error:'Method not allowed'});
  try{
    const raw=await readRawBody(req);
    const sig=req.headers['flutterwave-signature'];
    if(!validWebhookSignature(raw,sig,process.env.FLW_SECRET_HASH)) return json(res,401,{error:'Invalid signature'});
    const payload=JSON.parse(raw.toString('utf8'));
    const data=payload.data||{}; const reference=String(data.reference||''); const chargeId=String(data.id||'');
    if(!reference || !chargeId) return json(res,200,{received:true});
    const sb=supabaseAdmin();
    await sb.from('payment_events').upsert({event_id:String(payload.id||chargeId),charge_id:chargeId,status:data.status||'unknown',reference, email:String(data.customer?.email||data.meta?.email||'').toLowerCase()||null,amount:data.amount||null,currency:data.currency||null,payload,created_at:new Date().toISOString()},{onConflict:'event_id'});
    const charge=await getCharge(chargeId);
    const {data:order}=await sb.from('pro_orders').select('*').eq('reference',reference).maybeSingle();
    if(order && charge.status==='succeeded' && Number(charge.amount)===Number(order.amount) && charge.currency===order.currency && charge.reference===order.reference){
      await activatePro({reference,chargeId,email:order.email,amount:charge.amount,currency:charge.currency,payload:charge});
    } else if(order && ['failed','voided'].includes(charge.status)) {
      await sb.from('pro_orders').update({status:charge.status,charge_id:chargeId}).eq('reference',reference);
    }
    return json(res,200,{received:true});
  }catch(e){ console.error(e); return json(res,500,{error:'Webhook processing failed'}); }
};

handler.config = { api: { bodyParser: false } };
module.exports = handler;
