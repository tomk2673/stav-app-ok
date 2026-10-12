-- Finish capture jobs in the transaction that posts the invoice and its audit.
-- Never finish on approved: an interrupted browser may not have written invoice.posted yet.
-- No existing invoice, stock movement, price or payment is changed by this migration.
create or replace function private.complete_invoice_capture_on_post()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  completed_jobs jsonb;
begin
  if new.status <> 'posted' or old.status = 'posted' then return new; end if;
  if actor is null or public.has_org_role(new.organization_id,array['owner','manager']) is distinct from true
     or new.approved_by is distinct from actor then
    raise exception 'Invoice queue posting access denied' using errcode='42501';
  end if;

  with completed as (
    update public.invoice_capture_jobs j
    set status='done',result=j.result || jsonb_build_object('status','done'),finished_at=now()
    where j.status='review' and j.organization_id=new.organization_id and j.venue_id=new.venue_id
      and j.result->>'invoice_id'=new.id::text
    returning j.id
  ) select jsonb_agg(id order by id) into completed_jobs from completed;

  if completed_jobs is not null then
    insert into public.audit_events(organization_id,venue_id,actor_user_id,event_type,entity_type,entity_id,before_data,after_data)
    values(new.organization_id,new.venue_id,actor,'invoice.capture_queue_completed','invoice',new.id,
      jsonb_build_object('status','review'),
      jsonb_build_object('status','done','capture_job_ids',completed_jobs,'approved_at',new.approved_at));
  end if;
  return new;
end;
$$;
-- Trigger-only implementation; no client may invoke a privileged queue update.
revoke all on function private.complete_invoice_capture_on_post() from public,anon,authenticated;
drop trigger if exists trg_complete_invoice_capture_on_post on public.invoices;
create trigger trg_complete_invoice_capture_on_post
after update of status on public.invoices
for each row when (new.status='posted' and old.status is distinct from new.status)
execute function private.complete_invoice_capture_on_post();

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
    -- approved is an intermediate browser save, not successful posting. Derive done
    -- only from posted, including jobs left in review by older application versions.
    with effective_jobs as (
      select j.id,j.source_file_name,
        case when j.status='review' and i.status='posted' then 'done' else j.status end as status,
        j.error_message,j.created_at,j.started_at,j.attempts,j.result->>'invoice_id' as invoice_id
      from public.invoice_capture_jobs j
      left join public.invoices i on i.id::text=j.result->>'invoice_id'
        and i.organization_id=j.organization_id and i.venue_id=j.venue_id
      where j.organization_id=p_organization_id and j.venue_id=p_venue_id
    )
    select jsonb_build_object(
      'counts', (select coalesce(jsonb_object_agg(status,n), '{}'::jsonb) from (
        select status,count(*) as n from effective_jobs group by status
      ) counts),
      'jobs', (select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) from (
        select * from effective_jobs where p_job_id is null or id=p_job_id
        order by case status when 'processing' then 0 when 'queued' then 1 when 'failed' then 2 else 3 end,
          created_at desc,id limit 50
      ) q)
    ) into answer;
    return answer;
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
    if job.status='review' and exists (
      select 1 from public.invoices i where i.id::text=job.result->>'invoice_id'
        and i.organization_id=job.organization_id and i.venue_id=job.venue_id and i.status='posted'
    ) then
      return job.result || jsonb_build_object('status','done');
    end if;
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
  -- A duplicate capture of an already posted invoice also needs no further review.
  answer:=jsonb_build_object('invoice_id',invoice_id,'duplicate',duplicate,'status',
    case when exists (select 1 from public.invoices i where i.id=invoice_id
      and i.organization_id=job.organization_id and i.venue_id=job.venue_id and i.status='posted')
    then 'done' else 'review' end);
  update public.invoice_capture_jobs set status=answer->>'status',result=answer,
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
