-- Evaluate the event category before resolving the private role helper.
-- POS commits use service_role, which intentionally has no private schema access.
-- Preserve SECURITY INVOKER, the empty search path, and privileged-event checks.
create or replace function public.guard_privileged_audit_events()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.event_type in (
    'invoice.posted',
    'closing.finalized',
    'closing.corrected_from_ocr',
    'stock.manual_correction',
    'product.saved'
  ) then
    if not private.has_org_role(new.organization_id, array['owner','manager']) then
      raise exception 'This audit event requires owner or manager role';
    end if;
  end if;
  return new;
end;
$function$;
