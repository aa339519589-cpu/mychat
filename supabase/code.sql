-- ════════════════════════════════════════════════════════════════════
-- Code 板块专属数据表：与主聊天（conversations/messages/memories）完全隔离
-- 会话、消息、记忆都单独建表，主聊天侧栏与系统记忆永远看不到这里的数据。
-- 在 Supabase SQL Editor 里整段执行即可。
-- ════════════════════════════════════════════════════════════════════

-- ───────────── Code 会话 ─────────────
create table if not exists public.code_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  repo        text not null,                 -- owner/name
  title       text not null default '未命名排查',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.code_sessions enable row level security;

drop policy if exists "code_sessions_select_own" on public.code_sessions;
create policy "code_sessions_select_own" on public.code_sessions
  for select using (auth.uid() = user_id);
drop policy if exists "code_sessions_insert_own" on public.code_sessions;
create policy "code_sessions_insert_own" on public.code_sessions
  for insert with check (auth.uid() = user_id);
drop policy if exists "code_sessions_update_own" on public.code_sessions;
create policy "code_sessions_update_own" on public.code_sessions
  for update using (auth.uid() = user_id);
drop policy if exists "code_sessions_delete_own" on public.code_sessions;
create policy "code_sessions_delete_own" on public.code_sessions
  for delete using (auth.uid() = user_id);

-- ───────────── Code 消息 ─────────────
create table if not exists public.code_messages (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.code_sessions(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null,                 -- 'user' | 'assistant'
  content     text not null default '',
  meta        jsonb,                          -- 工具步骤 / 修改建议 / PR 链接（可选）
  created_at  timestamptz not null default now()
);

alter table public.code_messages enable row level security;

drop policy if exists "code_messages_select_own" on public.code_messages;
create policy "code_messages_select_own" on public.code_messages
  for select using (auth.uid() = user_id);
drop policy if exists "code_messages_insert_own" on public.code_messages;
create policy "code_messages_insert_own" on public.code_messages
  for insert with check (auth.uid() = user_id);
drop policy if exists "code_messages_delete_own" on public.code_messages;
create policy "code_messages_delete_own" on public.code_messages
  for delete using (auth.uid() = user_id);

-- ───────────── Code 记忆（按 repo 隔离，独立于系统记忆 memories 表）─────────────
create table if not exists public.code_memories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  repo        text not null,                 -- owner/name，记忆按仓库归属
  content     text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.code_memories enable row level security;

drop policy if exists "code_memories_select_own" on public.code_memories;
create policy "code_memories_select_own" on public.code_memories
  for select using (auth.uid() = user_id);
drop policy if exists "code_memories_insert_own" on public.code_memories;
create policy "code_memories_insert_own" on public.code_memories
  for insert with check (auth.uid() = user_id);
drop policy if exists "code_memories_update_own" on public.code_memories;
create policy "code_memories_update_own" on public.code_memories
  for update using (auth.uid() = user_id);
drop policy if exists "code_memories_delete_own" on public.code_memories;
create policy "code_memories_delete_own" on public.code_memories
  for delete using (auth.uid() = user_id);

-- ───────────── 索引 ─────────────
create index if not exists idx_code_sessions_user_repo on public.code_sessions(user_id, repo, updated_at desc);
create index if not exists idx_code_messages_session on public.code_messages(session_id, created_at);
create index if not exists idx_code_memories_user_repo on public.code_memories(user_id, repo, created_at);
