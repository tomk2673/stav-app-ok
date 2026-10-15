-- Drive imports only enqueue originals. Invoice approval/posting remains in the existing worker.
create schema if not exists private;

create table public.invoice_drive_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  folder_id text not null check (folder_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  last_connected_at timestamptz,
  last_scan_at timestamptz,
  error_message text,
  unique(id,organization_id,venue_id)
);
-- A folder has exactly one active destination; tenants/venues cannot silently share routing.
create unique index invoice_drive_folder_active_uq on public.invoice_drive_sources(folder_id) where active;
create index invoice_drive_sources_scope_idx on public.invoice_drive_sources(organization_id,venue_id);

create table private.invoice_drive_credentials (
  source_id uuid primary key references public.invoice_drive_sources(id) on delete cascade,
  secret_hash text not null unique check (secret_hash ~ '^[a-f0-9]{64}$'),
  page_token text,
  lease_token uuid,
  lease_until timestamptz
);
alter table private.invoice_drive_credentials enable row level security;
revoke all on private.invoice_drive_credentials from public,anon,authenticated;

create table public.invoice_drive_files (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null,
  organization_id uuid not null,
  venue_id uuid not null,
  drive_file_id text not null check (drive_file_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  drive_version text not null check (drive_version ~ '^[0-9]{1,30}$'),
  file_name text not null check (length(file_name) between 1 and 500),
  mime_type text not null,
  source_fingerprint text check (source_fingerprint ~ '^[a-f0-9]{64}$'),
  source_path text,
  job_id uuid references public.invoice_capture_jobs(id) on delete set null,
  invoice_id uuid references public.invoices(id) on delete set null,
  status text not null default 'downloading' check (status in ('downloading','queued','duplicate','failed')),
  attempts integer not null default 1,
  started_at timestamptz not null default now(),
  retry_after timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  foreign key(source_id,organization_id,venue_id) references public.invoice_drive_sources(id,organization_id,venue_id) on delete cascade,
  unique(source_id,drive_file_id,drive_version)
);
create index invoice_drive_files_scope_idx on public.invoice_drive_files(organization_id,venue_id,created_at desc);
create index invoice_drive_files_job_idx on public.invoice_drive_files(job_id) where job_id is not null;
create index invoice_drive_files_invoice_idx on public.invoice_drive_files(invoice_id) where invoice_id is not null;

-- Serialize all capture paths, including a manual capture racing a Drive upload.
-- The existing organization-wide fingerprint indexes remain unchanged.
create or replace function private.invoice_source_scope_guard()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.venue_id is not null and not exists(select 1 from public.venues where id=new.venue_id and organization_id=new.organization_id) then
    raise exception 'Invoice source venue mismatch' using errcode='42501';
  end if;
  if new.source_fingerprint is null then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.organization_id::text||'/'||new.source_fingerprint,0));
  if exists(select 1 from public.invoices where organization_id=new.organization_id and source_fingerprint=new.source_fingerprint
    and venue_id is distinct from new.venue_id)
    or exists(select 1 from public.invoice_capture_jobs where organization_id=new.organization_id and source_fingerprint=new.source_fingerprint
    and venue_id is distinct from new.venue_id) then
    raise exception 'Invoice source belongs to another venue' using errcode='42501';
  end if;
  return new;
end;
$$;
revoke all on function private.invoice_source_scope_guard() from public,anon,authenticated,service_role;
create trigger invoice_source_scope_guard before insert or update of organization_id,venue_id,source_fingerprint on public.invoices
for each row execute function private.invoice_source_scope_guard();
create trigger invoice_capture_source_scope_guard before insert or update of organization_id,venue_id,source_fingerprint on public.invoice_capture_jobs
for each row execute function private.invoice_source_scope_guard();

-- Preserve invoice provenance even if a manager later removes a completed job.
create or replace function private.invoice_drive_link_invoice()
returns trigger language plpgsql security definer set search_path='' as $$
declare iid uuid;
begin
  if new.result->>'invoice_id' is null or not exists(select 1 from public.invoice_drive_files where job_id=new.id) then return new; end if;
  iid:=(new.result->>'invoice_id')::uuid;
  if not exists(select 1 from public.invoices where id=iid and organization_id=new.organization_id
    and venue_id=new.venue_id and source_fingerprint=new.source_fingerprint) then
    raise exception 'Drive invoice reference scope mismatch' using errcode='42501';
  end if;
  update public.invoice_drive_files set invoice_id=iid where job_id=new.id
    and organization_id=new.organization_id and venue_id=new.venue_id and source_fingerprint=new.source_fingerprint;
  return new;
end;
$$;
revoke all on function private.invoice_drive_link_invoice() from public,anon,authenticated,service_role;
create trigger invoice_drive_link_invoice after update of result on public.invoice_capture_jobs
for each row execute function private.invoice_drive_link_invoice();

alter table public.invoice_drive_sources enable row level security;
alter table public.invoice_drive_files enable row level security;
create policy invoice_drive_sources_read on public.invoice_drive_sources for select to authenticated
  using (public.has_org_role(organization_id,array['owner','manager','staff']));
create policy invoice_drive_files_read on public.invoice_drive_files for select to authenticated
  using (public.has_org_role(organization_id,array['owner','manager','staff']));
grant select on public.invoice_drive_sources,public.invoice_drive_files to authenticated;
grant all on public.invoice_drive_sources,public.invoice_drive_files,private.invoice_drive_credentials to service_role;

-- Keep the original HEIC/HEIF; decoding creates only a temporary OCR copy in the browser.
update storage.buckets set allowed_mime_types=array['image/jpeg','image/png','image/heic','image/heif','application/pdf']
where id='invoice-sources';

create or replace function private.invoice_drive_command(
  p_action text,p_organization_id uuid,p_venue_id uuid,p_source_id uuid default null,p_payload jsonb default '{}'
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid:=auth.uid();
  src public.invoice_drive_sources%rowtype;
  folder text:=p_payload->>'folder_id';
  secret text:=p_payload->>'secret_hash';
begin
  if actor is null or public.has_org_role(p_organization_id,array['owner','manager','staff']) is distinct from true
    or not exists(select 1 from public.venues where id=p_venue_id and organization_id=p_organization_id) then
    raise exception 'Drive import access denied' using errcode='42501';
  end if;
  if p_action='summary' then
    return jsonb_build_object(
      'sources',(select coalesce(jsonb_agg(to_jsonb(s)),'[]'::jsonb) from (
        select id,folder_id,active,last_attempt_at,last_connected_at,last_scan_at,error_message
        from public.invoice_drive_sources where organization_id=p_organization_id and venue_id=p_venue_id and active
      ) s),
      'files',(select coalesce(jsonb_agg(to_jsonb(f)),'[]'::jsonb) from (
        select d.id,d.source_id,d.drive_file_id,d.drive_version,d.file_name,d.source_path,d.status as import_status,d.error_message as import_error,
          d.created_at,d.attempts,d.retry_after,j.status as ocr_status,j.error_message as ocr_error,
          coalesce(i.status,ji.status) as invoice_status
        from public.invoice_drive_files d
        left join public.invoice_capture_jobs j on j.id=d.job_id and j.organization_id=d.organization_id and j.venue_id=d.venue_id
        left join public.invoices i on i.id=d.invoice_id and i.organization_id=d.organization_id and i.venue_id=d.venue_id
        left join public.invoices ji on ji.id=nullif(j.result->>'invoice_id','')::uuid and ji.organization_id=d.organization_id and ji.venue_id=d.venue_id
        where d.organization_id=p_organization_id and d.venue_id=p_venue_id order by d.created_at desc limit 50
      ) f)
    );
  end if;
  if public.has_org_role(p_organization_id,array['owner','manager']) is distinct from true then
    raise exception 'Only a manager may configure Drive import' using errcode='42501';
  end if;
  if p_action='connect' then
    if folder is null or folder !~ '^[A-Za-z0-9_-]{10,200}$' or secret is null or secret !~ '^[a-f0-9]{64}$' then
      raise exception 'Invalid Drive connection';
    end if;
    select * into src from public.invoice_drive_sources where folder_id=folder and active for update;
    if found then
      if src.organization_id<>p_organization_id or src.venue_id<>p_venue_id then
        raise exception 'Folder already has another destination' using errcode='42501';
      end if;
      update public.invoice_drive_sources set created_by=actor,error_message=null where id=src.id;
    else
      insert into public.invoice_drive_sources(organization_id,venue_id,created_by,folder_id)
      values(p_organization_id,p_venue_id,actor,folder) returning * into src;
    end if;
    insert into private.invoice_drive_credentials(source_id,secret_hash) values(src.id,secret)
    on conflict(source_id) do update set secret_hash=excluded.secret_hash,lease_token=null,lease_until=null;
    return jsonb_build_object('id',src.id,'folder_id',src.folder_id);
  end if;
  select * into src from public.invoice_drive_sources
  where id=p_source_id and organization_id=p_organization_id and venue_id=p_venue_id for update;
  if not found then raise exception 'Drive source not found' using errcode='42501'; end if;
  if p_action='disconnect' then
    update public.invoice_drive_sources set active=false where id=src.id;
    delete from private.invoice_drive_credentials where source_id=src.id;
    return jsonb_build_object('active',false);
  elsif p_action='retry' then
    update public.invoice_drive_files set attempts=0,retry_after=null,started_at=now()-interval '10 minutes'
    where source_id=src.id and status in ('failed','downloading');
    update private.invoice_drive_credentials set page_token=null,lease_token=null,lease_until=null where source_id=src.id;
    return jsonb_build_object('status','retry_pending');
  end if;
  raise exception 'Unknown Drive action';
end;
$$;
revoke all on function private.invoice_drive_command(text,uuid,uuid,uuid,jsonb) from public,anon;
grant usage on schema private to authenticated,service_role;
grant execute on function private.invoice_drive_command(text,uuid,uuid,uuid,jsonb) to authenticated;
create or replace function public.invoice_drive_command(
  p_action text,p_organization_id uuid,p_venue_id uuid,p_source_id uuid default null,p_payload jsonb default '{}'
) returns jsonb language sql security invoker set search_path='' as $$
  select private.invoice_drive_command(p_action,p_organization_id,p_venue_id,p_source_id,p_payload);
$$;
revoke all on function public.invoice_drive_command(text,uuid,uuid,uuid,jsonb) from public,anon;
grant execute on function public.invoice_drive_command(text,uuid,uuid,uuid,jsonb) to authenticated;

-- This RPC is NOT callable by browsers. The Edge Function hashes a per-source capability
-- and rechecks the live manager membership and folder/venue on every fenced operation.
create or replace function private.invoice_drive_worker(
  p_action text,p_source_id uuid,p_secret_hash text,p_token uuid default null,p_payload jsonb default '{}'
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  src public.invoice_drive_sources%rowtype;
  cred private.invoice_drive_credentials%rowtype;
  item public.invoice_drive_files%rowtype;
  job public.invoice_capture_jobs%rowtype;
  inv public.invoices%rowtype;
  fingerprint text:=p_payload->>'fingerprint';
  original_mime text:=p_payload->>'mime_type';
  ext text;
  original_path text;
  was_duplicate boolean:=false;
begin
  select * into src from public.invoice_drive_sources where id=p_source_id and active for update;
  if not found then raise exception 'Drive authorization failed' using errcode='42501'; end if;
  select * into cred from private.invoice_drive_credentials where source_id=src.id for update;
  if not found or p_secret_hash is null or cred.secret_hash is distinct from p_secret_hash
    or not exists(select 1 from public.venues where id=src.venue_id and organization_id=src.organization_id) then
    raise exception 'Drive authorization failed' using errcode='42501';
  end if;
  if not exists(select 1 from public.memberships where organization_id=src.organization_id and user_id=src.created_by and role in ('owner','manager')) then
    update public.invoice_drive_sources set error_message='Správce propojení už nemá oprávnění. Propoj složku znovu jako správce.' where id=src.id;
    update private.invoice_drive_credentials set lease_token=null,lease_until=null where source_id=src.id;
    return jsonb_build_object('authorization_revoked',true);
  end if;
  if p_action='probe' then return jsonb_build_object('folder_id',src.folder_id); end if;
  if p_action='start' then
    if cred.lease_until>now() then return jsonb_build_object('busy',true); end if;
    update private.invoice_drive_credentials set lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes'
    where source_id=src.id returning * into cred;
    update public.invoice_drive_sources set last_attempt_at=now() where id=src.id;
    return jsonb_build_object('folder_id',src.folder_id,'organization_id',src.organization_id,
      'venue_id',src.venue_id,'created_by',src.created_by,'page_token',cred.page_token,'lease_token',cred.lease_token);
  end if;
  if p_token is null or cred.lease_token is distinct from p_token or cred.lease_until<=now() then
    raise exception 'Drive lease lost' using errcode='42501';
  end if;
  if p_action='end' then
    update public.invoice_drive_sources set
      last_connected_at=case when p_payload->>'connected'='true' then now() else last_connected_at end,
      last_scan_at=case when p_payload->>'complete'='true' then now() else last_scan_at end,
      error_message=left(nullif(p_payload->>'error',''),1000) where id=src.id;
    update private.invoice_drive_credentials set lease_token=null,lease_until=null,
      page_token=case when p_payload ? 'page_token' then p_payload->>'page_token' else page_token end
    where source_id=src.id;
    return jsonb_build_object('ok',true);
  end if;
  if p_action='reserve' then
    insert into public.invoice_drive_files(source_id,organization_id,venue_id,drive_file_id,drive_version,file_name,mime_type)
    values(src.id,src.organization_id,src.venue_id,p_payload->>'id',p_payload->>'version',p_payload->>'name',p_payload->>'mime_type')
    on conflict(source_id,drive_file_id,drive_version) do nothing returning * into item;
    if not found then
      select * into item from public.invoice_drive_files where source_id=src.id
        and drive_file_id=p_payload->>'id' and drive_version=p_payload->>'version' for update;
      if item.status='downloading' and item.attempts>=5 and item.started_at<=now()-interval '5 minutes' then
        update public.invoice_drive_files set status='failed',error_message='Import byl opakovaně přerušen. Zopakuj jej v nastavení Drive.' where id=item.id;
      end if;
      if item.status in ('queued','duplicate') or item.attempts>=5 or item.retry_after>now()
        or (item.status='downloading' and item.started_at>now()-interval '5 minutes') then
        return jsonb_build_object('skip',true);
      end if;
      update public.invoice_drive_files set status='downloading',attempts=attempts+1,started_at=now(),error_message=null
      where id=item.id returning * into item;
    end if;
    return jsonb_build_object('id',item.id);
  end if;
  if p_action='duplicate' then
    if fingerprint is null or fingerprint !~ '^[a-f0-9]{64}$' then raise exception 'Invalid original hash'; end if;
    return jsonb_build_object('exists',exists(select 1 from public.invoice_capture_jobs where organization_id=src.organization_id and source_fingerprint=fingerprint)
      or exists(select 1 from public.invoices where organization_id=src.organization_id and source_fingerprint=fingerprint),
      'cross_venue',exists(select 1 from public.invoice_capture_jobs where organization_id=src.organization_id and source_fingerprint=fingerprint and venue_id is distinct from src.venue_id)
      or exists(select 1 from public.invoices where organization_id=src.organization_id and source_fingerprint=fingerprint and venue_id is distinct from src.venue_id));
  end if;
  select * into item from public.invoice_drive_files where id=(p_payload->>'file_id')::uuid and source_id=src.id for update;
  if not found then raise exception 'Drive file not found' using errcode='42501'; end if;
  if item.status in ('queued','duplicate') then return jsonb_build_object('status',item.status); end if;
  if p_action='fail' then
    update public.invoice_drive_files set status='failed',retry_after=now()+least(attempts*attempts,60)*interval '1 minute',
      error_message=left(coalesce(nullif(p_payload->>'error',''),'Import se nezdařil. Zkusí se znovu.'),1000) where id=item.id;
    return jsonb_build_object('status','failed');
  end if;
  if p_action is distinct from 'enqueue' or fingerprint is null or fingerprint !~ '^[a-f0-9]{64}$'
    or original_mime is null or original_mime not in ('image/jpeg','image/heic','image/heif','application/pdf') then
    raise exception 'Invalid Drive enqueue';
  end if;
  select * into inv from public.invoices where organization_id=src.organization_id and source_fingerprint=fingerprint;
  select * into job from public.invoice_capture_jobs where organization_id=src.organization_id and source_fingerprint=fingerprint;
  if (inv.id is not null and inv.venue_id is distinct from src.venue_id) or (job.id is not null and job.venue_id is distinct from src.venue_id) then
    update public.invoice_drive_files set status='failed',attempts=5,source_fingerprint=fingerprint,
      error_message='Shodný doklad už patří jiné provozovně. Ověř správnou složku.',retry_after=null where id=item.id;
    return jsonb_build_object('status','failed');
  end if;
  was_duplicate:=inv.id is not null or job.id is not null;
  if p_payload->>'uploaded' is distinct from 'true' then raise exception 'Original upload required'; end if;
  ext:=case original_mime when 'image/jpeg' then 'jpg' when 'application/pdf' then 'pdf' when 'image/heif' then 'heif' else 'heic' end;
  original_path:=src.organization_id::text||'/'||src.venue_id::text||'/'||src.created_by::text||'/drive/'||fingerprint||'.'||ext;
  if not was_duplicate then
    insert into public.invoice_capture_jobs(organization_id,venue_id,created_by,source_path,source_file_name,source_fingerprint,mime_type,status)
    values(src.organization_id,src.venue_id,src.created_by,original_path,item.file_name,fingerprint,original_mime,'queued')
    on conflict(organization_id,source_fingerprint) where source_fingerprint is not null do nothing returning * into job;
    if not found then
      select * into job from public.invoice_capture_jobs where organization_id=src.organization_id and source_fingerprint=fingerprint;
      was_duplicate:=true;
      if job.venue_id is distinct from src.venue_id then
        update public.invoice_drive_files set status='failed',attempts=5,source_fingerprint=fingerprint,
          error_message='Shodný doklad už patří jiné provozovně. Ověř správnou složku.' where id=item.id;
        return jsonb_build_object('status','failed');
      end if;
    end if;
  end if;
  update public.invoice_drive_files set status=case when was_duplicate then 'duplicate' else 'queued' end,
    source_fingerprint=fingerprint,source_path=original_path,job_id=job.id,invoice_id=inv.id,error_message=null,retry_after=null where id=item.id returning * into item;
  return jsonb_build_object('status',item.status);
end;
$$;
revoke all on function private.invoice_drive_worker(text,uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function private.invoice_drive_worker(text,uuid,text,uuid,jsonb) to service_role;
create or replace function public.invoice_drive_worker(
  p_action text,p_source_id uuid,p_secret_hash text,p_token uuid default null,p_payload jsonb default '{}'
) returns jsonb language sql security invoker set search_path='' as $$
  select private.invoice_drive_worker(p_action,p_source_id,p_secret_hash,p_token,p_payload);
$$;
revoke all on function public.invoice_drive_worker(text,uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.invoice_drive_worker(text,uuid,text,uuid,jsonb) to service_role;
