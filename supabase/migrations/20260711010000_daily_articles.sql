create table if not exists public.articles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  brief_date date not null,
  position smallint not null check (position between 1 and 5),
  category text not null,
  title text not null,
  dek text not null,
  body text not null,
  read_minutes smallint not null check (read_minutes between 1 and 30),
  cover_variant smallint not null default 1 check (cover_variant between 1 and 5),
  cover_image_url text,
  created_at timestamptz not null default now(),
  unique (user_id, brief_date, position)
);

create index if not exists articles_user_date_idx on public.articles(user_id, brief_date desc, position);
alter table public.articles enable row level security;
drop policy if exists "articles_select_own" on public.articles;
create policy "articles_select_own" on public.articles for select using (auth.uid() = user_id);
drop policy if exists "articles_insert_own" on public.articles;
create policy "articles_insert_own" on public.articles for insert with check (auth.uid() = user_id);
comment on table public.articles is 'Personalized English daily reading brief generated from recent interest signals.';
