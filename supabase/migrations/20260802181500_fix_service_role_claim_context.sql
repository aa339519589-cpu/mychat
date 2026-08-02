begin;

create or replace function public.assert_agent_confirmation_actor(input_user_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_authenticated_user uuid := auth.uid();
  v_legacy_claim_role text := nullif(current_setting('request.jwt.claim.role', true), '');
  v_claims jsonb;
  v_claim_role text;
begin
  if input_user_id is null then
    raise exception 'invalid_confirmation_actor' using errcode = '22023';
  end if;

  begin
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    v_claims := null;
  end;
  v_claim_role := coalesce(v_legacy_claim_role, nullif(v_claims->>'role', ''));

  if v_authenticated_user is not null then
    if v_authenticated_user is distinct from input_user_id then
      raise exception 'confirmation_actor_mismatch' using errcode = '42501';
    end if;
  elsif v_claim_role is distinct from 'service_role' then
    raise exception 'confirmation_actor_missing' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.assert_agent_confirmation_actor(uuid)
  from public, anon, authenticated, service_role;

commit;
