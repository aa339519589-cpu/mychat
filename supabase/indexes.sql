-- 性能索引：在 Supabase SQL Editor 中手动执行以优化查询性能

-- conversations 表索引：按用户和日期查询
create index if not exists idx_conversations_user_id on public.conversations(user_id);
create index if not exists idx_conversations_created_at on public.conversations(created_at desc);

-- messages 表索引：按会话查询
create index if not exists idx_messages_conversation_id on public.messages(conversation_id);
create index if not exists idx_messages_created_at on public.messages(created_at);

-- profiles 表索引：quota 窗口查询
create index if not exists idx_profiles_user_id on public.profiles(user_id);
create index if not exists idx_profiles_window_5h_start on public.profiles(window_5h_start);
create index if not exists idx_profiles_window_7d_start on public.profiles(window_7d_start);

-- invitation_codes 表索引：查找和兑换
create index if not exists idx_invitation_codes_code on public.invitation_codes(code);
create index if not exists idx_invitation_codes_created_by on public.invitation_codes(created_by);
create index if not exists idx_invitation_codes_used_by on public.invitation_codes(used_by);

-- memories 表索引（如存在）
create index if not exists idx_memories_user_id on public.memories(user_id) where memories.content is not null;
create index if not exists idx_memories_conversation_id on public.memories(conversation_id) where memories.content is not null;

-- projects 表索引
create index if not exists idx_projects_user_id on public.projects(user_id);
create index if not exists idx_projects_created_at on public.projects(created_at desc);
