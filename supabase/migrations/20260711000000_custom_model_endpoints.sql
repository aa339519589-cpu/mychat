-- Restore account-scoped custom OpenAI-compatible endpoints.
-- API keys are encrypted by the application before they reach this table.

create table if not exists public.endpoints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  protocol text not null default 'openai',
  base_url text not null,
  api_key text not null,
  model text not null,
  output_kind text not null default 'chat',
  auth_type text not null default 'bearer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.endpoints add column if not exists auth_type text not null default 'bearer';
alter table public.endpoints add column if not exists output_kind text not null default 'chat';
alter table public.endpoints add column if not exists updated_at timestamptz not null default now();

alter table public.endpoints drop constraint if exists endpoints_auth_type_check;
alter table public.endpoints add constraint endpoints_auth_type_check
  check (auth_type in ('bearer', 'x-api-key', 'api-key', 'none'));

alter table public.endpoints drop constraint if exists endpoints_output_kind_check;
alter table public.endpoints add constraint endpoints_output_kind_check
  check (output_kind in ('chat', 'image', 'video'));

alter table public.endpoints enable row level security;
drop policy if exists "endpoints_select" on public.endpoints;
drop policy if exists "endpoints_insert" on public.endpoints;
drop policy if exists "endpoints_update" on public.endpoints;
drop policy if exists "endpoints_delete" on public.endpoints;

-- Keep owner-scoped write policies: endpoint API routes use the caller's cookie-bound
-- Supabase session, not a service-role client, so removing them would also block the
-- server routes. A browser can therefore alter its own row, but cannot mint a valid
-- v3 api_key ciphertext: AES-GCM authenticates user_id, id, canonical base_url,
-- protocol, auth_type, model, and output_kind with the server-only
-- AGENT_CREDENTIAL_KEY. Any
-- direct routing-field edit makes credential decryption fail closed.
create policy "endpoints_select" on public.endpoints for select using (auth.uid() = user_id);
create policy "endpoints_insert" on public.endpoints for insert with check (auth.uid() = user_id);
create policy "endpoints_update" on public.endpoints for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "endpoints_delete" on public.endpoints for delete using (auth.uid() = user_id);

create index if not exists idx_endpoints_user on public.endpoints(user_id);
create index if not exists idx_endpoints_user_updated on public.endpoints(user_id, updated_at desc);
