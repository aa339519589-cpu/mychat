-- 邀请码表：可兑换额度
create table if not exists public.invitation_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  tokens bigint not null default 20_000_000,
  created_by uuid references auth.users(id) on delete set null,
  used_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
alter table public.invitation_codes enable row level security;
create policy "codes_read" on public.invitation_codes for select using (true);
create policy "codes_redeem" on public.invitation_codes for update
  using (used_by is null) with check (auth.uid() is not null);

-- profiles 加余额字段
alter table public.profiles add column if not exists balance bigint default 0;

-- 自检
select column_name from information_schema.columns
  where table_schema = 'public' and table_name = 'invitation_codes'
  order by ordinal_position;
