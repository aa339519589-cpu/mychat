-- ============================================
-- 额度系统所需的 profiles 列（第2批：额度系统）
-- 在 Supabase 后台 SQL Editor 里整段粘贴运行（幂等，可重复跑）
--
-- 【为什么要单独跑这个】
-- schema.sql 里 profiles 的旧额度列叫 pool_5h_used / pool_week_used，
-- 但代码（app/api/chat/route.ts、lib/db.ts）读写的是下面这几列。
-- 这几列若没建，addQuotaUsage 的 UPDATE 会因"列不存在"报错，
-- 而后台又一直 best-effort 静默处理 → 表现为"额度永远不同步"。
-- 跑完这段后，发消息的用量才会真正累加进来。
-- ============================================

alter table public.profiles add column if not exists custom_system_prompt text default '';
alter table public.profiles add column if not exists tokens_5h bigint default 0;
alter table public.profiles add column if not exists window_5h_start timestamptz;
alter table public.profiles add column if not exists tokens_7d bigint default 0;
alter table public.profiles add column if not exists window_7d_start timestamptz;
alter table public.profiles add column if not exists quota_version bigint default 0;

-- 说明：window_5h_start / window_7d_start 故意不设 default now()。
-- 保持 NULL，代码会在"首条消息发出时"才把它赋成当前时间（首条消息起算倒计时）。

-- 自检：跑完后执行下面这句，应能看到这 6 列。
-- select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'profiles'
--   and column_name in
--   ('custom_system_prompt','tokens_5h','window_5h_start','tokens_7d','window_7d_start','quota_version');
