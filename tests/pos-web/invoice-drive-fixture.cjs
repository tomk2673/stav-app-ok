'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {PGlite} = require('@electric-sql/pglite');
const actor = '10000000-0000-4000-8000-000000000001';
const stranger = '10000000-0000-4000-8000-000000000002';
const org = '20000000-0000-4000-8000-000000000001';
const otherOrg = '20000000-0000-4000-8000-000000000002';
const venue = '30000000-0000-4000-8000-000000000001';
const otherVenue = '30000000-0000-4000-8000-000000000002';
const secondVenue = '30000000-0000-4000-8000-000000000003';
const root = path.resolve(__dirname, '../..');
const migrationPath = path.join(root, 'supabase/migrations/20261014054956_invoice_drive_import.sql');
const hash = 'a'.repeat(64);

async function setup() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
    create schema storage; create table storage.buckets(id text primary key,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    insert into storage.buckets values('invoice-sources',false,8388608,array['image/jpeg','image/png','application/pdf']);`);
  const schema = fs.readFileSync(path.join(root, 'database/schema.sql'), 'utf8');
  await db.exec(schema.slice(0, schema.indexOf('-- RLS:')).replace('create extension if not exists pgcrypto;', ''));
  await db.exec(`create function public.has_org_role(p_org uuid,p_roles text[]) returns boolean language sql security definer set search_path='' as $$
    select exists(select 1 from public.memberships where organization_id=p_org and user_id=auth.uid() and role=any(p_roles)) $$;
    insert into auth.users values('${actor}'),('${stranger}');
    insert into organizations(id,name,created_by) values('${org}','FICTION A','${actor}'),('${otherOrg}','FICTION B','${actor}');
    insert into venues(id,organization_id,name,created_by) values('${venue}','${org}','FICTION A1','${actor}'),('${secondVenue}','${org}','FICTION A2','${actor}'),('${otherVenue}','${otherOrg}','FICTION B1','${actor}');
    insert into memberships(organization_id,user_id,role) values('${org}','${actor}','owner'),('${otherOrg}','${actor}','owner');`);
  for (const file of ['20260901_invoice_line_vat_fields.sql', '20260902_invoice_gross_and_payment_tracking.sql'])
    await db.exec(fs.readFileSync(path.join(root, 'database', file), 'utf8'));
  const queue = fs.readFileSync(path.join(root, 'database/20260902_invoice_capture_background_queue.sql'), 'utf8');
  await db.exec(queue.slice(0, queue.indexOf('insert into storage.buckets')));
  await db.exec(fs.readFileSync(path.join(root, 'database/20261010033954_invoice_capture_queue_worker.sql'), 'utf8'));
  await db.exec(fs.readFileSync(migrationPath, 'utf8'));
  async function as(role, uid = actor) { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid]); await db.exec('set role ' + role); }
  async function command(action, source = null, payload = {}, scope = {}) {
    const result = await db.query('select public.invoice_drive_command($1,$2,$3,$4,$5) as result',
      [action, scope.org || org, scope.venue || venue, source, JSON.stringify(payload)]);
    return result.rows[0].result;
  }
  async function worker(action, source, token = null, payload = {}, secret = hash) {
    const result = await db.query('select public.invoice_drive_worker($1,$2,$3,$4,$5) as result', [action, source, secret, token, JSON.stringify(payload)]);
    return result.rows[0].result;
  }
  await as('authenticated');
  const source = await command('connect', null, {folder_id: 'fixtureFolderA1', secret_hash: hash});
  await as('service_role');
  return {db, as, command, worker, source, close: () => db.close()};
}
module.exports = {setup, actor, stranger, org, venue, otherOrg, otherVenue, secondVenue, hash, migrationPath};
