-- Add 'pr' to agent_tasks.mode check constraint
-- The mode field was originally 'auto'/'confirm'/'plan' but we need 'pr' for PR-publish workflow

alter table public.agent_tasks
  drop constraint if exists agent_tasks_mode_check;

alter table public.agent_tasks
  add constraint agent_tasks_mode_check
  check (mode in ('auto', 'confirm', 'plan', 'pr'));
