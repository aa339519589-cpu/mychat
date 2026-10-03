-- Sensitive memories require explicit account consent; turning consent off
-- atomically removes those rows. Reset removes global and project memories.
begin;

alter table public.profiles
  add column if not exists sensitive_memory_enabled boolean not null default false;

alter table public.memories
  add column if not exists sensitive boolean not null default false;

alter table public.project_memories
  add column if not exists sensitive boolean not null default false;

create or replace function public.guard_sensitive_memory_preference()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if coalesce(new.sensitive_memory_enabled, false)
     and current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'sensitive_memory_setting_requires_server_route' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_sensitive_memory_preference_guard on public.profiles;
create trigger profiles_sensitive_memory_preference_guard
before insert or update on public.profiles
for each row execute function public.guard_sensitive_memory_preference();

create or replace function public.guard_sensitive_memory_write()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  allowed boolean := false;
begin
  if not new.sensitive then return new; end if;

  select sensitive_memory_enabled into allowed
  from public.profiles
  where user_id = new.user_id
  for share;

  if not coalesce(allowed, false) then
    raise exception 'sensitive_memory_consent_required' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists memories_sensitive_consent_guard on public.memories;
create trigger memories_sensitive_consent_guard
before insert or update of sensitive, user_id on public.memories
for each row execute function public.guard_sensitive_memory_write();

drop trigger if exists project_memories_sensitive_consent_guard on public.project_memories;
create trigger project_memories_sensitive_consent_guard
before insert or update of sensitive, user_id on public.project_memories
for each row execute function public.guard_sensitive_memory_write();

create or replace function public.set_user_sensitive_memory_enabled(
  input_user_id uuid,
  input_enabled boolean
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  removed integer := 0;
  affected integer := 0;
begin
  if input_user_id is null or input_enabled is null then
    raise exception 'invalid_sensitive_memory_setting' using errcode = '22023';
  end if;

  insert into public.profiles(user_id, sensitive_memory_enabled)
    values (input_user_id, input_enabled)
  on conflict (user_id) do update
    set sensitive_memory_enabled = excluded.sensitive_memory_enabled;

  if not input_enabled then
    delete from public.memories where user_id = input_user_id and sensitive;
    get diagnostics affected = row_count;
    removed := removed + affected;

    delete from public.project_memories where user_id = input_user_id and sensitive;
    get diagnostics affected = row_count;
    removed := removed + affected;
  end if;

  return removed;
end;
$$;

create or replace function public.reset_user_memories(input_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  removed integer := 0;
  affected integer := 0;
begin
  if input_user_id is null then
    raise exception 'invalid_memory_reset_user' using errcode = '22023';
  end if;

  delete from public.memories where user_id = input_user_id;
  get diagnostics affected = row_count;
  removed := removed + affected;

  delete from public.project_memories where user_id = input_user_id;
  get diagnostics affected = row_count;
  removed := removed + affected;

  return removed;
end;
$$;

revoke all on function public.set_user_sensitive_memory_enabled(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.set_user_sensitive_memory_enabled(uuid, boolean)
  to service_role;

revoke all on function public.reset_user_memories(uuid)
  from public, anon, authenticated;
grant execute on function public.reset_user_memories(uuid)
  to service_role;

revoke all on function public.guard_sensitive_memory_preference()
  from public, anon, authenticated;
revoke all on function public.guard_sensitive_memory_write()
  from public, anon, authenticated;

commit;
