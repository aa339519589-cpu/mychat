-- 项目级记忆：与 user_memories（全局）完全分隔，按 project_id 隔离
-- 在 Supabase SQL Editor 里执行一次即可

CREATE TABLE IF NOT EXISTS public.project_memories (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content text NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.project_memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users manage own project memories"
  ON public.project_memories FOR ALL
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS project_memories_project_id_idx ON public.project_memories(project_id);
CREATE INDEX IF NOT EXISTS project_memories_user_id_idx ON public.project_memories(user_id);
