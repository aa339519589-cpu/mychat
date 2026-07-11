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

-- 模型端点表。api_key 由服务端使用 AGENT_CREDENTIAL_KEY 加密后写入。
create table if not exists public.endpoints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  protocol text not null,
  base_url text not null,
  api_key text not null,
  model text not null,
  output_kind text not null default 'chat',
  auth_type text not null default 'bearer' check (auth_type in ('bearer', 'x-api-key', 'api-key', 'none')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.endpoints add column if not exists output_kind text not null default 'chat';
alter table public.endpoints drop constraint if exists endpoints_output_kind_check;
alter table public.endpoints add constraint endpoints_output_kind_check
  check (output_kind in ('chat', 'image', 'video'));
alter table public.endpoints enable row level security;
drop policy if exists "endpoints_select" on public.endpoints;
create policy "endpoints_select" on public.endpoints for select using (auth.uid() = user_id);
-- 这里保留仅限 owner 的写策略：API route 使用用户 Cookie 对应的 Supabase 会话，
-- 并非 service-role 客户端，移除策略也会让服务端写入失效。用户虽可直接改自己的行，
-- 但服务端签发的 v3 api_key 密文会用 AES-GCM 同时认证 user_id、id、规范化
-- base_url、protocol、auth_type、model 和 output_kind；任何路由字段被直改后都会解密失败，
-- 浏览器也因拿不到 AGENT_CREDENTIAL_KEY 而无法为篡改后的配置生成有效密文。
drop policy if exists "endpoints_insert" on public.endpoints;
create policy "endpoints_insert" on public.endpoints for insert with check (auth.uid() = user_id);
drop policy if exists "endpoints_delete" on public.endpoints;
create policy "endpoints_delete" on public.endpoints for delete using (auth.uid() = user_id);
drop policy if exists "endpoints_update" on public.endpoints;
create policy "endpoints_update" on public.endpoints for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create index if not exists idx_endpoints_user on public.endpoints(user_id);

-- ============================================
-- 以下为新功能表，一次性建好，免得多次操作。
-- 【现在就用】profiles.memory_enabled —— 记忆总开关
-- 【预留】profiles 的额度字段（第2批：额度系统）
-- 【预留】projects / project_files（第4批：项目）
-- 【预留】artifacts（第3批：作品库）
-- ============================================

-- 用户档案表：每个用户一行。记忆开关 + 额度池。
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  memory_enabled boolean not null default true,
  custom_system_prompt text default '',
  -- 额度池（按真实 token 计；懒重置，无后台任务）
  tokens_5h bigint not null default 0,
  window_5h_start timestamptz,
  tokens_7d bigint not null default 0,
  window_7d_start timestamptz,
  quota_version bigint not null default 0,
  balance bigint not null default 0,
  -- 旧额度列名（兼容过渡期；新代码读写 tokens_5h/tokens_7d）
  pool_5h_used bigint not null default 0,
  pool_5h_reset_at timestamptz,
  pool_week_used bigint not null default 0,
  pool_week_reset_at timestamptz,
  -- 单人额度上限覆盖；为空则取全局默认值。可在 Supabase 直接改某人这两列即时调额。
  limit_5h bigint,
  limit_week bigint,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "profiles_select" on public.profiles for select using (auth.uid() = user_id);
create policy "profiles_insert" on public.profiles for insert with check (auth.uid() = user_id);
create policy "profiles_update" on public.profiles for update using (auth.uid() = user_id);

-- 项目表（第4批）：文件夹 + 自定义指令/人设
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default '未命名项目',
  instructions text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.projects enable row level security;
create policy "projects_select" on public.projects for select using (auth.uid() = user_id);
create policy "projects_insert" on public.projects for insert with check (auth.uid() = user_id);
create policy "projects_update" on public.projects for update using (auth.uid() = user_id);
create policy "projects_delete" on public.projects for delete using (auth.uid() = user_id);
create index if not exists idx_projects_user on public.projects(user_id);

-- 项目参考资料（第4批）：上传文件抽取出的文本
create table if not exists public.project_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  content text not null default '',
  created_at timestamptz not null default now()
);
alter table public.project_files enable row level security;
create policy "project_files_select" on public.project_files for select using (auth.uid() = user_id);
create policy "project_files_insert" on public.project_files for insert with check (auth.uid() = user_id);
create policy "project_files_delete" on public.project_files for delete using (auth.uid() = user_id);
create index if not exists idx_project_files_project on public.project_files(project_id);

-- 对话归属项目（第4批）：为空＝不属于任何项目
alter table public.conversations add column if not exists project_id uuid references public.projects(id) on delete set null;

-- 对话收藏/置顶（持久化，跨设备）
alter table public.conversations add column if not exists starred boolean not null default false;
alter table public.conversations add column if not exists pinned boolean not null default false;

-- 邀请码表
create table if not exists public.invitation_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  tokens bigint not null default 20_000_000,
  created_by uuid references auth.users(id) on delete set null,
  used_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
alter table public.invitation_codes enable row level security;
create policy "codes_read" on public.invitation_codes for select
  using (used_by is not null or created_by = auth.uid());
create policy "codes_redeem" on public.invitation_codes for update
  using (used_by is null and auth.uid() is not null) with check (used_by = auth.uid());

-- Code 板块记忆表
create table if not exists public.code_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  repo text not null,
  content text not null,
  created_at timestamptz not null default now()
);
alter table public.code_memories enable row level security;
create policy "code_memories_select" on public.code_memories for select using (auth.uid() = user_id);
create policy "code_memories_insert" on public.code_memories for insert with check (auth.uid() = user_id);
create policy "code_memories_delete" on public.code_memories for delete using (auth.uid() = user_id);

-- Code 板块会话表
create table if not exists public.code_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  repo text not null,
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.code_sessions enable row level security;
create policy "code_sessions_select" on public.code_sessions for select using (auth.uid() = user_id);
create policy "code_sessions_insert" on public.code_sessions for insert with check (auth.uid() = user_id);
create policy "code_sessions_update" on public.code_sessions for update using (auth.uid() = user_id);
create policy "code_sessions_delete" on public.code_sessions for delete using (auth.uid() = user_id);

-- Code 板块消息表
create table if not exists public.code_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.code_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null,
  content text not null default '',
  plan jsonb,
  created_at timestamptz not null default now()
);
alter table public.code_messages enable row level security;
create policy "code_messages_select" on public.code_messages for select using (auth.uid() = user_id);
create policy "code_messages_insert" on public.code_messages for insert with check (auth.uid() = user_id);

-- 项目记忆表
create table if not exists public.project_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);
alter table public.project_memories enable row level security;
create policy "project_memories_select" on public.project_memories for select using (auth.uid() = user_id);
create policy "project_memories_insert" on public.project_memories for insert with check (auth.uid() = user_id);
create policy "project_memories_delete" on public.project_memories for delete using (auth.uid() = user_id);

-- 作品库（第3批）：只收方式三 <artifact> 整面板内容
create table if not exists public.artifacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  title text not null default '渲染结果',
  html text not null,
  created_at timestamptz not null default now()
);
alter table public.artifacts enable row level security;
create policy "artifacts_select" on public.artifacts for select using (auth.uid() = user_id);
create policy "artifacts_insert" on public.artifacts for insert with check (auth.uid() = user_id);
create policy "artifacts_delete" on public.artifacts for delete using (auth.uid() = user_id);
create index if not exists idx_artifacts_user on public.artifacts(user_id);
