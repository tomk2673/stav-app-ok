create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.has_org_role(p_org uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when auth.uid() is null then false
    else exists (
      select 1
      from public.memberships m
      where m.organization_id = p_org
        and m.user_id = auth.uid()
        and m.role = any(p_roles)
    )
  end;
$$;
revoke all on function private.has_org_role(uuid,text[]) from public, anon;
grant execute on function private.has_org_role(uuid,text[]) to authenticated;

create or replace function public.has_org_role(p_org uuid, p_roles text[])
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select private.has_org_role(p_org, p_roles);
$$;
revoke all on function public.has_org_role(uuid,text[]) from public, anon;
grant execute on function public.has_org_role(uuid,text[]) to authenticated;
