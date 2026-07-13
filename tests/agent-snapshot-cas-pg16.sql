\set ON_ERROR_STOP on

do $$
begin
  if (select public from storage.buckets where id = 'agent-snapshots') is distinct from false then
    raise exception 'snapshot bucket is not private';
  end if;
  if (select file_size_limit from storage.buckets where id = 'agent-snapshots') <> 67108864 then
    raise exception 'snapshot bucket size limit is wrong';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname in ('agent_snapshot_blobs_update_own', 'agent_snapshot_blobs_delete_own')
  ) then raise exception 'snapshot blobs are mutable by browser roles'; end if;
end;
$$;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
set request.jwt.claim.role = 'authenticated';

insert into storage.objects(bucket_id, name) values (
  'agent-snapshots',
  '00000000-0000-4000-8000-000000000001/85000000-0000-4000-8000-000000000001/blobs/' || repeat('a', 64)
);

do $$
begin
  begin
    insert into storage.objects(bucket_id, name) values (
      'agent-snapshots',
      '00000000-0000-4000-8000-000000000002/85000000-0000-4000-8000-000000000001/blobs/' || repeat('b', 64)
    );
    raise exception 'cross-tenant snapshot blob insert unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$$;

insert into public.agent_artifacts(
  id, task_id, user_id, kind, title, content, meta
) values (
  '86000000-0000-4000-8000-000000000001',
  '85000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  'summary', 'snapshot:87000000-0000-4000-8000-000000000001',
  '{"format":"cas-v1"}', '{}'::jsonb
);

do $$
begin
  begin
    update public.agent_artifacts set content = '{}' where id = '86000000-0000-4000-8000-000000000001';
    raise exception 'snapshot manifest update unexpectedly succeeded';
  exception when sqlstate '55000' then null;
  end;
  begin
    delete from public.agent_artifacts where id = '86000000-0000-4000-8000-000000000001';
    raise exception 'snapshot manifest delete unexpectedly succeeded';
  exception when sqlstate '55000' then null;
  end;
end;
$$;

reset request.jwt.claim.sub;
reset request.jwt.claim.role;
reset role;

do $$
begin
  if not exists (
    select 1 from public.agent_artifacts
    where id = '86000000-0000-4000-8000-000000000001'
  ) then raise exception 'immutable snapshot manifest disappeared'; end if;
end;
$$;
