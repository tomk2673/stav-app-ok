'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const database=path.resolve(__dirname,'../../../database');
const ids={user:'10000000-0000-4000-8000-000000000001',org:'20000000-0000-4000-8000-000000000001',
  venue:'30000000-0000-4000-8000-000000000001',product:'40000000-0000-4000-8000-000000000001',
  invoice:'50000000-0000-4000-8000-000000000001',otherOrg:'20000000-0000-4000-8000-000000000002'};

async function setup({total=1089,lines=[{quantity:10,unit_price_net:100,unit_price_gross:121,vat_rate:21,
  line_total_net:900,line_total_gross:1089}],counted=false}={}){
  const db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;
    create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
  await db.exec(fs.readFileSync(path.join(database,'schema.sql'),'utf8').replace('create extension if not exists pgcrypto;',''));
  for(const name of ['role_based_access_v1.sql','fix_role_helper_rls_recursion.sql','007_remove_recursive_membership_owner_read.sql',
    '002_product_client_key.sql','003_lock_financial_records.sql','005_product_runtime_fields.sql',
    '006_atomic_invoice_posting_guard.sql','007_immutable_stock_ledger.sql','008_tighten_invoice_closing_role_guards.sql',
    '20260901_invoice_line_vat_fields.sql','20260902_invoice_gross_and_payment_tracking.sql','20260904025648_counted_inventory_backend.sql']){
    await db.exec(fs.readFileSync(path.join(database,name),'utf8'));
  }
  await db.exec(`insert into auth.users values ('${ids.user}');
    insert into organizations(id,name,created_by) values ('${ids.org}','Test','${ids.user}'),('${ids.otherOrg}','Other','${ids.user}');
    insert into venues(id,organization_id,name,created_by) values ('${ids.venue}','${ids.org}','Test','${ids.user}');
    insert into memberships(organization_id,user_id,role) values ('${ids.org}','${ids.user}','manager');`);
  await db.query(`insert into products(id,organization_id,name,volume_ml,unit_mode,item_kind,item_subtype,current_purchase_price,current_purchase_price_gross)
    values ($1,$2,'Test product',$3,$4,$5,$6,100,121)`,[ids.product,ids.org,counted?null:700,counted?'counted':'liquid',counted?'packaging':'product',counted?'crate':null]);
  await db.query(`insert into invoices(id,organization_id,venue_id,supplier_name,invoice_number,issue_date,total_amount,total_amount_gross,source_fingerprint,status,created_by)
    values ($1,$2,$3,'Test supplier','TEST-2026','2026-10-12',$4,$4,'source-once','review',$5)`,[ids.invoice,ids.org,ids.venue,total,ids.user]);
  for(const [i,l] of lines.entries()){
    await db.query(`insert into invoice_lines(invoice_id,organization_id,raw_name,product_id,quantity,unit_price,unit_price_net,unit_price_gross,vat_rate,line_total_net,line_total_gross,status,original_values)
      values ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12)`,[
      ids.invoice,ids.org,l.raw_name||'Test product',l.status==='ignored'?null:ids.product,l.quantity??null,l.unit_price_net??null,
      l.unit_price_gross??null,l.vat_rate??null,l.line_total_net??null,l.line_total_gross??null,l.status||'review',
      JSON.stringify({ocr_qty:l.quantity,ocr_unit_gross:l.unit_price_gross,ocr_line_gross:l.line_total_gross,source_code:null,index:i})]);
  }
  await db.exec(`select set_config('request.jwt.claim.sub','${ids.user}',false);set role authenticated;`);
  return {db,ids};
}

// This transport only replaces HTTP: SQL constraints, RLS, triggers and rollback are real.
function clientFor(db){
  const writes=[];
  const identifier=value=>{if(!/^[a-z_]+$/.test(value))throw new Error('Invalid test identifier');return '"'+value+'"';};
  function from(table){
    if(!['products','invoices','invoice_lines','purchase_price_history','audit_events'].includes(table))throw new Error('Unexpected table '+table);
    let action='select',payload,columns='*',conditions=[],order='',limit='',args=[];
    const param=value=>{args.push(value);return '$'+args.length;};
    const q={select(value='*'){columns=value;return this;},eq(key,value){conditions.push(`${identifier(key)}=${param(value)}`);return this;},
      is(key,value){if(value!==null)throw new Error('Unexpected is');conditions.push(identifier(key)+' is null');return this;},
      in(key,values){conditions.push(`${identifier(key)} in (${values.map(param).join(',')})`);return this;},
      order(key,options={}){order=' order by '+identifier(key)+(options.ascending===false?' desc':' asc');return this;},
      limit(value){limit=' limit '+Number(value);return this;},update(data){action='update';payload=data;return this;},
      insert(data){action='insert';payload=data;return this;},single(){return execute(true);},maybeSingle(){return execute(false,true);},
      then(resolve,reject){return execute().then(resolve,reject);}};
    async function execute(single=false,optional=false){
      try{
        const cols=columns==='*'?'*':columns.split(',').map(identifier).join(','),where=conditions.length?' where '+conditions.join(' and '):'';
        const keys=payload?Object.keys(payload):[];
        const val=key=>param(['before_data','after_data','original_values'].includes(key)?JSON.stringify(payload[key]):payload[key]);
        const sql=action==='select'?`select ${cols} from ${identifier(table)}${where}${order}${limit}`:
          action==='update'?`update ${identifier(table)} set ${keys.map(k=>`${identifier(k)}=${val(k)}`).join(',')}${where} returning ${cols}`:
          `insert into ${identifier(table)}(${keys.map(identifier).join(',')}) values (${keys.map(val).join(',')}) returning ${cols}`;
        const result=await db.query(sql,args);
        const rows=result.rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>
          [key,value instanceof Date?(key==='issue_date'?value.toISOString().slice(0,10):value.toISOString()):value])));
        if(single&&rows.length!==1)return {data:null,error:new Error('Expected exactly one row')};
        if(action!=='select')writes.push({table,action,payload});
        return {data:single||optional?(rows[0]||null):rows,error:null};
      }catch(error){return {data:null,error};}
    }
    return q;
  }
  return {from,writes};
}
module.exports={setup,clientFor,ids};
