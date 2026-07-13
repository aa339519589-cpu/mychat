begin;

-- Content-addressed Agent workspace blobs are private and immutable to browser
-- roles. The manifest is committed last in agent_artifacts, so a visible
-- snapshot always points at a complete set of uploaded objects.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'agent-snapshots',
  'agent-snapshots',
  false,
  67108864,
  array['application/octet-stream']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "agent_snapshot_blobs_read_own" on storage.objects;
create policy "agent_snapshot_blobs_read_own"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'agent-snapshots'
    and (string_to_array(name, '/'))[1] = auth.uid()::text
    and (string_to_array(name, '/'))[3] = 'blobs'
    and name ~ '^[^/]+/[^/]+/blobs/[a-f0-9]{64}$'
    and exists (
      select 1 from public.agent_tasks task
      where task.id::text = (string_to_array(name, '/'))[2]
        and task.user_id = auth.uid()
    )
  );

drop policy if exists "agent_snapshot_blobs_insert_own" on storage.objects;
create policy "agent_snapshot_blobs_insert_own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'agent-snapshots'
    and (string_to_array(name, '/'))[1] = auth.uid()::text
    and (string_to_array(name, '/'))[3] = 'blobs'
    and name ~ '^[^/]+/[^/]+/blobs/[a-f0-9]{64}$'
    and exists (
      select 1 from public.agent_tasks task
      where task.id::text = (string_to_array(name, '/'))[2]
        and task.user_id = auth.uid()
    )
  );

-- Deliberately omit UPDATE and DELETE policies. A digest object cannot be
-- overwritten, and lifecycle cleanup must run through the service role.
drop policy if exists "agent_snapshot_blobs_update_own" on storage.objects;
drop policy if exists "agent_snapshot_blobs_delete_own" on storage.objects;

create or replace function public.reject_snapshot_manifest_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.kind = 'summary' and old.title like 'snapshot:%' then
    raise exception 'agent snapshot manifests are immutable' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists reject_snapshot_manifest_update on public.agent_artifacts;
create trigger reject_snapshot_manifest_update
before update or delete on public.agent_artifacts
for each row execute function public.reject_snapshot_manifest_update();

revoke all on function public.reject_snapshot_manifest_update()
  from public, anon, authenticated;

commit;
