begin;

alter table public.mcp_connectors
  add column if not exists auth_type text not null default 'none' check (auth_type in ('none','bearer','oauth')),
  add column if not exists oauth_status text not null default 'connected' check (oauth_status in ('pending','connected','reauth_required')),
  add column if not exists oauth_refresh_lease uuid,
  add column if not exists oauth_refresh_until timestamptz;
update public.mcp_connectors set auth_type = 'bearer'
  where auth_type = 'none' and credential_ciphertext is not null;
create unique index if not exists mcp_connectors_id_owner_unique on public.mcp_connectors(id, user_id);

create table if not exists public.mcp_oauth_sessions (
  state_hash text primary key check (state_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  connector_id uuid not null,
  server_url text not null,
  secret_ciphertext text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (connector_id,user_id) references public.mcp_connectors(id,user_id) on delete cascade
);
alter table public.mcp_oauth_sessions enable row level security;
revoke all on public.mcp_oauth_sessions from public, anon, authenticated;
grant select, insert, update, delete on public.mcp_oauth_sessions to service_role;
create index if not exists mcp_oauth_sessions_expiry on public.mcp_oauth_sessions(expires_at);

create or replace function public.claim_connector_oauth_refresh(input_user_id uuid, input_connector_id uuid, input_lease uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare saved text;
begin
  if input_user_id is null or input_connector_id is null or input_lease is null then
    raise exception 'invalid_oauth_refresh_identity' using errcode='22023';
  end if;
  update public.mcp_connectors
    set oauth_refresh_lease=input_lease, oauth_refresh_until=now()+interval '60 seconds'
    where id=input_connector_id and user_id=input_user_id and enabled and auth_type='oauth'
      and oauth_status='connected' and (oauth_refresh_until is null or oauth_refresh_until < now())
    returning credential_ciphertext into saved;
  if not found then return null; end if;
  return jsonb_build_object('ciphertext',saved);
end;
$$;
revoke all on function public.claim_connector_oauth_refresh(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.claim_connector_oauth_refresh(uuid,uuid,uuid) to service_role;

-- Ordinary profile edits must still work after sensitive memory is enabled.
-- Changing consent in either direction remains a server-only operation.
create or replace function public.guard_sensitive_memory_preference()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if current_user in ('postgres','service_role','supabase_admin') then return new; end if;
  if (tg_op='INSERT' and coalesce(new.sensitive_memory_enabled,false))
     or (tg_op='UPDATE' and new.sensitive_memory_enabled is distinct from old.sensitive_memory_enabled) then
    raise exception 'sensitive_memory_setting_requires_server_route' using errcode='42501';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_sensitive_memory_preference() from public, anon, authenticated;
commit;
