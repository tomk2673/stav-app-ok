-- Queue transitions require a scoped RPC; clients still cannot UPDATE jobs directly.
alter table public.invoice_capture_jobs
  add column if not exists claim_token uuid,
  add column if not exists claimed_by uuid references auth.users(id),
  add column if not exists attempts integer not null default 0;

create schema if not exists private;

create or replace function private.invoice_capture_command(
  p_action text, p_organization_id uuid, p_venue_id uuid,
  p_job_id uuid default null, p_token uuid default null,
  p_result jsonb default null, p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  job public.invoice_capture_jobs%rowtype;
  invoice_id uuid;
  line jsonb;
  pid uuid;
  duplicate boolean := false;
  answer jsonb;
begin
  if actor is null or public.has_org_role(p_organization_id, array['owner','manager','staff']) is distinct from true then
    raise exception 'Invoice queue access denied' using errcode = '42501';
  end if;
  if not exists (select 1 from public.venues where id=p_venue_id and organization_id=p_organization_id) then
    raise exception 'Invoice queue venue mismatch' using errcode = '42501';
  end if;

  if p_action='summary' then
    return jsonb_build_object(
      'counts', (select coalesce(jsonb_object_agg(status,n), '{}'::jsonb) from (
        select status,count(*) as n from public.invoice_capture_jobs
        where organization_id=p_organization_id and venue_id=p_venue_id group by status
      ) counts),
      'jobs', (select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) from (
        select id,source_file_name,status,error_message,created_at,started_at,attempts,
          result->>'invoice_id' as invoice_id
        from public.invoice_capture_jobs
        where organization_id=p_organization_id and venue_id=p_venue_id
          and (p_job_id is null or id=p_job_id)
        order by case status when 'processing' then 0 when 'queued' then 1 when 'failed' then 2 else 3 end,
          created_at desc limit 50
      ) q)
    );
  end if;

  if p_action='retry' then
    update public.invoice_capture_jobs set status='queued',attempts=0,error_message=null,
      claim_token=null,claimed_by=null,started_at=null,finished_at=null
    where organization_id=p_organization_id and venue_id=p_venue_id
      and status='failed' and (p_job_id is null or id=p_job_id);
    return jsonb_build_object('status','queued');
  end if;

  if p_action='claim' then
    -- A closed/frozen browser loses its lease; repeated abandoned jobs become visible errors.
    update public.invoice_capture_jobs set status='failed',claim_token=null,claimed_by=null,
      finished_at=now(),error_message='Čtení bylo opakovaně přerušeno. Zkus jej spustit znovu.'
    where organization_id=p_organization_id and venue_id=p_venue_id and status='processing'
      and (started_at is null or started_at < now()-interval '10 minutes') and attempts>=3;

    select * into job from public.invoice_capture_jobs
    where organization_id=p_organization_id and venue_id=p_venue_id and (
      status='queued' or (status='processing' and (started_at is null or started_at < now()-interval '10 minutes'))
    ) order by created_at,id for update skip locked limit 1;
    if not found then return null; end if;
    update public.invoice_capture_jobs set status='processing',started_at=now(),finished_at=null,
      claim_token=gen_random_uuid(),claimed_by=actor,attempts=attempts+1,error_message=null
    where id=job.id returning * into job;
    return to_jsonb(job);
  end if;

  if p_action is null or p_action not in ('heartbeat','complete','fail') then
    raise exception 'Unknown invoice queue action';
  end if;
  select * into job from public.invoice_capture_jobs
  where id=p_job_id and organization_id=p_organization_id and venue_id=p_venue_id for update;
  if not found then raise exception 'Invoice queue job not found' using errcode='42501'; end if;

  -- A completed request can be replayed after a lost HTTP response without another invoice.
  if p_action='complete' and job.status in ('review','done') and job.result->>'invoice_id' is not null then
    return job.result;
  end if;
  if job.status<>'processing' or job.claimed_by is distinct from actor
     or p_token is null or job.claim_token is distinct from p_token then
    raise exception 'Invoice queue lease lost' using errcode='42501';
  end if;

  if p_action='heartbeat' then
    update public.invoice_capture_jobs set started_at=now() where id=job.id;
    return jsonb_build_object('status','processing');
  end if;
  if p_action='fail' then
    update public.invoice_capture_jobs set status='failed',finished_at=now(),claim_token=null,claimed_by=null,
      error_message=left(coalesce(nullif(p_error,''),'Čtení selhalo. Zkus jej spustit znovu.'),1000)
    where id=job.id;
    return jsonb_build_object('status','failed');
  end if;

  -- Serialize with the per-organization fingerprint unique index, including manual captures.
  if job.source_fingerprint is not null then
    select id into invoice_id from public.invoices
    where organization_id=job.organization_id and source_fingerprint=job.source_fingerprint;
  end if;
  if invoice_id is null then
    if p_result is null or jsonb_typeof(p_result)<>'object'
       or coalesce(length(btrim(p_result->>'raw_text')),0)=0
       or jsonb_typeof(p_result->'lines') is distinct from 'array' then
      raise exception 'Invoice queue extraction is empty or malformed';
    end if;
    if jsonb_array_length(p_result->'lines')=0 then raise exception 'Invoice queue has no readable lines'; end if;
    if jsonb_array_length(p_result->'lines')>1000 then raise exception 'Too many invoice lines'; end if;
    insert into public.invoices (
      organization_id,venue_id,created_by,supplier_name,invoice_number,issue_date,total_amount,total_amount_gross,
      source_fingerprint,source_file_name,raw_extraction,extraction_provider,status
    ) values (
      job.organization_id,job.venue_id,actor,p_result->>'supplier',p_result->>'invoice_number',
      nullif(p_result->>'issue_date','')::date,(p_result->>'total_gross')::numeric,(p_result->>'total_gross')::numeric,
      job.source_fingerprint,job.source_file_name,
      jsonb_build_object('raw_text',p_result->>'raw_text','source','invoice_capture_queue',
        'capture_job_id',job.id,'source_path',job.source_path,'captured_by',job.created_by,
        'crop',p_result->'crop','needs_review',true,'printed_total_gross',p_result->'total_gross'),
      coalesce(nullif(p_result->>'provider',''),'unknown'), 'review'
    ) on conflict (organization_id,source_fingerprint) do nothing returning id into invoice_id;
    if invoice_id is null then
      select id into invoice_id from public.invoices
      where organization_id=job.organization_id and source_fingerprint=job.source_fingerprint;
      duplicate:=true;
    else
      for line in select value from jsonb_array_elements(p_result->'lines') loop
        if jsonb_typeof(line)<>'object' or coalesce(length(btrim(line->>'rawName')),0)=0 then
          raise exception 'Invoice queue line has no name';
        end if;
        pid:=nullif(line->>'productId','')::uuid;
        if pid is not null and not exists (select 1 from public.products where id=pid and organization_id=job.organization_id) then
          raise exception 'Invoice queue product organization mismatch' using errcode='42501';
        end if;
        insert into public.invoice_lines (
          invoice_id,organization_id,raw_name,product_id,quantity,unit,unit_price,line_total,
          vat_rate,unit_price_net,unit_price_gross,line_total_net,line_total_gross,
          match_method,match_confidence,status,original_values
        ) values (
          invoice_id,job.organization_id,line->>'rawName',pid,(line->>'qty')::numeric,'ks',
          (line->>'price')::numeric,(line->>'lineNet')::numeric,(line->>'vatRate')::numeric,
          (line->>'price')::numeric,(line->>'unitGross')::numeric,(line->>'lineNet')::numeric,
          (line->>'lineGross')::numeric,case when pid is not null then 'capture_suggested_mapping' end,
          case when pid is not null then 0.8 end,'review',
          jsonb_build_object('raw_name',line->>'rawName','source_code',line->>'sourceCode',
            'ocr_qty',line->'qty','ocr_vat_rate',line->'vatRate','ocr_line_gross',line->'lineGross',
            'parser_warning',line->>'warning','capture_job_id',job.id)
        );
      end loop;
      insert into public.audit_events (organization_id,venue_id,actor_user_id,event_type,entity_type,entity_id,after_data)
      values (job.organization_id,job.venue_id,actor,'invoice.captured_for_review','invoice',invoice_id,
        jsonb_build_object('capture_job_id',job.id,'captured_lines',jsonb_array_length(p_result->'lines'),
          'total_gross',p_result->'total_gross','extraction_provider',p_result->>'provider',
          'extraction_model',p_result#>>'{crop,model}','needs_review',true));
    end if;
  else
    duplicate:=true;
  end if;
  if invoice_id is null then raise exception 'Invoice queue completion failed'; end if;
  answer:=jsonb_build_object('invoice_id',invoice_id,'duplicate',duplicate,'status','review');
  update public.invoice_capture_jobs set status='review',result=answer,
    provider=coalesce(p_result->>'provider',provider),error_message=null,finished_at=now(),
    claim_token=null,claimed_by=null where id=job.id;
  return answer;
end;
$$;

-- The privileged implementation is outside the exposed schema and checks membership itself.
revoke all on function private.invoice_capture_command(text,uuid,uuid,uuid,uuid,jsonb,text) from public,anon;
grant usage on schema private to authenticated;
grant execute on function private.invoice_capture_command(text,uuid,uuid,uuid,uuid,jsonb,text) to authenticated;

create or replace function public.invoice_capture_command(
  p_action text, p_organization_id uuid, p_venue_id uuid,
  p_job_id uuid default null, p_token uuid default null,
  p_result jsonb default null, p_error text default null
)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.invoice_capture_command(p_action,p_organization_id,p_venue_id,p_job_id,p_token,p_result,p_error); $$;
revoke all on function public.invoice_capture_command(text,uuid,uuid,uuid,uuid,jsonb,text) from public,anon;
grant execute on function public.invoice_capture_command(text,uuid,uuid,uuid,uuid,jsonb,text) to authenticated;
