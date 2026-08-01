begin;

create table public.medium_model_trial_calls (
  principal_id uuid not null,
  generation_id uuid not null,
  model_id text not null check (
    length(model_id) between 3 and 160
    and model_id ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._:-]+$'
  ),
  created_at timestamptz not null default clock_timestamp(),
  primary key (principal_id, generation_id)
);

create index medium_model_trial_calls_principal_created_idx
  on public.medium_model_trial_calls(principal_id, created_at);

alter table public.medium_model_trial_calls enable row level security;
revoke all on table public.medium_model_trial_calls from public, anon, authenticated;
grant select, insert, delete on table public.medium_model_trial_calls to service_role;

create or replace function public.reserve_medium_model_trial(
  input_principal_id uuid,
  input_generation_id uuid,
  input_model_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $$
declare
  v_used integer;
begin
  if input_principal_id is null or input_generation_id is null
     or length(coalesce(input_model_id, '')) not between 3 and 160
     or input_model_id !~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._:-]+$'
     or auth.uid() is distinct from input_principal_id then
    raise exception 'medium_model_trial_forbidden' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(input_principal_id::text, 9401));

  if exists (
    select 1 from public.medium_model_trial_calls
    where principal_id = input_principal_id
      and generation_id = input_generation_id
  ) then
    select count(*)::integer into v_used
    from public.medium_model_trial_calls
    where principal_id = input_principal_id;
    return jsonb_build_object(
      'allowed', true,
      'duplicate', true,
      'used', v_used,
      'remaining', greatest(0, 3 - v_used)
    );
  end if;

  select count(*)::integer into v_used
  from public.medium_model_trial_calls
  where principal_id = input_principal_id;

  if v_used >= 3 then
    return jsonb_build_object(
      'allowed', false,
      'duplicate', false,
      'used', v_used,
      'remaining', 0
    );
  end if;

  insert into public.medium_model_trial_calls(
    principal_id, generation_id, model_id
  ) values (
    input_principal_id, input_generation_id, input_model_id
  );

  return jsonb_build_object(
    'allowed', true,
    'duplicate', false,
    'used', v_used + 1,
    'remaining', greatest(0, 2 - v_used)
  );
end;
$$;

revoke all on function public.reserve_medium_model_trial(uuid,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.reserve_medium_model_trial(uuid,uuid,text)
  to authenticated;

create or replace function public.release_medium_model_trial(
  input_principal_id uuid,
  input_generation_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $$
begin
  if input_principal_id is null or input_generation_id is null
     or auth.uid() is distinct from input_principal_id then
    raise exception 'medium_model_trial_forbidden' using errcode = '42501';
  end if;
  delete from public.medium_model_trial_calls
  where principal_id = input_principal_id
    and generation_id = input_generation_id;
  return found;
end;
$$;

revoke all on function public.release_medium_model_trial(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.release_medium_model_trial(uuid,uuid)
  to authenticated;

commit;
