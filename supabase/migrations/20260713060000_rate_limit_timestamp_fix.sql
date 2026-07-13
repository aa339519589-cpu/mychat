-- Repair the distributed rate-limit clock without rewriting the applied 0300
-- migration. In PL/pgSQL SQL statements, `current_time` is parsed as PostgreSQL's
-- timetz-valued CURRENT_TIME keyword instead of the similarly named local variable.
begin;

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
  v_now timestamptz := clock_timestamp();
  v_count integer;
  v_reset_at timestamptz;
begin
  if input_key_hash is null or input_key_hash !~ '^[0-9a-f]{64}$'
     or input_limit is null or input_limit < 1 or input_limit > 100000
     or input_window_ms is null or input_window_ms < 1000 or input_window_ms > 604800000 then
    raise exception 'invalid_rate_limit_input' using errcode = '22023';
  end if;

  if left(input_key_hash, 1) = '0' then
    delete from public.api_rate_limits as current_limits
    where current_limits.key_hash in (
      select stale_limits.key_hash
      from public.api_rate_limits as stale_limits
      where stale_limits.reset_at < v_now - interval '1 day'
      order by stale_limits.reset_at
      limit 256
    );
  end if;

  insert into public.api_rate_limits(key_hash, request_count, reset_at, updated_at)
  values (
    input_key_hash,
    1,
    v_now + input_window_ms * interval '1 millisecond',
    v_now
  )
  on conflict (key_hash) do update
  set
    request_count = case
      when public.api_rate_limits.reset_at <= v_now then 1
      else least(public.api_rate_limits.request_count + 1, input_limit + 1)
    end,
    reset_at = case
      when public.api_rate_limits.reset_at <= v_now
        then v_now + input_window_ms * interval '1 millisecond'
      else public.api_rate_limits.reset_at
    end,
    updated_at = v_now
  returning request_count, reset_at into v_count, v_reset_at;

  allowed := v_count <= input_limit;
  remaining := greatest(input_limit - v_count, 0);
  retry_after_seconds := case
    when allowed then 0
    else greatest(1, ceil(extract(epoch from (v_reset_at - v_now)))::integer)
  end;
  return next;
end;
$$;

comment on function public.consume_api_rate_limit(text, integer, integer)
  is 'mychat.rate_limit.contract.v2';

revoke all on function public.consume_api_rate_limit(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(text, integer, integer)
  to service_role;

-- Version readiness so a release cannot report healthy against the structurally
-- present but non-executable 0300 implementation.
create or replace function public.runtime_healthcheck_v3()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.runtime_healthcheck_v2()
    and coalesce(
      obj_description(
        to_regprocedure('public.consume_api_rate_limit(text,integer,integer)')::oid,
        'pg_proc'
      ),
      ''
    ) = 'mychat.rate_limit.contract.v2';
$$;

revoke all on function public.runtime_healthcheck_v3()
  from public, anon, authenticated;
grant execute on function public.runtime_healthcheck_v3()
  to service_role;

commit;
