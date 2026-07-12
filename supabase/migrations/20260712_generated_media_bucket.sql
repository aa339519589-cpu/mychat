-- Public bucket for generated chat images/videos (user-scoped object keys)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'generated-media',
  'generated-media',
  true,
  10485760,
  array['image/png','image/jpeg','image/jpg','image/webp','image/gif','video/mp4','video/webm','video/quicktime']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Authenticated users may upload only under their own user id prefix
drop policy if exists "generated_media_upload_own" on storage.objects;
create policy "generated_media_upload_own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'generated-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "generated_media_update_own" on storage.objects;
create policy "generated_media_update_own"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'generated-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "generated_media_delete_own" on storage.objects;
create policy "generated_media_delete_own"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'generated-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Public read for public bucket URLs (thumbnails + preview)
drop policy if exists "generated_media_public_read" on storage.objects;
create policy "generated_media_public_read"
  on storage.objects for select
  using (bucket_id = 'generated-media');
