-- Real PostgreSQL contract coverage for the encrypted GitHub connection store.
begin;

insert into auth.users(id) values
  ('91000000-0000-4000-8000-000000000001'),
  ('91000000-0000-4000-8000-000000000002')
on conflict (id) do nothing;

-- An already-expired row can only exist because time elapsed after a valid
-- connection. Seed that state as the migration owner to exercise expiry reads.
insert into public.github_connections(
  connection_id, user_id, github_user_id, login, credential_ciphertext,
  scopes, connected_at, updated_at, expires_at
) values (
  '92000000-0000-4000-8000-000000000002',
  '91000000-0000-4000-8000-000000000002',
  22222,
  'expired-user',
  'github-credential:v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
  array['repo'],
  now() - interval '2 hours',
  now() - interval '2 hours',
  now() - interval '1 hour'
);

set local role service_role;

do $$
declare
  connection_id uuid;
  credential record;
begin
  if has_table_privilege('service_role', 'public.github_connections', 'SELECT')
     or has_table_privilege('authenticated', 'public.github_connections', 'SELECT')
     or has_table_privilege('anon', 'public.github_connections', 'SELECT') then
    raise exception 'github connection table has a direct browser/service grant';
  end if;

  if not has_function_privilege(
    'service_role',
    'public.read_github_connection(uuid,uuid,text,text,text,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.read_github_connection(uuid,uuid,text,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'github credential read RPC privileges are unsafe';
  end if;

  begin
    perform 1 from public.github_connections;
    raise exception 'service role unexpectedly read github_connections directly';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.read_github_connection(
      '91000000-0000-4000-8000-000000000001', null,
      'user', '91000000-0000-4000-8000-000000000001',
      'github.repos', 'request-user-no-id'
    );
    raise exception 'browser credential access without connection id succeeded';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.upsert_github_connection(
      '91000000-0000-4000-8000-000000000001',
      11111,
      'octocat',
      'github-credential:v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
      array[null]::text[],
      now() + interval '1 hour',
      '91000000-0000-4000-8000-000000000001',
      'request-null-scope'
    );
    raise exception 'null OAuth scope unexpectedly accepted';
  exception when invalid_parameter_value then null;
  end;

  connection_id := public.upsert_github_connection(
    '91000000-0000-4000-8000-000000000001',
    11111,
    'octocat',
    'github-credential:v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    array['repo', 'workflow'],
    now() + interval '1 hour',
    '91000000-0000-4000-8000-000000000001',
    'request-connect-1'
  );

  select * into credential
  from public.read_github_connection(
    '91000000-0000-4000-8000-000000000001', null,
    'worker', 'pg16-worker-1', 'agent.publish', 'request-worker-1'
  );
  if credential.connection_id is distinct from connection_id
     or credential.user_id is distinct from '91000000-0000-4000-8000-000000000001'::uuid
     or credential.login is distinct from 'octocat'
     or credential.credential_ciphertext !~ '^github-credential:v1\.' then
    raise exception 'worker credential lookup returned the wrong binding';
  end if;

  if (select count(*) from public.github_connection_status(
    '91000000-0000-4000-8000-000000000001', connection_id,
    'user', '91000000-0000-4000-8000-000000000001',
    'github.status', 'request-status-1'
  )) <> 1 then
    raise exception 'connection status did not bind user and opaque id';
  end if;

  if (select count(*) from public.read_github_connection(
    '91000000-0000-4000-8000-000000000002', null,
    'worker', 'pg16-worker-1', 'agent.publish', 'request-expired-1'
  )) <> 0 then
    raise exception 'expired GitHub credential was returned to a worker';
  end if;

  if not public.delete_github_connection(
    '91000000-0000-4000-8000-000000000001', connection_id,
    '91000000-0000-4000-8000-000000000001', 'request-delete-1'
  ) then
    raise exception 'GitHub connection was not deleted';
  end if;

end;
$$;

reset role;

-- The local fixture's service_role intentionally lacks BYPASSRLS, matching the
-- browser-visible surface. Inspect append-only audit rows as the migration
-- owner after all service-role operations have completed.
do $$
begin
  if (select count(*) from public.audit_log
      where principal_id = '91000000-0000-4000-8000-000000000001') <> 4 then
    raise exception 'GitHub connect/read/status/disconnect audit trail is incomplete';
  end if;
  if not exists (
    select 1 from public.audit_log
    where principal_id = '91000000-0000-4000-8000-000000000002'
      and action = 'github.credential.accessed'
      and metadata->>'outcome' = 'expired'
  ) then
    raise exception 'expired credential access was not audited';
  end if;
  if exists (
    select 1 from public.audit_log
    where principal_id in (
      '91000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000002'
    ) and metadata::text like '%credential_ciphertext%'
  ) then
    raise exception 'credential material leaked into audit metadata';
  end if;
end;
$$;

rollback;
