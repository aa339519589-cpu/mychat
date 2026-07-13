begin;

update storage.buckets
set public = false,
    file_size_limit = 10485760,
    allowed_mime_types = array[
      'image/png','image/jpeg','image/jpg','image/webp','image/gif',
      'video/mp4','video/webm','video/quicktime'
    ]
where id = 'generated-media';

-- All generated media now flows through the authenticated same-origin proxy.
-- Browser roles never read or mutate Storage objects directly.
drop policy if exists "generated_media_public_read" on storage.objects;
drop policy if exists "generated_media_upload_own" on storage.objects;
drop policy if exists "generated_media_update_own" on storage.objects;
drop policy if exists "generated_media_delete_own" on storage.objects;

create or replace function public.reconcile_history_job_asset_cleanup()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_asset public.job_assets%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if new.reason <> 'history_delete' then return new; end if;
  select * into current_asset from public.job_assets
  where object_key = new.object_key and principal_id = new.user_id
  for update;
  if not found or current_asset.state = 'deleted' then return new; end if;

  if new.completed_at is not null then
    update public.job_assets
    set state = 'deleted', canonical_at = null, deleted_at = v_now, updated_at = v_now
    where id = current_asset.id and state in ('canonical', 'deleting');
    return new;
  end if;

  if current_asset.state = 'canonical' then
    update public.job_assets
    set state = 'deleting', canonical_at = null, updated_at = v_now
    where id = current_asset.id;
  elsif current_asset.state <> 'deleting' then
    return new;
  end if;

  insert into public.job_outbox(
    job_id, principal_id, topic, dedupe_key, payload, created_at, updated_at
  ) values (
    current_asset.job_id, current_asset.principal_id, 'assets.cleanup',
    current_asset.job_id::text || ':assets.cleanup:history',
    jsonb_build_object('jobId', current_asset.job_id, 'reason', 'history_delete'),
    v_now, v_now
  ) on conflict (job_id, dedupe_key) do update
    set status = 'pending', attempts = 0,
        available_at = v_now, locked_by = null, lock_expires_at = null,
        published_at = null, last_error = null, updated_at = v_now
    where public.job_outbox.status in ('published', 'dead');
  return new;
end;
$$;

drop trigger if exists reconcile_history_job_asset_cleanup
  on public.generated_media_cleanup_jobs;
create trigger reconcile_history_job_asset_cleanup
after insert or update of reason, completed_at
on public.generated_media_cleanup_jobs
for each row execute function public.reconcile_history_job_asset_cleanup();

revoke all on function public.reconcile_history_job_asset_cleanup()
  from public, anon, authenticated, service_role;

-- Reconcile history receipts created before this migration. Completed receipts
-- prove Storage removal; pending receipts are handed to the fenced dispatcher.
update public.job_assets as asset
set state = 'deleted', canonical_at = null,
    deleted_at = coalesce(cleanup.completed_at, clock_timestamp()),
    updated_at = clock_timestamp()
from public.generated_media_cleanup_jobs as cleanup
where cleanup.object_key = asset.object_key
  and cleanup.user_id = asset.principal_id
  and cleanup.reason = 'history_delete'
  and cleanup.completed_at is not null
  and asset.state in ('canonical', 'deleting');

update public.job_assets as asset
set state = 'deleting', canonical_at = null, updated_at = clock_timestamp()
from public.generated_media_cleanup_jobs as cleanup
where cleanup.object_key = asset.object_key
  and cleanup.user_id = asset.principal_id
  and cleanup.reason = 'history_delete'
  and cleanup.completed_at is null
  and asset.state = 'canonical';

insert into public.job_outbox(
  job_id, principal_id, topic, dedupe_key, payload, created_at, updated_at
)
select distinct
  asset.job_id, asset.principal_id, 'assets.cleanup',
  asset.job_id::text || ':assets.cleanup:history',
  jsonb_build_object('jobId', asset.job_id, 'reason', 'history_delete'),
  clock_timestamp(), clock_timestamp()
from public.job_assets as asset
join public.generated_media_cleanup_jobs as cleanup
  on cleanup.object_key = asset.object_key and cleanup.user_id = asset.principal_id
where cleanup.reason = 'history_delete' and cleanup.completed_at is null
  and asset.state = 'deleting'
on conflict (job_id, dedupe_key) do nothing;

create or replace function public.runtime_healthcheck_v5()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    to_regclass('public.api_rate_limits') is not null
    and to_regclass('public.chat_generations') is not null
    and to_regclass('public.generated_media_cleanup_jobs') is not null
    and to_regclass('public.jobs') is not null
    and to_regclass('public.job_events') is not null
    and to_regclass('public.job_checkpoints') is not null
    and to_regclass('public.job_tool_effects') is not null
    and to_regclass('public.job_outbox') is not null
    and to_regclass('public.job_assets') is not null
    and to_regclass('public.ledger_entries') is not null
    and to_regclass('public.audit_log') is not null
    and to_regclass('public.github_connections') is not null
    and to_regprocedure('public.consume_api_rate_limit(text,integer,integer)') is not null
    and to_regprocedure(
      'public.enqueue_job(uuid,text,text,uuid,text,jsonb,text,text,jsonb,jsonb,integer,integer,timestamptz)'
    ) is not null
    and to_regprocedure('public.claim_next_job(text,text[],integer)') is not null
    and to_regprocedure('public.renew_job_lease(uuid,text,bigint,integer)') is not null
    and to_regprocedure('public.retry_job(uuid,text,bigint,text,text,integer)') is not null
    and to_regprocedure('public.append_job_events(uuid,text,bigint,jsonb)') is not null
    and to_regprocedure(
      'public.checkpoint_job(uuid,text,bigint,text,jsonb,jsonb,boolean,text)'
    ) is not null
    and to_regprocedure(
      'public.record_job_tool_effect(uuid,text,bigint,text,text,text,text,text,jsonb,boolean,jsonb)'
    ) is not null
    and to_regprocedure(
      'public.finalize_job(uuid,text,bigint,text,jsonb,text,text,jsonb,jsonb)'
    ) is not null
    and to_regprocedure('public.cancel_job(uuid,uuid,text)') is not null
    and to_regprocedure(
      'public.record_job_asset(uuid,text,bigint,uuid,text,text,text,text,bigint,text)'
    ) is not null
    and to_regprocedure('public.claim_job_outbox(text,text[],integer)') is not null
    and to_regprocedure('public.renew_job_outbox(uuid,text,bigint,integer)') is not null
    and to_regprocedure(
      'public.complete_job_outbox(uuid,text,bigint,boolean,text,integer)'
    ) is not null
    and to_regprocedure('public.prepare_job_asset_cleanup(uuid,text,bigint)') is not null
    and to_regprocedure('public.finish_job_asset_cleanup(uuid,text,bigint,text[])') is not null
    and has_function_privilege(
      'service_role', 'public.claim_next_job(text,text[],integer)', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.finalize_job(uuid,text,bigint,text,jsonb,text,text,jsonb,jsonb)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.record_job_asset(uuid,text,bigint,uuid,text,text,text,text,bigint,text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.claim_job_outbox(text,text[],integer)', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.renew_job_outbox(uuid,text,bigint,integer)', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.complete_job_outbox(uuid,text,bigint,boolean,text,integer)', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.prepare_job_asset_cleanup(uuid,text,bigint)', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.finish_job_asset_cleanup(uuid,text,bigint,text[])', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'public.claim_next_job(text,text[],integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'public.finalize_job(uuid,text,bigint,text,jsonb,text,text,jsonb,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'public.claim_job_outbox(text,text[],integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'public.prepare_job_asset_cleanup(uuid,text,bigint)', 'EXECUTE'
    )
    and not has_table_privilege('authenticated', 'public.jobs', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.job_outbox', 'UPDATE')
    and not has_table_privilege('service_role', 'public.job_outbox', 'UPDATE')
    and not has_table_privilege('service_role', 'public.job_assets', 'UPDATE')
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'job_outbox'
        and column_name in ('lock_version', 'max_attempts')
      group by table_schema, table_name having count(*) = 2
    )
    and exists (
      select 1 from pg_catalog.pg_class
      where oid = 'public.jobs'::regclass and relrowsecurity
    )
    and exists (
      select 1 from pg_catalog.pg_class
      where oid = 'public.job_assets'::regclass and relrowsecurity
    )
    and exists (
      select 1 from pg_catalog.pg_trigger
      where tgrelid = 'public.jobs'::regclass
        and tgname = 'enforce_job_state_contract'
        and not tgisinternal and tgenabled <> 'D'
    )
    and exists (
      select 1 from pg_catalog.pg_trigger
      where tgrelid = 'public.generated_media_cleanup_jobs'::regclass
        and tgname = 'reconcile_history_job_asset_cleanup'
        and not tgisinternal and tgenabled <> 'D'
    )
    and exists (
      select 1 from pg_catalog.pg_trigger
      where tgrelid = 'public.messages'::regclass
        and tgname = 'enforce_message_sor_contract'
        and not tgisinternal and tgenabled <> 'D'
    )
    and exists (
      select 1 from storage.buckets
      where id = 'generated-media' and public = false
        and coalesce(file_size_limit, 0) = 10485760
    )
    and not exists (
      select 1 from pg_catalog.pg_policies
      where schemaname = 'storage' and tablename = 'objects'
        and policyname in (
          'generated_media_public_read', 'generated_media_upload_own',
          'generated_media_update_own', 'generated_media_delete_own'
        )
    )
    and exists (
      select 1 from storage.buckets
      where id = 'job-payloads' and public = false and file_size_limit = 50331648
    );
$$;

revoke all on function public.runtime_healthcheck_v5()
  from public, anon, authenticated;
grant execute on function public.runtime_healthcheck_v5()
  to service_role;

commit;
