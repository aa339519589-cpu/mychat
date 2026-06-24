-- ============================================
-- Migration: Agent Task Status 统一
-- 旧: pending / running / waiting_confirm / cancelled / failed / completed / paused
-- 新: queued / planning / indexing / reading / editing / running / testing / fixing
--      / reviewing / waiting_for_user / creating_pr / deploying / completed / failed / cancelled
-- 日期: 2026-06-24
-- 可重复执行，幂等
-- ============================================

-- Part 1: 旧数据映射
UPDATE public.agent_tasks SET status = 'queued'            WHERE status = 'pending';
UPDATE public.agent_tasks SET status = 'waiting_for_user'  WHERE status = 'waiting_confirm';
UPDATE public.agent_tasks SET status = 'waiting_for_user'  WHERE status = 'paused';

DO $$ BEGIN RAISE NOTICE 'Part 1 完成：旧状态已映射'; END $$;

-- Part 2: 更新 constraint
DO $$
DECLARE cname text;
BEGIN
    SELECT con.conname INTO cname FROM pg_constraint con
    JOIN pg_attribute attr ON attr.attrelid = con.conrelid AND attr.attnum = ANY(con.conkey)
    JOIN pg_class tbl ON tbl.oid = con.conrelid
    WHERE tbl.relname = 'agent_tasks' AND attr.attname = 'status' AND con.contype = 'c';

    IF cname IS NULL THEN
        RAISE NOTICE '未找到 agent_tasks.status constraint，跳过';
    ELSE
        RAISE NOTICE '找到 constraint: %', cname;
        EXECUTE format('ALTER TABLE public.agent_tasks DROP CONSTRAINT IF EXISTS %I', cname);
        EXECUTE format(
            'ALTER TABLE public.agent_tasks ADD CONSTRAINT %I CHECK (status IN (
                ''queued'', ''planning'', ''indexing'', ''reading'', ''editing'', ''running'',
                ''testing'', ''fixing'', ''reviewing'', ''waiting_for_user'', ''creating_pr'',
                ''deploying'', ''completed'', ''failed'', ''cancelled''
            ))',
            cname
        );
        RAISE NOTICE 'Part 2 完成：constraint 已更新';
    END IF;
END $$;
