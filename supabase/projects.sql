-- ============================================
-- 「项目」功能建表（第4批）
-- 在 Supabase 后台 → SQL Editor 里粘贴整段、点 Run 即可。
-- 全部幂等：重复运行也安全（不会报错、不会清数据）。
-- ============================================

-- 项目表：文件夹 + 专属指令/人设
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default '未命名项目',
  instructions text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.projects enable row level security;
drop policy if exists "projects_select" on public.projects;
create policy "projects_select" on public.projects for select using (auth.uid() = user_id);
drop policy if exists "projects_insert" on public.projects;
create policy "projects_insert" on public.projects for insert with check (auth.uid() = user_id);
drop policy if exists "projects_update" on public.projects;
create policy "projects_update" on public.projects for update using (auth.uid() = user_id);
drop policy if exists "projects_delete" on public.projects;
create policy "projects_delete" on public.projects for delete using (auth.uid() = user_id);
create index if not exists idx_projects_user on public.projects(user_id);

-- 项目参考资料：上传文件抽取出的纯文本
create table if not exists public.project_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  content text not null default '',
  created_at timestamptz not null default now()
);
alter table public.project_files enable row level security;
drop policy if exists "project_files_select" on public.project_files;
create policy "project_files_select" on public.project_files for select using (auth.uid() = user_id);
drop policy if exists "project_files_insert" on public.project_files;
create policy "project_files_insert" on public.project_files for insert with check (auth.uid() = user_id);
drop policy if exists "project_files_delete" on public.project_files;
create policy "project_files_delete" on public.project_files for delete using (auth.uid() = user_id);
create index if not exists idx_project_files_project on public.project_files(project_id);

-- 对话归属项目（为空＝不属于任何项目；项目删除后对话自动解绑，不丢失）
alter table public.conversations add column if not exists project_id uuid references public.projects(id) on delete set null;
