-- Multi-instance runtime primitives: atomic API rate limits and durable cancellation.

create table if not exists public.api_rate_limits (
  key_hash text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
  request_count integer not null check (request_count > 0),
  reset_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.api_rate_limits enable row level security;
revoke all on table public.api_rate_limits from public, anon, authenticated;
create index if not exists api_rate_limits_reset_at_idx
  on public.api_rate_limits(reset_at);

-- The function is callable only with the server-side service role. A fixed-window
-- upsert makes the counter atomic across all application instances.
create or replace function public.consume_api_rate_limit(
  input_key_hash text,
  input_limit integer,
  input_window_ms integer
)
returns table(allowed boolean, remaining integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_time timestamptz := clock_timestamp();
  current_count integer;
  current_reset_at timestamptz;
begin
  if input_key_hash is null or input_key_hash !~ '^[0-9a-f]{64}$'
     or input_limit is null or input_limit < 1 or input_limit > 100000
     or input_window_ms is null or input_window_ms < 1000 or input_window_ms > 604800000 then
    raise exception 'invalid_rate_limit_input' using errcode = '22023';
  end if;

  -- Amortized bounded cleanup keeps one-off identities from growing this table
  -- forever without adding a timer or requiring a database extension.
  if left(input_key_hash, 1) = '0' then
    delete from public.api_rate_limits as current_limits
    where current_limits.key_hash in (
      select stale_limits.key_hash
      from public.api_rate_limits as stale_limits
      where stale_limits.reset_at < current_time - interval '1 day'
      order by stale_limits.reset_at
      limit 256
    );
  end if;

  insert into public.api_rate_limits(key_hash, request_count, reset_at, updated_at)
  values (
    input_key_hash,
    1,
    current_time + input_window_ms * interval '1 millisecond',
    current_time
  )
  on conflict (key_hash) do update
  set
    request_count = case
      when public.api_rate_limits.reset_at <= current_time then 1
      else least(public.api_rate_limits.request_count + 1, input_limit + 1)
    end,
    reset_at = case
      when public.api_rate_limits.reset_at <= current_time
        then current_time + input_window_ms * interval '1 millisecond'
      else public.api_rate_limits.reset_at
    end,
    updated_at = current_time
  returning request_count, reset_at into current_count, current_reset_at;

  allowed := current_count <= input_limit;
  remaining := greatest(input_limit - current_count, 0);
  retry_after_seconds := case
    when allowed then 0
    else greatest(1, ceil(extract(epoch from (current_reset_at - current_time)))::integer)
  end;
  return next;
end;
$$;

revoke all on function public.consume_api_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(text, integer, integer) to service_role;

alter table public.chat_generations
  add column if not exists cancel_requested_at timestamptz;

-- Once a terminal state wins, delayed snapshots from another instance cannot
-- accidentally resurrect the task. In particular, cancellation always wins over
-- a concurrent `running`/`completed` persistence write from the active runner.
create or replace function public.preserve_chat_generation_terminal_status()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.sequence < old.sequence then
    new.sequence := old.sequence;
    new.content := old.content;
    new.thinking := old.thinking;
    new.error := coalesce(new.error, old.error);
  end if;
  if old.status = 'cancelled' then
    new.status := 'cancelled';
    new.cancel_requested_at := coalesce(old.cancel_requested_at, new.cancel_requested_at, now());
  elsif old.status in ('completed', 'failed') and new.status <> old.status then
    new.status := old.status;
  elsif new.status = 'cancelled' and new.cancel_requested_at is null then
    new.cancel_requested_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists preserve_chat_generation_terminal_status on public.chat_generations;
create trigger preserve_chat_generation_terminal_status
before update on public.chat_generations
for each row execute function public.preserve_chat_generation_terminal_status();

-- Define readiness last so a partially applied migration can never report ready.
-- The probe covers every primitive required by the multi-instance runtime.
create or replace function public.runtime_healthcheck()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    to_regclass('public.api_rate_limits') is not null
    and to_regprocedure('public.consume_api_rate_limit(text,integer,integer)') is not null
    and has_function_privilege(
      'service_role',
      'public.consume_api_rate_limit(text,integer,integer)',
      'EXECUTE'
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'chat_generations'
        and column_name = 'cancel_requested_at'
    )
    and exists (
      select 1
      from pg_catalog.pg_trigger
      where tgname = 'preserve_chat_generation_terminal_status'
        and tgrelid = 'public.chat_generations'::regclass
        and not tgisinternal
    );
$$;

revoke all on function public.runtime_healthcheck() from public, anon, authenticated;
grant execute on function public.runtime_healthcheck() to service_role;
