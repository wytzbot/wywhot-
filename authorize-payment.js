const { flwRequest } = require('../../flutterwave');
const { json } = require('../_server');
module.exports = async (req,res)=>{
  if(req.method!=='POST') return json(res,405,{error:'Method not allowed'});
  try{
    const {charge_id,type,otp,nonce,encrypted_pin}=req.body||{};
    if(!charge_id || !['otp','pin'].includes(type)) return json(res,400,{error:'charge_id and authorization type are required'});
    const authorization=type==='otp' ? {type:'otp',otp:{code:String(otp||'')}} : {type:'pin',pin:{nonce:String(nonce||''),encrypted_pin:String(encrypted_pin||'')}};
    if(type==='otp' && !/^\d{4,8}$/.test(authorization.otp.code)) return json(res,400,{error:'Invalid OTP'});
    if(type==='pin' && (!authorization.pin.nonce || !authorization.pin.encrypted_pin)) return json(res,400,{error:'Encrypted PIN is required'});
    const data=await flwRequest(`/charges/${encodeURIComponent(charge_id)}`,{method:'PUT',body:{authorization}});
    const charge=data.data||data;
    return json(res,200,{ok:true,status:charge.status,next_action:charge.next_action||null,redirect_url:charge.next_action?.redirect_url?.url||charge.redirect_url||null});
  }catch(e){return json(res,e.status||500,{error:e.message||'Authorization failed'});}
};
