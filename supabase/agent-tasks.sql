-- ============================================
-- Agent Task 持久化系统：地基表
-- 在 Supabase 后台 SQL Editor 里粘贴运行（幂等）
-- 所有表都启用 RLS：用户只能读写自己的数据
-- ============================================

-- 1. Agent 任务主表
create table if not exists public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- 任务目标
  goal text not null,
  mode text not null default 'auto' check (mode in ('auto', 'confirm', 'plan')),

  -- 仓库上下文
  repo text,
  branch text not null default 'main',

  -- 生命周期
  status text not null default 'pending' check (status in (
    'pending', 'running', 'waiting_confirm', 'cancelled',
    'failed', 'completed', 'paused'
  )),
  error text,

  -- 时间
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,

  -- 元数据
  meta jsonb
);

alter table public.agent_tasks enable row level security;
create policy "agent_tasks_select" on public.agent_tasks for select using (auth.uid() = user_id);
create policy "agent_tasks_insert" on public.agent_tasks for insert with check (auth.uid() = user_id);
create policy "agent_tasks_update" on public.agent_tasks for update using (auth.uid() = user_id);
create policy "agent_tasks_delete" on public.agent_tasks for delete using (auth.uid() = user_id);
create index if not exists idx_agent_tasks_user_status on public.agent_tasks(user_id, status);
create index if not exists idx_agent_tasks_user_created on public.agent_tasks(user_id, created_at desc);

-- 2. 任务执行步骤
create table if not exists public.agent_task_steps (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.agent_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,

  -- 步骤信息
  kind text not null default 'info' check (kind in (
    'info', 'thinking', 'plan', 'tool_call', 'confirm', 'error', 'done'
  )),
  label text,
  detail text,

  -- 排序与时间
  seq integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.agent_task_steps enable row level security;
create policy "agent_steps_select" on public.agent_task_steps for select using (auth.uid() = user_id);
create policy "agent_steps_insert" on public.agent_task_steps for insert with check (auth.uid() = user_id);
create policy "agent_steps_update" on public.agent_task_steps for update using (auth.uid() = user_id);
create policy "agent_steps_delete" on public.agent_task_steps for delete using (auth.uid() = user_id);
create index if not exists idx_agent_steps_task on public.agent_task_steps(task_id, seq);

-- 3. 工具调用日志
create table if not exists public.agent_tool_calls (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.agent_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  step_id uuid references public.agent_task_steps(id) on delete set null,

  -- 工具调用细节
  tool_name text not null,
  input jsonb,
  output jsonb,
  error text,
  status text not null default 'pending' check (status in (
    'pending', 'running', 'success', 'error', 'cancelled'
  )),

  -- 计时
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer,

  -- 序号（按任务排序）
  seq integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.agent_tool_calls enable row level security;
create policy "agent_tool_calls_select" on public.agent_tool_calls for select using (auth.uid() = user_id);
create policy "agent_tool_calls_insert" on public.agent_tool_calls for insert with check (auth.uid() = user_id);
create policy "agent_tool_calls_update" on public.agent_tool_calls for update using (auth.uid() = user_id);
create index if not exists idx_agent_tool_calls_task on public.agent_tool_calls(task_id, seq);

-- 4. Workspace 元数据（当前仅记录，不做真实 clone）
create table if not exists public.agent_workspaces (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.agent_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,

  -- workspace 信息
  repo text not null,
  branch text not null default 'main',
  commit_sha text,
  path text,

  -- 状态
  status text not null default 'created' check (status in (
    'created', 'cloning', 'ready', 'error', 'cleaned'
  )),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.agent_workspaces enable row level security;
create policy "agent_workspaces_select" on public.agent_workspaces for select using (auth.uid() = user_id);
create policy "agent_workspaces_insert" on public.agent_workspaces for insert with check (auth.uid() = user_id);
create policy "agent_workspaces_update" on public.agent_workspaces for update using (auth.uid() = user_id);
create index if not exists idx_agent_workspaces_task on public.agent_workspaces(task_id);

-- 5. 产物（diff、日志、截图、PR 链接、部署链接等）
create table if not exists public.agent_artifacts (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.agent_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,

  -- 产物分类
  kind text not null default 'other' check (kind in (
    'diff', 'log', 'screenshot', 'pr', 'deploy', 'file', 'other'
  )),
  title text,
  content text,
  url text,
  meta jsonb,

  created_at timestamptz not null default now()
);

alter table public.agent_artifacts enable row level security;
create policy "agent_artifacts_select" on public.agent_artifacts for select using (auth.uid() = user_id);
create policy "agent_artifacts_insert" on public.agent_artifacts for insert with check (auth.uid() = user_id);
create policy "agent_artifacts_delete" on public.agent_artifacts for delete using (auth.uid() = user_id);
create index if not exists idx_agent_artifacts_task on public.agent_artifacts(task_id);
