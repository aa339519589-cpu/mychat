-- ============================================
-- Migration: Step 6 数据库同步
-- 1. agent_workspaces.status 统一为: created, cloning, ready, dirty, failed, cleaned
-- 2. agent_tasks 新增 4 个 publish 相关列
-- 日期: 2026-06-24
-- 幂等，可重复执行
-- ============================================

-- Part 1: agent_workspaces.status constraint 更新

DO $$
DECLARE
    cname text;
BEGIN
    SELECT con.conname INTO cname
    FROM pg_constraint con
    JOIN pg_attribute attr ON attr.attrelid = con.conrelid AND attr.attnum = ANY(con.conkey)
    JOIN pg_class tbl ON tbl.oid = con.conrelid
    WHERE tbl.relname = 'agent_workspaces'
      AND attr.attname = 'status'
      AND con.contype = 'c';

    IF cname IS NULL THEN
        RAISE NOTICE '未找到 agent_workspaces.status 的 CHECK constraint，跳过';
    ELSE
        RAISE NOTICE '找到 constraint: %', cname;
        EXECUTE format('ALTER TABLE public.agent_workspaces DROP CONSTRAINT IF EXISTS %I', cname);
        EXECUTE format(
            'ALTER TABLE public.agent_workspaces ADD CONSTRAINT %I CHECK (status IN (
                ''created'', ''cloning'', ''ready'', ''dirty'', ''failed'', ''cleaned''
            ))',
            cname
        );
        RAISE NOTICE 'Part 1 完成：workspace status 支持 ready / dirty / failed / cleaned';
    END IF;
END $$;

-- Part 2: agent_tasks 新增 publish 列

ALTER TABLE public.agent_tasks ADD COLUMN IF NOT EXISTS agent_branch text;
ALTER TABLE public.agent_tasks ADD COLUMN IF NOT EXISTS pull_request_url text;
ALTER TABLE public.agent_tasks ADD COLUMN IF NOT EXISTS pull_request_number integer;
ALTER TABLE public.agent_tasks ADD COLUMN IF NOT EXISTS commit_sha text;

DO $$
BEGIN
    RAISE NOTICE 'Part 2 完成：agent_tasks 新增 agent_branch, pull_request_url, pull_request_number, commit_sha（如已存在则跳过）';
END $$;
