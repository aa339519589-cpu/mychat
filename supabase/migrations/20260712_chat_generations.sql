-- Durable chat generation tasks (resume after disconnect / refresh)
create table if not exists public.chat_generations (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  assistant_message_id uuid not null,
  status text not null default 'running'
    check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  content text not null default '',
  thinking text not null default '',
  sequence int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.chat_generations enable row level security;
drop policy if exists "chat_generations_select" on public.chat_generations;
create policy "chat_generations_select" on public.chat_generations for select using (auth.uid() = user_id);
drop policy if exists "chat_generations_insert" on public.chat_generations;
create policy "chat_generations_insert" on public.chat_generations for insert with check (auth.uid() = user_id);
drop policy if exists "chat_generations_update" on public.chat_generations;
create policy "chat_generations_update" on public.chat_generations for update using (auth.uid() = user_id);

create index if not exists idx_chat_generations_conversation
  on public.chat_generations(conversation_id, status);
create index if not exists idx_chat_generations_user
  on public.chat_generations(user_id, status);
