const { getCharge, listChargesByReference } = require('../../flutterwave');
const { supabaseAdmin, json, activatePro } = require('../_server');
module.exports = async (req,res) => {
  if (req.method !== 'GET' && req.method !== 'POST') return json(res,405,{error:'Method not allowed'});
  try {
    const q=req.method==='GET' ? req.query : (req.body||{});
    const reference=String(q.reference||''); const chargeId=String(q.charge_id||q.chargeId||'');
    if(!reference && !chargeId) return json(res,400,{error:'reference or charge_id is required'});
    const sb=supabaseAdmin();
    const {data:order}=await sb.from('pro_orders').select('*').eq('reference',reference).maybeSingle();
    if(!order) return json(res,404,{error:'Payment order not found'});
    const charge=chargeId ? await getCharge(chargeId) : ((await listChargesByReference(reference)).find(c=>c.reference===reference));
    if(!charge) return json(res,404,{error:'Charge not found',reference});
    const valid=charge.status==='succeeded' && Number(charge.amount)===Number(order.amount) && charge.currency===order.currency && charge.reference===order.reference;
    if(valid){ const entitlement=await activatePro({reference:order.reference,chargeId:charge.id,email:order.email,amount:charge.amount,currency:charge.currency,payload:charge}); return json(res,200,{ok:true,paid:true,reference,charge_id:charge.id,pro:true,email:order.email,expires_at:entitlement.expires_at}); }
    return json(res,200,{ok:true,paid:false,reference,charge_id:charge.id,status:charge.status});
  } catch(e){ console.error(e); return json(res,e.status||500,{error:e.message||'Verification failed'}); }
};
