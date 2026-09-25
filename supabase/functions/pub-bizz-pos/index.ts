import { createClient } from 'supabase';
import './catalog.js';
import './core.js';
import './server-domain.js';

const C = (globalThis as any).POSCore;
const Domain = (globalThis as any).POSServerDomain;
const url = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db = createClient(url, serviceKey, {auth:{persistSession:false,autoRefreshToken:false}});
const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Cache-Control':'no-store','Content-Type':'application/json'};
const reply = (data: unknown, status=200) => new Response(JSON.stringify(data),{status,headers:cors});
const uuid = (s: unknown) => typeof s==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
const roles = ['owner','manager','staff','accountant'];
async function checked<T>(promise: PromiseLike<{data:T,error:any}>) { const {data,error}=await promise; if(error) throw error; return data; }
async function stateFor(venue:any) {
  const row:any=await checked(db.from('pos_registers').select('state').eq('venue_id',venue.id).maybeSingle());
  if(row?.state?.schema) return row.state;
  const s=C.initial(); s.venueId=venue.id; s.deviceId=venue.id; s.recipes={}; return s;
}
async function stockFor(venue:any) {
  return await checked(db.from('products').select('id,name,unit_mode,volume_ml,aliases,archived_at').eq('organization_id',venue.organization_id).is('archived_at',null).order('name').limit(5000));
}
async function snapshot(venue:any, result:any=null, knownStock:any=null) {
  const [state,stock,issues] = await Promise.all([
    stateFor(venue),knownStock||stockFor(venue),
    db.from('pos_stock_lines').select('*',{count:'exact'}).eq('venue_id',venue.id).in('status',['missing_recipe','shortage']).order('updated_at',{ascending:false}).limit(200)
  ]);
  if(issues.error) throw issues.error;
  return {state,stock,issues:issues.data,issueCount:issues.count,result,role:venue.role,venue};
}

Deno.serve(async (req: Request) => {
  if(req.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
  if(!['GET','POST'].includes(req.method)) return reply({error:'Nepovolená metoda.'},405);
  try {
    const token=req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
    if(!token) return reply({error:'Přihlas se účtem PUB GURU.'},401);
    const {data:{user},error:authError}=await db.auth.getUser(token);
    if(authError||!user) return reply({error:'Přihlášení vypršelo. Přihlas se znovu.'},401);
    const memberships:any=await checked(db.from('memberships').select('organization_id,role').eq('user_id',user.id).in('role',roles));
    if(!memberships.length) return reply({error:'Tento účet nemá přístup k provozovně PUB GURU.'},403);
    const venues:any=await checked(db.from('venues').select('id,organization_id,name,currency,timezone').in('organization_id',memberships.map((m:any)=>m.organization_id)));
    for(const venue of venues) venue.role=memberships.find((m:any)=>m.organization_id===venue.organization_id).role;
    const query=new URL(req.url).searchParams;
    let body:any=null;
    if(req.method==='POST') {
      const raw=await req.text();
      if(raw.length>200000) return reply({error:'Příliš velký požadavek.'},413);
      try { body=JSON.parse(raw); } catch { return reply({error:'Neplatný požadavek.'},400); }
    }
    const venueId=body?.venueId||query.get('venueId');
    if(!venueId && req.method==='GET') return reply({venues,user:{id:user.id,email:user.email}});
    const venue=venues.find((v:any)=>v.id===venueId);
    if(!venue) return reply({error:'K této provozovně nemáš přístup.'},403);
    if(venue.currency!=='CZK') return reply({error:'Tato pokladna pracuje v Kč. Provozovna má jinou měnu.'},400);
    if(req.method==='GET') return reply(await snapshot(venue));
    if(!uuid(body.requestId)||typeof body.type!=='string'||!body.payload||typeof body.payload!=='object'||Array.isArray(body.payload)) return reply({error:'Neplatná operace.'},400);
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({type:body.type,payload:body.payload}))))).map(x=>x.toString(16).padStart(2,'0')).join('');
    const previous:any=await checked(db.from('pos_requests').select('request_hash,actor_id,result').eq('venue_id',venue.id).eq('request_id',body.requestId).maybeSingle());
    if(previous) {
      if(previous.request_hash!==hash||previous.actor_id!==user.id) return reply({error:'Identifikátor operace byl použit jinak.'},409);
      return reply(await snapshot(venue,previous.result));
    }
    const stock:any=await stockFor(venue);
    for(let attempt=0;attempt<4;attempt++) {
      const s=await stateFor(venue);
      const payload=structuredClone(body.payload);
      if(body.type==='checkout') payload.operationId=body.requestId;
      let command:any;
      try {command=Domain.run(s,body.type,payload,{id:user.id,role:venue.role},stock);}
      catch(e) {
        const already:any=await checked(db.from('pos_requests').select('request_hash,actor_id,result').eq('venue_id',venue.id).eq('request_id',body.requestId).maybeSingle());
        if(already?.request_hash===hash && already.actor_id===user.id) return reply(await snapshot(venue,already.result,stock));
        return reply({error:(e as Error).message,definitive:true},422);
      }
      const commit:any=await checked(db.rpc('pos_commit',{
        p_venue:venue.id,p_actor:user.id,p_request:body.requestId,p_hash:hash,p_expected:s.revision,
        p_type:body.type,p_state:command.state,p_result:command.result
      }));
      if(!commit.conflict) return reply(await snapshot(venue,commit.result,stock));
      // Another device committed first. Recheck deduplication before executing again.
      const duplicate:any=await checked(db.from('pos_requests').select('request_hash,actor_id,result').eq('venue_id',venue.id).eq('request_id',body.requestId).maybeSingle());
      if(duplicate) {
        if(duplicate.request_hash!==hash||duplicate.actor_id!==user.id) return reply({error:'Identifikátor operace byl použit jinak.'},409);
        return reply(await snapshot(venue,duplicate.result,stock));
      }
    }
    return reply({error:'Pokladna je právě vytížená. Ověř uloženou operaci znovu.'},503);
  } catch(e) {
    console.error('POS operation failed', (e as any)?.code || 'internal');
    return reply({error:'Server operaci nepotvrdil. Použij ověření uložené operace; neposílej novou platbu.'},503);
  }
});
