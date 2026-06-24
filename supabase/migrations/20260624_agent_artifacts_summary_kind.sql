-- ============================================
-- Migration: agent_artifacts.kind 新增 'summary'
-- 日期: 2026-06-24
-- 用途: 兼容 P0 Step 5.5 snapshot 持久化
-- ============================================
--
-- 背景：
--   建表 SQL（agent-tasks.sql）已将 kind check constraint 更新为包含 'summary'，
--   但已有数据库仍使用旧 constraint（不含 'summary'），导致 snapshot artifact 写入失败。
--
-- 执行方式：
--   在 Supabase Dashboard → SQL Editor 中粘贴运行。
--   或通过 psql / supabase CLI 执行。
--   幂等：重复执行不会报错。
--
--   不会影响已有数据。
--   不会重建表。
--   不会删除数据。

-- Step 1: 找到当前 constraint 名称
-- PostgreSQL 内联 CHECK 约束自动命名为 {table}_{col}_check
-- 但为了安全，我们从系统表查实际名称

DO $$
DECLARE
    constraint_name text;
BEGIN
    -- 查找 agent_artifacts.kind 列的 CHECK 约束
    SELECT con.conname INTO constraint_name
    FROM pg_constraint con
    JOIN pg_attribute attr ON attr.attrelid = con.conrelid AND attr.attnum = ANY(con.conkey)
    JOIN pg_class tbl ON tbl.oid = con.conrelid
    WHERE tbl.relname = 'agent_artifacts'
      AND attr.attname = 'kind'
      AND con.contype = 'c';

    -- 如果没找到约束，说明可能用的是 domain 或其他方式，跳过
    IF constraint_name IS NULL THEN
        RAISE NOTICE '未找到 agent_artifacts.kind 的 CHECK constraint，跳过迁移';
        RETURN;
    END IF;

    RAISE NOTICE '找到 constraint: %', constraint_name;

    -- Step 2: Drop 旧 constraint
    EXECUTE format('ALTER TABLE public.agent_artifacts DROP CONSTRAINT IF EXISTS %I', constraint_name);

    -- Step 3: Add 新 constraint（含 summary + 未来扩展）
    EXECUTE format(
        'ALTER TABLE public.agent_artifacts ADD CONSTRAINT %I CHECK (kind IN (
            ''diff'', ''log'', ''screenshot'', ''build_report'', ''test_report'', ''deploy_link'', ''pr_link'', ''pr'', ''deploy'', ''file'', ''summary'', ''other''
        ))',
        constraint_name
    );

    RAISE NOTICE 'Migration 完成：agent_artifacts.kind 现在支持 summary / build_report / test_report / deploy_link / pr_link';
END $$;
