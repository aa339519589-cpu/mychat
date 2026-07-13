-- Persist GitHub OAuth credentials for API and worker processes without ever
-- making bearer tokens available to browser roles. Credential reads go through
-- an audited SECURITY DEFINER function; even service_role has no direct table
-- grant, which prevents an accidental unaudited adapter read.
begin;

create table if not exists public.github_connections (
  connection_id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  github_user_id bigint not null check (github_user_id > 0),
  login text not null,
  credential_ciphertext text not null,
  scopes text[] not null default '{}'::text[],
  expires_at timestamptz,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz,
  constraint github_connections_login_check check (
    length(login) between 1 and 100
    and login ~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,98}[A-Za-z0-9])?$'
  ),
  constraint github_connections_ciphertext_check check (
    length(credential_ciphertext) between 48 and 16384
    and credential_ciphertext ~ '^github-credential:v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$'
  ),
  constraint github_connections_scopes_check check (
    cardinality(scopes) <= 64
    and octet_length(scopes::text) <= 4096
    and array_position(scopes, null) is null
  ),
  constraint github_connections_expiry_check check (
    expires_at is null or expires_at > connected_at
  ),
  constraint github_connections_timestamp_check check (
    updated_at >= connected_at
    and (last_used_at is null or (last_used_at >= connected_at and last_used_at <= updated_at))
  )
);

create index if not exists github_connections_github_user_id_idx
  on public.github_connections(github_user_id);
create index if not exists github_connections_expiry_idx
  on public.github_connections(expires_at)
  where expires_at is not null;

alter table public.github_connections enable row level security;

-- There are deliberately no RLS policies and no direct service_role grant.
-- All access is mediated by the service-role-only functions below.
revoke all on table public.github_connections from public, anon, authenticated, service_role;

comment on table public.github_connections is
  'Server-only encrypted GitHub OAuth credentials, keyed by Supabase user and opaque connection id.';
comment on column public.github_connections.credential_ciphertext is
  'AES-256-GCM ciphertext authenticated with the Supabase user id and GitHub login.';

-- audit_log is introduced by the preceding unified control-plane migration.
-- The dynamic statement keeps expand/contract rolling deploys safe when this
-- migration is staged against an older database where audit_log is not present
-- yet. When the table exists, an audit failure aborts the credential operation.
create or replace function public.write_github_connection_audit(
  input_principal_id uuid,
  input_actor_type text,
  input_actor_id text,
  input_action text,
  input_resource_id text,
  input_request_id text,
  input_metadata jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if to_regclass('public.audit_log') is null then
    return;
  end if;

  execute $audit$
    insert into public.audit_log(
      principal_id, actor_type, actor_id, action, resource_type,
      resource_id, request_id, metadata, created_at
    ) values ($1, $2, $3, $4, 'github_connection', $5, $6, $7, now())
  $audit$
  using input_principal_id, input_actor_type, input_actor_id, input_action,
    input_resource_id, input_request_id, coalesce(input_metadata, '{}'::jsonb);
exception
  when undefined_table or undefined_column then
    -- Compatibility only for an older schema during migration expansion.
    return;
end;
$$;

create or replace function public.validate_github_connection_actor(
  input_user_id uuid,
  input_connection_id uuid,
  input_actor_type text,
  input_actor_id text,
  input_purpose text,
  input_request_id text
)
returns void
language plpgsql
immutable
security definer
set search_path = public, pg_temp
as $$
begin
  if input_user_id is null
     or input_actor_type not in ('user', 'service', 'worker', 'system')
     or coalesce(length(input_actor_id), 0) not between 1 and 200
     or coalesce(input_purpose, '') !~ '^[a-z][a-z0-9_.-]{1,99}$'
     or coalesce(length(input_request_id), 0) > 200 then
    raise exception 'invalid_github_connection_access' using errcode = '22023';
  end if;

  if input_actor_type = 'user'
     and (input_actor_id <> input_user_id::text or input_connection_id is null) then
    raise exception 'invalid_github_connection_user_binding' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.upsert_github_connection(
  input_user_id uuid,
  input_github_user_id bigint,
  input_login text,
  input_credential_ciphertext text,
  input_scopes text[],
  input_expires_at timestamptz,
  input_actor_id text,
  input_request_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_connection_id uuid := gen_random_uuid();
  v_scope text;
begin
  if input_user_id is null
     or input_actor_id is distinct from input_user_id::text
     or input_github_user_id is null or input_github_user_id <= 0
     or coalesce(length(input_login), 0) not between 1 and 100
     or input_login !~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,98}[A-Za-z0-9])?$'
     or coalesce(length(input_credential_ciphertext), 0) not between 48 and 16384
     or input_credential_ciphertext !~ '^github-credential:v1\.'
     or cardinality(coalesce(input_scopes, '{}'::text[])) > 64
     or octet_length(coalesce(input_scopes, '{}'::text[])::text) > 4096
     or (input_expires_at is not null and input_expires_at <= v_now)
     or coalesce(length(input_request_id), 0) > 200 then
    raise exception 'invalid_github_connection' using errcode = '22023';
  end if;

  foreach v_scope in array coalesce(input_scopes, '{}'::text[]) loop
    if coalesce(length(v_scope), 0) not between 1 and 100
       or v_scope !~ '^[A-Za-z0-9:_-]+$' then
      raise exception 'invalid_github_connection_scope' using errcode = '22023';
    end if;
  end loop;

  insert into public.github_connections(
    connection_id, user_id, github_user_id, login, credential_ciphertext,
    scopes, expires_at, connected_at, updated_at, last_used_at
  ) values (
    v_connection_id, input_user_id, input_github_user_id, input_login,
    input_credential_ciphertext, coalesce(input_scopes, '{}'::text[]),
    input_expires_at, v_now, v_now, null
  )
  on conflict (user_id) do update set
    connection_id = excluded.connection_id,
    github_user_id = excluded.github_user_id,
    login = excluded.login,
    credential_ciphertext = excluded.credential_ciphertext,
    scopes = excluded.scopes,
    expires_at = excluded.expires_at,
    connected_at = excluded.connected_at,
    updated_at = excluded.updated_at,
    last_used_at = null;

  perform public.write_github_connection_audit(
    input_user_id, 'user', input_actor_id, 'github.connection.connected',
    v_connection_id::text, input_request_id,
    jsonb_build_object(
      'githubUserId', input_github_user_id,
      'login', input_login,
      'expiresAt', input_expires_at,
      'scopeCount', cardinality(coalesce(input_scopes, '{}'::text[]))
    )
  );

  return v_connection_id;
end;
$$;

create or replace function public.read_github_connection(
  input_user_id uuid,
  input_connection_id uuid,
  input_actor_type text,
  input_actor_id text,
  input_purpose text,
  input_request_id text default null
)
returns table (
  connection_id uuid,
  user_id uuid,
  github_user_id bigint,
  login text,
  credential_ciphertext text,
  scopes text[],
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_connection public.github_connections%rowtype;
  v_now timestamptz := now();
begin
  perform public.validate_github_connection_actor(
    input_user_id, input_connection_id, input_actor_type, input_actor_id,
    input_purpose, input_request_id
  );

  select connection.* into v_connection
  from public.github_connections as connection
  where connection.user_id = input_user_id
    and (input_connection_id is null or connection.connection_id = input_connection_id)
  for update;

  if not found then
    perform public.write_github_connection_audit(
      input_user_id, input_actor_type, input_actor_id,
      'github.credential.accessed',
      coalesce(input_connection_id::text, input_user_id::text),
      input_request_id,
      jsonb_build_object('outcome', 'not_found', 'purpose', input_purpose)
    );
    return;
  end if;

  if v_connection.expires_at is not null
     and v_connection.expires_at <= v_now
     and input_purpose <> 'github.disconnect' then
    perform public.write_github_connection_audit(
      input_user_id, input_actor_type, input_actor_id,
      'github.credential.accessed', v_connection.connection_id::text,
      input_request_id,
      jsonb_build_object('outcome', 'expired', 'purpose', input_purpose)
    );
    return;
  end if;

  update public.github_connections as connection
  set last_used_at = v_now, updated_at = v_now
  where connection.connection_id = v_connection.connection_id;

  perform public.write_github_connection_audit(
    input_user_id, input_actor_type, input_actor_id,
    'github.credential.accessed', v_connection.connection_id::text,
    input_request_id,
    jsonb_build_object(
      'outcome', case
        when v_connection.expires_at is not null and v_connection.expires_at <= v_now
          then 'granted_for_revocation'
        else 'granted'
      end,
      'purpose', input_purpose
    )
  );

  return query select
    v_connection.connection_id,
    v_connection.user_id,
    v_connection.github_user_id,
    v_connection.login,
    v_connection.credential_ciphertext,
    v_connection.scopes,
    v_connection.expires_at;
end;
$$;

create or replace function public.github_connection_status(
  input_user_id uuid,
  input_connection_id uuid,
  input_actor_type text,
  input_actor_id text,
  input_purpose text,
  input_request_id text default null
)
returns table (
  connection_id uuid,
  user_id uuid,
  github_user_id bigint,
  login text,
  expires_at timestamptz,
  connected_at timestamptz,
  last_used_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_connection public.github_connections%rowtype;
  v_found boolean;
begin
  perform public.validate_github_connection_actor(
    input_user_id, input_connection_id, input_actor_type, input_actor_id,
    input_purpose, input_request_id
  );

  select connection.* into v_connection
  from public.github_connections as connection
  where connection.user_id = input_user_id
    and (input_connection_id is null or connection.connection_id = input_connection_id)
    and (connection.expires_at is null or connection.expires_at > now());
  v_found := found;

  perform public.write_github_connection_audit(
    input_user_id, input_actor_type, input_actor_id,
    'github.connection.status_read',
    coalesce(v_connection.connection_id::text, input_connection_id::text, input_user_id::text),
    input_request_id,
    jsonb_build_object(
      'outcome', case when v_found then 'found' else 'not_found' end,
      'purpose', input_purpose
    )
  );

  if not v_found then return; end if;

  return query select
    v_connection.connection_id,
    v_connection.user_id,
    v_connection.github_user_id,
    v_connection.login,
    v_connection.expires_at,
    v_connection.connected_at,
    v_connection.last_used_at;
end;
$$;

create or replace function public.delete_github_connection(
  input_user_id uuid,
  input_connection_id uuid,
  input_actor_id text,
  input_request_id text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_connection_id uuid;
  v_deleted boolean;
begin
  if input_user_id is null
     or input_actor_id is distinct from input_user_id::text
     or coalesce(length(input_request_id), 0) > 200 then
    raise exception 'invalid_github_connection_delete' using errcode = '42501';
  end if;

  delete from public.github_connections as connection
  where connection.user_id = input_user_id
    and (input_connection_id is null or connection.connection_id = input_connection_id)
  returning connection.connection_id into v_connection_id;
  v_deleted := found;

  perform public.write_github_connection_audit(
    input_user_id, 'user', input_actor_id, 'github.connection.disconnected',
    coalesce(v_connection_id::text, input_connection_id::text, input_user_id::text),
    input_request_id,
    jsonb_build_object('outcome', case when v_deleted then 'deleted' else 'not_found' end)
  );

  return v_deleted;
end;
$$;

revoke all on function public.write_github_connection_audit(uuid, text, text, text, text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.validate_github_connection_actor(uuid, uuid, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.upsert_github_connection(uuid, bigint, text, text, text[], timestamptz, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.read_github_connection(uuid, uuid, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.github_connection_status(uuid, uuid, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.delete_github_connection(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;

grant execute on function public.upsert_github_connection(uuid, bigint, text, text, text[], timestamptz, text, text)
  to service_role;
grant execute on function public.read_github_connection(uuid, uuid, text, text, text, text)
  to service_role;
grant execute on function public.github_connection_status(uuid, uuid, text, text, text, text)
  to service_role;
grant execute on function public.delete_github_connection(uuid, uuid, text, text)
  to service_role;

commit;
