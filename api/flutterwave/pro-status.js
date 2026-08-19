const { supabaseAdmin, json } = require('../_server');
module.exports = async (req,res)=>{
  if(req.method!=='GET') return json(res,405,{error:'Method not allowed'});
  try{
    const email=String(req.query.email||'').trim().toLowerCase();
    if(!/^\S+@\S+\.\S+$/.test(email)) return json(res,400,{error:'Valid email is required'});
    const sb=supabaseAdmin();
    const {data,error}=await sb.from('pro_entitlements').select('status,expires_at').eq('email',email).maybeSingle();
    if(error) throw error;
    const active=!!data && data.status==='active' && new Date(data.expires_at).getTime()>Date.now();
    return json(res,200,{active,expires_at:data?.expires_at||null});
  }catch(e){return json(res,500,{error:e.message||'Unable to check Pro status'});}
};
