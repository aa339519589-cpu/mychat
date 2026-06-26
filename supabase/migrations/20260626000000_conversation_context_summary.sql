alter table public.conversations
  add column if not exists context_summary text,
  add column if not exists summary_until_message_id uuid references public.messages(id) on delete set null,
  add column if not exists summary_token_count integer not null default 0;

comment on column public.conversations.context_summary is 'Hidden recursive summary for this conversation only. Not Memory, not Project memory, not shown in UI.';
comment on column public.conversations.summary_until_message_id is 'Last message folded into context_summary. Messages after this remain eligible for future folding.';
comment on column public.conversations.summary_token_count is 'Rough estimated token count of context_summary, not billing data.';
