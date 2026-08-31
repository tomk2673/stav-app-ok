-- PUB GURU: break RLS recursion during first workspace bootstrap.

create or replace function private.can_bootstrap_owner(p_org uuid)
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
      from public.organizations o
      where o.id = p_org
        and o.created_by = auth.uid()
    )
  end;
$$;

revoke all on function private.can_bootstrap_owner(uuid) from public, anon;
grant execute on function private.can_bootstrap_owner(uuid) to authenticated;

drop policy if exists memberships_insert_initial_owner on public.memberships;
create policy memberships_insert_initial_owner on public.memberships
for insert to authenticated
with check (
  user_id = auth.uid()
  and role = 'owner'
  and private.can_bootstrap_owner(organization_id)
);

drop policy if exists organizations_read_member on public.organizations;
create policy organizations_read_member on public.organizations
for select to authenticated
using (
  public.has_org_role(id, array['owner','manager','staff','accountant','service'])
);
