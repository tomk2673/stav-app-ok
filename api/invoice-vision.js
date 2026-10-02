'use strict';
const OpenAI = require('openai');
const SUPABASE_URL='https://gnfqlfxuagcgjztaueot.supabase.co';
const schema={type:'object',additionalProperties:false,properties:{
 supplier:{type:['string','null']},invoice_number:{type:['string','null']},issue_date:{type:['string','null']},
 total_net:{type:['number','null']},total_vat:{type:['number','null']},total_gross:{type:['number','null']},
 confidence:{type:'number'},warnings:{type:'array',items:{type:'string'}},
 lines:{type:'array',items:{type:'object',additionalProperties:false,properties:{
  raw_name:{type:'string'},source_code:{type:['string','null']},quantity:{type:['number','null']},unit:{type:['string','null']},
  unit_price_net:{type:['number','null']},vat_rate:{type:['number','null']},line_total_net:{type:['number','null']},
  line_total_gross:{type:['number','null']},is_bonus:{type:'boolean'},confidence:{type:'number'},warning:{type:['string','null']}
 },required:['raw_name','source_code','quantity','unit','unit_price_net','vat_rate','line_total_net','line_total_gross','is_bonus','confidence','warning']}}
},required:['supplier','invoice_number','issue_date','total_net','total_vat','total_gross','confidence','warnings','lines']};

module.exports=async function(req,res){
 if(req.method!=='POST')return res.status(405).json({error:'method_not_allowed'});
 const auth=req.headers.authorization||'';
 if(!auth.startsWith('Bearer '))return res.status(401).json({error:'login_required'});
 const verify=await fetch(SUPABASE_URL+'/auth/v1/user',{headers:{Authorization:auth,apikey:process.env.SUPABASE_PUBLISHABLE_KEY||''}});
 if(!verify.ok)return res.status(401).json({error:'invalid_session'});
 if(!process.env.OPENAI_API_KEY)return res.status(503).json({error:'vision_not_configured'});
 const {data_url,file_data,file_name,mime_type,ocr_text}=req.body||{};
 const encoded=String(data_url||file_data||'').split(',').pop();
 if(!encoded)return res.status(400).json({error:'document_required'});
 if(Math.ceil(encoded.length*.75)>12*1024*1024)return res.status(413).json({error:'document_too_large'});
 const attachment=mime_type==='application/pdf'
  ?{type:'input_file',filename:file_name||'invoice.pdf',file_data}
  :{type:'input_image',image_url:data_url,detail:'high'};
 const client=new OpenAI();
 try{
  const response=await client.responses.create({
   model:process.env.OPENAI_INVOICE_MODEL||'gpt-6-luna',store:false,
   instructions:'Jsi přesná účetní čtečka českých faktur. Čti přímo obraz nebo PDF, ne OCR. Vrať všechny položkové řádky v pořadí dokladu, včetně nulových/bonusových řádků a vratných obalů. Nikdy nehádej nečitelná čísla: vrať null a warning. Rozliš množství, jednotku, cenu bez DPH, DPH, netto a brutto. Bonus označ jen pokud jej doklad skutečně podporuje. Aritmetiku použij ke kontrole, ne k domýšlení.',
   input:[{role:'user',content:[{type:'input_text',text:'Přečti fakturu. Pomocný OCR přepis může obsahovat chyby:\n'+String(ocr_text||'').slice(0,12000)},attachment]}],
   text:{format:{type:'json_schema',name:'invoice_read',strict:true,schema}}
  });
  return res.status(200).json({provider:'openai-vision',model:response.model,invoice:JSON.parse(response.output_text)});
 }catch(error){
  console.error('invoice vision',error);
  return res.status(502).json({error:'vision_provider_error',detail:error?.message||'Vision read failed'});
 }
};