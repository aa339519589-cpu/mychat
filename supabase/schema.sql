-- ============================================
-- mychat 数据库表结构
-- 在 Supabase 后台的 SQL Editor 里粘贴运行
-- 每张表都开启了 RLS（行级安全）：用户只能读写自己的数据
-- ============================================

-- 记忆表
create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.memories enable row level security;
create policy "memories_select" on public.memories for select using (auth.uid() = user_id);
create policy "memories_insert" on public.memories for insert with check (auth.uid() = user_id);
create policy "memories_update" on public.memories for update using (auth.uid() = user_id);
create policy "memories_delete" on public.memories for delete using (auth.uid() = user_id);

-- 对话表
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default '未命名的篇章',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.conversations enable row level security;
create policy "conversations_select" on public.conversations for select using (auth.uid() = user_id);
create policy "conversations_insert" on public.conversations for insert with check (auth.uid() = user_id);
create policy "conversations_update" on public.conversations for update using (auth.uid() = user_id);
create policy "conversations_delete" on public.conversations for delete using (auth.uid() = user_id);

-- 消息表
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null,
  content text not null default '',
  images jsonb,
  thinking text,
  created_at timestamptz not null default now()
);
alter table public.messages enable row level security;
create policy "messages_select" on public.messages for select using (auth.uid() = user_id);
create policy "messages_insert" on public.messages for insert with check (auth.uid() = user_id);
create policy "messages_update" on public.messages for update using (auth.uid() = user_id);
create policy "messages_delete" on public.messages for delete using (auth.uid() = user_id);

-- 加快按对话、按用户查询的速度
create index if not exists idx_messages_conversation on public.messages(conversation_id);
create index if not exists idx_conversations_user on public.conversations(user_id);
create index if not exists idx_memories_user on public.memories(user_id);
