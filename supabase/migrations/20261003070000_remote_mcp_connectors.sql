-- Store user-configured remote MCP connections. Credential ciphertext is
-- service-only; application routes and chat workers always scope by user_id.
begin;

create table if not exists public.mcp_connectors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  server_url text not null check (length(server_url) between 9 and 2048),
  credential_ciphertext text,
  tools jsonb not null default '[]'::jsonb check (jsonb_typeof(tools) = 'array'),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.mcp_connectors enable row level security;
revoke all on table public.mcp_connectors from public, anon, authenticated;
grant select, insert, update, delete on table public.mcp_connectors to service_role;

create unique index if not exists mcp_connectors_user_name_unique
  on public.mcp_connectors(user_id, lower(name));
create index if not exists mcp_connectors_enabled_by_user
  on public.mcp_connectors(user_id, created_at)
  where enabled;

comment on table public.mcp_connectors is
  'User-owned remote MCP servers. Access tokens are authenticated ciphertext and the table is service-role only.';
comment on column public.mcp_connectors.credential_ciphertext is
  'Optional Bearer token sealed with AES-256-GCM and bound to owner, connector id, and server URL.';
comment on column public.mcp_connectors.tools is
  'Bounded, sanitized MCP tools/list snapshot used to build model function schemas; refresh on demand.';

commit;
