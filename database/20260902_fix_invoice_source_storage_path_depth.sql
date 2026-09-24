drop policy if exists invoice_sources_insert_member on storage.objects;
create policy invoice_sources_insert_member on storage.objects
for insert to authenticated
with check (
  bucket_id = 'invoice-sources'
  and array_length(storage.foldername(name), 1) >= 3
  and public.has_org_role((storage.foldername(name))[1]::uuid, array['owner','manager','staff'])
  and (storage.foldername(name))[3] = auth.uid()::text
);

drop policy if exists invoice_sources_read_member on storage.objects;
create policy invoice_sources_read_member on storage.objects
for select to authenticated
using (
  bucket_id = 'invoice-sources'
  and array_length(storage.foldername(name), 1) >= 3
  and public.has_org_role((storage.foldername(name))[1]::uuid, array['owner','manager','staff'])
);

drop policy if exists invoice_sources_delete_own on storage.objects;
create policy invoice_sources_delete_own on storage.objects
for delete to authenticated
using (
  bucket_id = 'invoice-sources'
  and array_length(storage.foldername(name), 1) >= 3
  and (
    (storage.foldername(name))[3] = auth.uid()::text
    or public.has_org_role((storage.foldername(name))[1]::uuid, array['owner','manager'])
  )
);
