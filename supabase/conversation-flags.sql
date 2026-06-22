-- ============================================
-- 会话「收藏 / 置顶」状态（持久化，跨设备）
-- 在 Supabase 后台 → SQL Editor 粘贴整段、点 Run。幂等：重复跑也安全。
-- ============================================
alter table public.conversations add column if not exists starred boolean not null default false;
alter table public.conversations add column if not exists pinned  boolean not null default false;
