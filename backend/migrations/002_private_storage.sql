insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('identitytwin-invoices', 'identitytwin-invoices', false, 15728640, array['application/pdf'])
on conflict (id) do update set public = false,
  file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- The API is the sole document gateway. Deny browser roles for this bucket even
-- when an unrelated permissive Storage policy already exists.
create policy identitytwin_private_documents
on storage.objects as restrictive for all to anon, authenticated
using (bucket_id <> 'identitytwin-invoices')
with check (bucket_id <> 'identitytwin-invoices');
