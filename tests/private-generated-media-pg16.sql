\set ON_ERROR_STOP on

set role service_role;
do $$
begin
  if not public.runtime_healthcheck_v5() then
    raise exception 'private generated-media readiness failed';
  end if;
end;
$$;

set role service_role;
insert into public.generated_media_cleanup_jobs(
  object_key, user_id, conversation_id, generation_id, reason
) values (
  '00000000-0000-4000-8000-000000000001/80000000-0000-4000-8000-000000000002/84000000-0000-4000-8000-000000000001/asset.png',
  '00000000-0000-4000-8000-000000000001',
  '80000000-0000-4000-8000-000000000002',
  '84000000-0000-4000-8000-000000000001',
  'history_delete'
);
reset role;
do $$
begin
  if (select state from public.job_assets
      where job_id = '84000000-0000-4000-8000-000000000001') <> 'deleting'
     or not exists (
       select 1 from public.job_outbox
       where job_id = '84000000-0000-4000-8000-000000000001'
         and dedupe_key like '%:assets.cleanup:history'
         and status = 'pending'
     ) then
    raise exception 'history deletion did not enter fenced asset cleanup';
  end if;
end;
$$;
set role service_role;
update public.generated_media_cleanup_jobs
set completed_at = clock_timestamp(), updated_at = clock_timestamp()
where generation_id = '84000000-0000-4000-8000-000000000001';
reset role;
do $$
begin
  if (select state from public.job_assets
      where job_id = '84000000-0000-4000-8000-000000000001') <> 'deleted' then
    raise exception 'completed history cleanup did not reconcile the asset receipt';
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from storage.buckets
    where id = 'generated-media' and public = false
      and file_size_limit = 10485760
  ) then
    raise exception 'generated-media bucket is not private';
  end if;
  if exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname in (
        'generated_media_public_read', 'generated_media_upload_own',
        'generated_media_update_own', 'generated_media_delete_own'
      )
  ) then
    raise exception 'direct generated-media browser policy survived';
  end if;
  if has_function_privilege('authenticated', 'public.runtime_healthcheck_v5()', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.runtime_healthcheck_v5()', 'EXECUTE') then
    raise exception 'private media healthcheck privilege mismatch';
  end if;
end;
$$;
