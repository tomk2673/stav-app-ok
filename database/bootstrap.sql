-- PUB GURU secure bootstrap rules.
-- Apply after schema.sql when creating the dedicated backend.

-- Membership roles must never be editable directly from a browser client.
revoke update on public.memberships from authenticated;

-- The creator must be able to read the organization long enough to create
-- the initial owner membership. After that, the normal membership policy applies.
drop policy if exists organizations_read_creator on public.organizations;
create policy organizations_read_creator
on public.organizations for select
to authenticated
using (created_by = (select auth.uid()));

-- Initial membership is self-service only for the organization creator,
-- and it can only create an owner membership for that same user.
drop policy if exists memberships_insert_initial_owner on public.memberships;
create policy memberships_insert_initial_owner
on public.memberships for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and role = 'owner'
  and exists (
    select 1
    from public.organizations o
    where o.id = memberships.organization_id
      and o.created_by = (select auth.uid())
  )
);

-- Later staff invitations will be performed by a server-side/admin workflow,
-- never by letting a browser promote arbitrary membership rows.
