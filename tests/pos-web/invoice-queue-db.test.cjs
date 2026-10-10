'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const database=path.resolve(__dirname,'../../database');
const uid='10000000-0000-4000-8000-000000000001';
const org='20000000-0000-4000-8000-000000000001';
const venue='30000000-0000-4000-8000-000000000001';
const otherOrg='20000000-0000-4000-8000-000000000002';
const otherVenue='30000000-0000-4000-8000-000000000002';
const jobId='40000000-0000-4000-8000-000000000001';
const migration='20261010033954_invoice_capture_queue_worker.sql';

async function setup(){
  const db=new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
    $$;
  `);
  const schema=fs.readFileSync(path.join(database,'schema.sql'),'utf8');
  await db.exec(schema.slice(0,schema.indexOf('-- RLS:')).replace('create extension if not exists pgcrypto;',''));
  await db.exec(`
    create function public.has_org_role(p_org uuid,p_roles text[]) returns boolean
    language sql security definer set search_path='' as $$
      select exists(select 1 from public.memberships where organization_id=p_org and user_id=auth.uid() and role=any(p_roles));
    $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
    insert into auth.users values ('${uid}');
    insert into organizations(id,name,created_by) values ('${org}','A','${uid}'),('${otherOrg}','B','${uid}');
    insert into venues(id,organization_id,name,created_by) values ('${venue}','${org}','A','${uid}'),('${otherVenue}','${otherOrg}','B','${uid}');
    insert into memberships(organization_id,user_id,role) values ('${org}','${uid}','staff');
  `);
  await db.exec(fs.readFileSync(path.join(database,'20260901_invoice_line_vat_fields.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(database,'20260902_invoice_gross_and_payment_tracking.sql'),'utf8'));
  const queue=fs.readFileSync(path.join(database,'20260902_invoice_capture_background_queue.sql'),'utf8');
  await db.exec(queue.slice(0,queue.indexOf('insert into storage.buckets')).replace('grant all on public.invoice_capture_jobs to service_role;',''));
  await db.exec(fs.readFileSync(path.join(database,migration),'utf8'));
  await db.exec(`
    insert into invoice_capture_jobs(id,organization_id,venue_id,created_by,source_path,source_fingerprint)
    values ('${jobId}','${org}','${venue}','${uid}','${org}/${venue}/${uid}/test.jpg','original-fingerprint');
    select set_config('request.jwt.claim.sub','${uid}',false); set role authenticated;
  `);
  return db;
}

async function command(db,action,extra={}){
  const {rows}=await db.query('select public.invoice_capture_command($1,$2,$3,$4,$5,$6,$7) as result',[
    action,extra.org || org,extra.venue || venue,extra.job_id || null,extra.token || null,
    extra.result?JSON.stringify(extra.result):null,extra.error || null
  ]);
  return rows[0].result;
}

const extraction={raw_text:'Dodavatel: Test\nCelkem: 121,00',supplier:'Test',invoice_number:'1',issue_date:null,
  total_gross:121,provider:'tesseract-browser-v3',crop:{provider:'tesseract-browser-v3',model:null},
  lines:[{rawName:'Vodka',qty:1,price:100,vatRate:21,lineNet:100,lineGross:121,productId:'',warning:'ověřit'}]};

test('queue atomically stores invoice, lines and audit; replays and duplicate sources never write twice',async()=>{
  const db=await setup();
  try{
    const job=await command(db,'claim');
    assert.equal(job.id,jobId);assert.equal(job.status,'processing');assert.equal(job.attempts,1);
    assert.equal(await command(db,'claim'),null,'a second device cannot claim the live lease');
    const result=await command(db,'complete',{job_id:job.id,token:job.claim_token,result:extraction});
    assert.equal(result.status,'review');assert.equal(result.duplicate,false);
    assert.deepEqual(await command(db,'complete',{job_id:job.id,token:job.claim_token,result:extraction}),result);
    await db.exec('reset role');
    const count=await db.query(`select (select count(*) from invoices)::int as invoices,(select count(*) from invoice_lines)::int as lines,(select count(*) from audit_events)::int as audit,(select count(*) from stock_movements)::int as stock`);
    assert.deepEqual(count.rows[0],{invoices:1,lines:1,audit:1,stock:0});
    const saved=(await db.query('select * from invoices')).rows[0];
    assert.equal(saved.source_fingerprint,'original-fingerprint');assert.equal(saved.issue_date,null);
    assert.equal(saved.status,'review');assert.equal(saved.raw_extraction.source_path,`${org}/${venue}/${uid}/test.jpg`);
    const audit=(await db.query('select after_data from audit_events')).rows[0].after_data;
    assert.equal(audit.extraction_provider,saved.extraction_provider);
  }finally{await db.close();}
});

test('a rejected line rolls back the entire completion; failure/retry retains the original source',async()=>{
  const db=await setup();
  try{
    const job=await command(db,'claim');
    await assert.rejects(command(db,'complete',{job_id:job.id,token:job.claim_token,
      result:{...extraction,lines:[...extraction.lines,{rawName:'foreign',productId:uid}]}}),/organization mismatch/);
    await db.exec('reset role');
    assert.equal((await db.query('select count(*)::int as n from invoices')).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int as n from invoice_lines')).rows[0].n,0);
    await db.exec('set role authenticated');
    await command(db,'fail',{job_id:job.id,token:job.claim_token,error:'OCR timeout'});
    assert.equal((await command(db,'summary')).counts.failed,1);
    await command(db,'retry',{job_id:job.id});
    const retried=await command(db,'claim');assert.equal(retried.id,job.id);assert.notEqual(retried.claim_token,job.claim_token);
    assert.equal(retried.source_path,job.source_path);
    await assert.rejects(command(db,'complete',{job_id:job.id,token:job.claim_token,result:extraction}),/lease lost/);
  }finally{await db.close();}
});

test('interrupted leases recover; heartbeat prevents takeover; third abandoned attempt is a visible failure',async()=>{
  const db=await setup();
  try{
    const first=await command(db,'claim');
    await db.exec(`reset role; update invoice_capture_jobs set started_at=now()-interval '11 minutes'; set role authenticated;`);
    const recovered=await command(db,'claim');assert.equal(recovered.attempts,2);assert.notEqual(recovered.claim_token,first.claim_token);
    await command(db,'heartbeat',{job_id:jobId,token:recovered.claim_token});
    assert.equal(await command(db,'claim'),null);
    await db.exec(`reset role; update invoice_capture_jobs set started_at=now()-interval '11 minutes',attempts=3; set role authenticated;`);
    assert.equal(await command(db,'claim'),null);
    assert.equal((await command(db,'summary')).counts.failed,1);
  }finally{await db.close();}
});

test('anonymous, other organizations, mismatched venues and direct job updates are denied',async()=>{
  const db=await setup();
  try{
    await assert.rejects(command(db,'summary',{org:otherOrg,venue:otherVenue}),/access denied/);
    await assert.rejects(command(db,'claim',{venue:otherVenue}),/venue mismatch/);
    await assert.rejects(db.query(`update invoice_capture_jobs set status='review' where id=$1`,[jobId]),/permission denied/);
    await db.exec("reset role; select set_config('request.jwt.claim.sub','',false); set role authenticated;");
    await assert.rejects(command(db,'claim'),/access denied/);
    await db.exec('reset role; set role anon');
    await assert.rejects(command(db,'summary'),/permission denied/);
  }finally{await db.close();}
});

test('existing manual invoice is linked without re-reading or overwriting its records',async()=>{
  const db=await setup();
  try{
    await db.exec(`reset role; insert into invoices(organization_id,venue_id,created_by,source_fingerprint,status)
      values ('${org}','${venue}','${uid}','original-fingerprint','posted'); set role authenticated;`);
    const job=await command(db,'claim');
    const result=await command(db,'complete',{job_id:job.id,token:job.claim_token,result:{duplicate_invoice_id:'ignored-client-id'}});
    assert.equal(result.duplicate,true);
    await db.exec('reset role');
    assert.equal((await db.query('select status from invoices')).rows[0].status,'posted');
    assert.equal((await db.query('select count(*)::int as n from audit_events')).rows[0].n,0);
  }finally{await db.close();}
});
