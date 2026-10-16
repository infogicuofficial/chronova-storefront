import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const cors = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods':'POST, OPTIONS', 'Content-Type':'application/json' };
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
const esc=(s:unknown)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const supabase=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

async function sendWithFallback(to:string,subject:string,html:string,replyTo?:string){
  const from=Deno.env.get('MAIL_FROM')||'Chronova BD <orders@example.com>';
  const resend=Deno.env.get('RESEND_API_KEY');
  if(resend){
    try {
      const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${resend}`,'Content-Type':'application/json'},body:JSON.stringify({from,to:[to],subject,html,reply_to:replyTo})});
      if(r.ok) return 'resend';
    } catch { /* attempt configured backup provider */ }
  }
  const brevo=Deno.env.get('BREVO_API_KEY');
  if(brevo){
    try {
      const [name,email]=from.includes('<')?[from.split('<')[0].trim(),from.split('<')[1].replace('>','').trim()]:['Chronova BD',from];
      const r=await fetch('https://api.brevo.com/v3/smtp/email',{method:'POST',headers:{'api-key':brevo,'Content-Type':'application/json','accept':'application/json'},body:JSON.stringify({sender:{name,email},to:[{email:to}],replyTo:replyTo?{email:replyTo}:undefined,subject,htmlContent:html})});
      if(r.ok) return 'brevo';
    } catch { /* record failure below */ }
  }
  return 'failed';
}
function mailHtml(title:string,body:string,orderNo:string){
  return `<!doctype html><html><body style="margin:0;background:#f2f0ea;font-family:Arial,sans-serif;color:#26384f"><div style="max-width:640px;margin:28px auto;background:#fff;border:1px solid #dedbd4"><div style="height:7px;background:linear-gradient(90deg,#922b3b 0 34%,#18385f 34% 100%)"></div><header style="padding:24px 32px;border-bottom:1px solid #e7e5df"><strong style="font-family:Georgia,serif;font-size:25px;color:#18385f">C.</strong><span style="margin-left:12px;font-weight:bold;letter-spacing:1px">CHRONOVA <small style="display:block;margin-left:40px;font-size:10px;letter-spacing:3px">BANGLADESH</small></span></header><main style="padding:32px"><p style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#8d2837;font-weight:bold">${esc(title)}</p><h1 style="font-family:Georgia,serif;font-size:30px;font-weight:normal;margin:12px 0">Your order is in motion.</h1>${body}<p style="margin-top:24px;color:#687486;font-size:14px">Order reference: <strong style="color:#18385f">${esc(orderNo)}</strong></p><p style="font-size:14px;line-height:1.7">We’ll keep you informed as your order progresses. If you need help, reply to this email or contact our team.</p><p style="font-size:14px">Kind regards,<br><strong>Chronova BD</strong></p></main><footer style="padding:20px 32px;background:#f8f7f4;border-top:1px solid #e7e5df;color:#7d8490;font-size:12px">Chronova BD · Thoughtful timepieces, selected with care.<br><br>This message relates to order ${esc(orderNo)}.</footer></div></body></html>`;
}
Deno.serve(async(req)=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers:cors});
  if(req.method!=='POST') return json({ok:false,message:'Method not allowed'},405);
  try {
    const body=await req.json();
    if(body.action==='create-order'){
      const order=body.order||{};
      const {data:created,error}=await supabase.rpc('create_public_order',{p_customer:order.customer,p_items:(order.items||[]).map((x:any)=>({productId:x.productId,quantity:x.quantity})),p_payment_method:order.paymentMethod,p_shipping_zone:String(order.shippingZone),p_idempotency_key:String(order.requestId||'')});
      if(error) return json({ok:false,message:error.message},400);
      const {data:items}=await supabase.from('order_items').select('product_name,quantity,unit_price,line_total').eq('order_id',created.id);
      const list=(items||[]).map((x:any)=>`<tr><td style="padding:9px 0;border-bottom:1px solid #eee">${esc(x.quantity)} × ${esc(x.product_name)}</td><td style="padding:9px 0;border-bottom:1px solid #eee;text-align:right">BDT ${Number(x.line_total).toLocaleString('en-BD')}</td></tr>`).join('');
      const summary=`<table style="width:100%;border-collapse:collapse;font-size:14px">${list}<tr><td style="padding:12px 0">Total</td><td style="text-align:right;font-weight:bold;color:#18385f">BDT ${Number(created.total).toLocaleString('en-BD')}</td></tr></table>`;
      const customerHtml=mailHtml('ORDER RECEIVED',`<p style="font-size:15px;line-height:1.7">Dear ${esc(order.customer.name)}, thank you. We’ve received your order and will contact you to confirm delivery details.</p>${summary}<p style="font-size:14px">Payment: ${esc(order.paymentMethod)}. No payment is taken by this website.</p>`,created.orderNumber);
      const adminHtml=mailHtml('NEW CUSTOMER ORDER',`<p style="font-size:14px;line-height:1.7">A new website order has arrived. Please review it in the owner order system.</p><p><strong>${esc(order.customer.name)}</strong><br>${esc(order.customer.phone)}<br>${esc(order.customer.email)}<br>${esc(order.customer.address)}, ${esc(order.customer.area)}, ${esc(order.customer.city)}</p>${summary}`,created.orderNumber);
      const store=Deno.env.get('STORE_EMAIL');
      const customerStatus=await sendWithFallback(order.customer.email,`Chronova BD order received — ${created.orderNumber}`,customerHtml);
      const storeStatus=store?await sendWithFallback(store,`New Chronova BD order — ${created.orderNumber}`,adminHtml,order.customer.email):'not-configured';
      return json({ok:true,orderNumber:created.orderNumber,status:created.status,subtotal:created.subtotal,shippingFee:created.shippingFee,total:created.total,customerEmailStatus:customerStatus,storeEmailStatus:storeStatus,notification:customerStatus==='failed'?'failed':storeStatus==='failed'||storeStatus==='not-configured'?'partial':'sent'});
    }
    if(body.action==='track-order'){
      const orderNo=String(body.orderNumber||'').trim(); const email=String(body.email||'').trim().toLowerCase();
      if(!orderNo||!email) return json({ok:true,order:null});
      const {data:order,error}=await supabase.from('orders').select('order_number,status,created_at,updated_at,total,customer_email').ilike('order_number',orderNo).eq('customer_email',email).maybeSingle();
      if(error||!order) return json({ok:true,order:null});
      const {data:history}=await supabase.from('order_status_history').select('status,customer_note,created_at').eq('order_id',(await supabase.from('orders').select('id').eq('order_number',order.order_number).single()).data?.id).order('created_at',{ascending:true});
      return json({ok:true,order:{orderNumber:order.order_number,status:order.status,createdAt:order.created_at,updatedAt:order.updated_at,total:order.total,history:history||[]}});
    }
    return json({ok:false,message:'Unknown action'},400);
  } catch(e){ console.error(e); return json({ok:false,message:'Unexpected error. Please try again.'},500); }
});
