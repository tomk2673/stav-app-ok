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
const followup='20261010141443_invoice_approval_queue_completion.sql';

async function setup({posting=false,installFollowup=true}={}){
  const db=new PGlite();
  try{
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
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
  if(posting){
    await db.exec(schema.slice(schema.indexOf('-- RLS:')));
    for(const name of ['fix_role_helper_rls_recursion.sql','role_based_access_v1.sql',
      '002_product_client_key.sql','005_product_runtime_fields.sql',
      '003_lock_financial_records.sql','006_atomic_invoice_posting_guard.sql',
      '007_immutable_stock_ledger.sql','008_tighten_invoice_closing_role_guards.sql',
      '20260904025648_counted_inventory_backend.sql']){
      await db.exec(fs.readFileSync(path.join(database,name),'utf8'));
    }
  }
  const queue=fs.readFileSync(path.join(database,'20260902_invoice_capture_background_queue.sql'),'utf8');
  await db.exec(queue.slice(0,queue.indexOf('insert into storage.buckets')).replace('grant all on public.invoice_capture_jobs to service_role;',''));
  await db.exec(fs.readFileSync(path.join(database,migration),'utf8'));
  if(installFollowup)await db.exec(fs.readFileSync(path.join(database,followup),'utf8'));
  await db.exec(`
    insert into invoice_capture_jobs(id,organization_id,venue_id,created_by,source_path,source_fingerprint)
    values ('${jobId}','${org}','${venue}','${uid}','${org}/${venue}/${uid}/test.jpg','original-fingerprint');
    select set_config('request.jwt.claim.sub','${uid}',false); set role authenticated;
  `);
  return db;
  }catch(error){await db.close();throw error;}
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
    assert.equal(result.status,'done');
    assert.equal((await command(db,'summary')).counts.review,undefined);
    assert.equal((await command(db,'summary')).jobs[0].status,'done');
    await db.exec('reset role');
    assert.equal((await db.query('select status from invoices')).rows[0].status,'posted');
    assert.equal((await db.query('select count(*)::int as n from audit_events')).rows[0].n,0);
  }finally{await db.close();}
});

async function reviewInvoice(db){
  const job=await command(db,'claim');
  const saved=await command(db,'complete',{job_id:job.id,token:job.claim_token,result:extraction});
  await db.exec(`reset role;
    update memberships set role='manager' where organization_id='${org}' and user_id='${uid}';
    insert into products(id,organization_id,name,volume_ml) values ('${uid}','${org}','Vodka',700);
    update invoice_lines set product_id='${uid}',quantity=1,status='approved';
    set role authenticated;
  `);
  return saved.invoice_id;
}

async function approve(db,id){
  return db.query("update invoices set status='approved' where id=$1 and status in ('review','approved') returning id",[id]);
}

async function postAudit(db,id){
  return db.query(`insert into audit_events(organization_id,venue_id,actor_user_id,event_type,entity_type,entity_id)
    values ($1,$2,$3,'invoice.posted','invoice',$4) returning id`,[org,venue,uid,id]);
}

async function snapshot(db){
  const {rows}=await db.query(`select
    (select status from invoices limit 1) as invoice_status,
    (select status from invoice_capture_jobs where id='${jobId}') as job_status,
    (select count(*) from invoices)::int as invoices,
    (select count(*) from invoice_lines)::int as lines,
    (select count(*) from stock_movements)::int as stock,
    (select count(*) from audit_events where event_type='invoice.captured_for_review')::int as captured,
    (select count(*) from audit_events where event_type='invoice.posted')::int as posted,
    (select count(*) from audit_events where event_type='invoice.capture_queue_completed')::int as completed`);
  return rows[0];
}

test('successful posting atomically finishes only the linked job and preserves capture and posting audits',async()=>{
  const db=await setup({posting:true});
  try{
    const id=await reviewInvoice(db);
    assert.equal((await command(db,'summary')).counts.review,1);
    await approve(db,id);
    assert.equal((await command(db,'summary')).counts.review,1,'approved alone is an interrupted save, not completion');
    await postAudit(db,id);
    assert.deepEqual(await snapshot(db),{invoice_status:'posted',job_status:'done',invoices:1,lines:1,stock:1,captured:1,posted:1,completed:1});
    const summary=await command(db,'summary');
    assert.equal(summary.counts.review,undefined);assert.equal(summary.counts.done,1);
    assert.equal(summary.jobs[0].status,'done');
    const job=(await db.query('select result from invoice_capture_jobs where id=$1',[jobId])).rows[0];
    assert.deepEqual(job.result,{invoice_id:id,duplicate:false,status:'done'});
    const audit=(await db.query("select after_data from audit_events where event_type='invoice.capture_queue_completed'")).rows[0];
    assert.deepEqual(audit.after_data.capture_job_ids,[jobId]);
  }finally{await db.close();}
});

test('repeated posting and replay after a lost response cannot duplicate stock, invoice lines or queue completion audit',async()=>{
  const db=await setup({posting:true});
  try{
    const id=await reviewInvoice(db);await approve(db,id);await postAudit(db,id);
    const before=await snapshot(db);
    assert.equal((await approve(db,id)).rows.length,0,'stale browser must not write a new posting audit after this result');
    await assert.rejects(db.query("update invoices set status='approved' where id=$1",[id]),/immutable/);
    const replay=await command(db,'complete',{job_id:jobId,result:extraction});
    assert.equal(replay.status,'done');assert.equal(replay.invoice_id,id);
    assert.deepEqual(await snapshot(db),before);
    await postAudit(db,id); // Existing finalizer also tolerates a repeated audit request.
    const repeated=await snapshot(db);
    assert.equal(repeated.stock,1);assert.equal(repeated.completed,1);assert.equal(repeated.captured,1);
  }finally{await db.close();}
});

test('interruption before audit keeps review pending; retry completes without another capture or stock receipt',async()=>{
  const db=await setup({posting:true});
  try{
    const id=await reviewInvoice(db);await approve(db,id);
    assert.equal((await snapshot(db)).job_status,'review');assert.equal((await snapshot(db)).stock,0);
    assert.equal((await command(db,'summary')).counts.review,1);
    await approve(db,id);await postAudit(db,id);
    assert.equal((await snapshot(db)).stock,1);assert.equal((await snapshot(db)).completed,1);
    assert.equal((await command(db,'summary')).counts.done,1);
  }finally{await db.close();}
});

test('failed stock validation rolls back posting audit and never completes a review job',async()=>{
  const db=await setup({posting:true});
  try{
    const id=await reviewInvoice(db);await approve(db,id);
    await db.exec(`reset role; update products set volume_ml=null where id='${uid}'; set role authenticated;`);
    await assert.rejects(postAudit(db,id),/valid package volume/);
    const state=await snapshot(db);
    assert.equal(state.invoice_status,'approved');assert.equal(state.job_status,'review');
    assert.equal(state.stock,0);assert.equal(state.posted,0);assert.equal(state.completed,0);assert.equal(state.captured,1);
    assert.equal((await command(db,'summary')).counts.review,1);
    await db.exec(`reset role; update products set volume_ml=700 where id='${uid}'; set role authenticated;`);
    await postAudit(db,id);assert.equal((await snapshot(db)).job_status,'done');
  }finally{await db.close();}
});

test('a queue save failure or explicit transaction rollback rolls back stock, posting and completion audit together',async()=>{
  const db=await setup({posting:true});
  try{
    const id=await reviewInvoice(db);await approve(db,id);
    const before=await snapshot(db);
    await db.exec(`reset role;
      create function public.reject_test_queue_completion() returns trigger language plpgsql as $$
        begin raise exception 'Injected queue save failure'; end; $$;
      create trigger reject_test_queue_completion before update on invoice_capture_jobs
        for each row when (new.status='done') execute function public.reject_test_queue_completion();
      set role authenticated;`);
    await assert.rejects(postAudit(db,id),/Injected queue save failure/);
    assert.deepEqual(await snapshot(db),before);
    await db.exec('reset role; drop trigger reject_test_queue_completion on invoice_capture_jobs; set role authenticated;');
    await db.exec('begin');
    await postAudit(db,id);assert.equal((await snapshot(db)).job_status,'done');
    await db.exec('rollback');assert.deepEqual(await snapshot(db),before);
    await postAudit(db,id);assert.equal((await snapshot(db)).job_status,'done');
  }finally{await db.close();}
});

test('legacy posted jobs are displayed as done with accurate counts across the 50-row summary limit without writes',async()=>{
  const db=await setup({posting:true,installFollowup:false});
  try{
    const id=await reviewInvoice(db);await approve(db,id);await postAudit(db,id);
    assert.equal((await snapshot(db)).job_status,'review');
    await db.exec(`reset role;
      insert into invoice_capture_jobs(organization_id,venue_id,created_by,source_path,status)
        select '${org}','${venue}','${uid}','extra-'||n,'queued' from generate_series(1,51) n;`);
    await db.exec(fs.readFileSync(path.join(database,followup),'utf8'));
    await db.exec('set role authenticated');
    const before=await snapshot(db);
    const summary=await command(db,'summary');
    assert.equal(summary.counts.queued,51);assert.equal(summary.counts.done,1);assert.equal(summary.counts.review,undefined);
    assert.equal(summary.jobs.length,50);
    const one=await command(db,'summary',{job_id:jobId});
    assert.equal(one.jobs[0].status,'done');assert.deepEqual(one.counts,summary.counts);
    assert.equal((await command(db,'complete',{job_id:jobId})).status,'done');
    assert.deepEqual(await snapshot(db),before,'summary and legacy replay are read-only');
  }finally{await db.close();}
});

test('done derivation never trusts an approved, missing, malformed or cross-organization/venue invoice link',async()=>{
  const db=await setup();
  try{
    const job=await command(db,'claim');
    const result=await command(db,'complete',{job_id:jobId,token:job.claim_token,result:extraction});
    // Model legacy mismatches as a test administrator; this test exercises read-only derivation.
    await db.exec('reset role; alter table invoices disable trigger trg_complete_invoice_capture_on_post; set role authenticated');
    for(const changes of ["status='approved'",`status='posted',venue_id='${otherVenue}'`,
      `status='posted',organization_id='${otherOrg}',venue_id='${otherVenue}'`]){
      await db.exec(`reset role; update invoices set ${changes}; set role authenticated;`);
      assert.equal((await command(db,'summary')).counts.review,1);
    }
    for(const link of ['not-a-uuid','00000000-0000-4000-8000-000000000000',null]){
      await db.exec('reset role');
      await db.query('update invoice_capture_jobs set result=$1 where id=$2',[JSON.stringify({invoice_id:link}),jobId]);
      await db.exec('set role authenticated');
      assert.equal((await command(db,'summary')).counts.review,1);
    }
    assert.ok(result.invoice_id);
  }finally{await db.close();}
});

test('posting respects role and tenant permissions; clients still cannot update jobs or call the trigger function',async()=>{
  const db=await setup({posting:true});
  try{
    const id=await reviewInvoice(db);await approve(db,id);
    const before=await snapshot(db);
    await assert.rejects(db.query("update invoice_capture_jobs set status='done' where id=$1",[jobId]),/permission denied/);
    const privileges=(await db.query("select has_function_privilege('authenticated','private.complete_invoice_capture_on_post()','EXECUTE') as callable")).rows[0];
    assert.equal(privileges.callable,false);
    await assert.rejects(command(db,'summary',{org:otherOrg,venue:otherVenue}),/access denied/);
    await assert.rejects(command(db,'summary',{venue:otherVenue}),/venue mismatch/);
    await db.exec(`reset role; update memberships set role='staff' where organization_id='${org}'; set role authenticated;`);
    assert.equal((await approve(db,id)).rows.length,0);
    await assert.rejects(postAudit(db,id),/owner or manager|requires owner/);
    await db.exec(`reset role; update memberships set role='manager' where organization_id='${org}'; set role authenticated;`);
    assert.deepEqual(await snapshot(db),before);
    await db.exec("reset role; select set_config('request.jwt.claim.sub','',false); set role authenticated;");
    await assert.rejects(postAudit(db,id),/owner or manager|requires owner|row-level security/);
    await db.exec('reset role; set role anon');
    await assert.rejects(command(db,'summary'),/permission denied/);
  }finally{await db.close();}
});

test('posting does not finish another invoice or a job from another organization or venue',async()=>{
  const db=await setup({posting:true});
  try{
    const id=await reviewInvoice(db);
    await db.exec(`reset role;
      insert into venues(id,organization_id,name,created_by)
        values ('30000000-0000-4000-8000-000000000003','${org}','Other','${uid}');`);
    for(const [organization,location,linked] of [[org,venue,'unrelated'],[otherOrg,otherVenue,id],
      [org,'30000000-0000-4000-8000-000000000003',id]]){
      await db.query(`insert into invoice_capture_jobs(organization_id,venue_id,created_by,source_path,status,result)
        values ($1,$2,$3,'unrelated','review',$4)`,[organization,location,uid,JSON.stringify({invoice_id:linked,status:'review'})]);
    }
    await db.exec('set role authenticated');
    await approve(db,id);await postAudit(db,id);
    assert.equal((await command(db,'summary')).counts.done,1);
    assert.equal((await command(db,'summary')).counts.review,1);
    await db.exec('reset role');
    const other=(await db.query('select status from invoice_capture_jobs where id<>$1',[jobId])).rows;
    assert.equal(other.length,3);assert.ok(other.every(x=>x.status==='review'));
  }finally{await db.close();}
});
