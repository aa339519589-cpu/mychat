\set ON_ERROR_STOP on
insert into auth.users(id) values ('91000000-0000-4000-8000-000000000001'),('91000000-0000-4000-8000-000000000002');
insert into public.mcp_connectors(id,user_id,name,server_url,credential_ciphertext,auth_type,oauth_status,enabled)
values ('92000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001','oauth test','https://mcp.example.com','sealed','oauth','connected',true);

do $$ declare lease jsonb; begin
  if public.claim_connector_oauth_refresh('91000000-0000-4000-8000-000000000002','92000000-0000-4000-8000-000000000001',gen_random_uuid()) is not null then
    raise exception 'oauth refresh crossed tenant boundary'; end if;
  lease := public.claim_connector_oauth_refresh('91000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001',gen_random_uuid());
  if lease->>'ciphertext' <> 'sealed' then raise exception 'refresh claim did not return credential'; end if;
  if public.claim_connector_oauth_refresh('91000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001',gen_random_uuid()) is not null then
    raise exception 'concurrent refresh was admitted'; end if;
  if has_table_privilege('authenticated','public.mcp_oauth_sessions','SELECT')
     or has_function_privilege('anon','public.claim_connector_oauth_refresh(uuid,uuid,uuid)','EXECUTE') then
    raise exception 'oauth storage grants are not service-only'; end if;
end; $$;

insert into public.mcp_oauth_sessions(state_hash,user_id,connector_id,server_url,secret_ciphertext,expires_at)
values (repeat('a',64),'91000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001','https://mcp.example.com','encrypted PKCE',now()+interval '10 minutes');
do $$ declare first_claim integer; second_claim integer; begin
  with claimed as (delete from public.mcp_oauth_sessions where state_hash=repeat('a',64) and expires_at>now() returning *)
    select count(*) into first_claim from claimed;
  with claimed as (delete from public.mcp_oauth_sessions where state_hash=repeat('a',64) and expires_at>now() returning *)
    select count(*) into second_claim from claimed;
  if first_claim <> 1 or second_claim <> 0 then raise exception 'callback state replay accepted'; end if;
end; $$;

insert into public.profiles(user_id,sensitive_memory_enabled) values ('91000000-0000-4000-8000-000000000001',true);
-- Exercise the trigger as an ordinary authenticated role in a rollback-only
-- fixture. Granting update here does not change deployed table grants.
begin;
grant usage on schema public,auth to authenticated;
grant select,update on public.profiles to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub','91000000-0000-4000-8000-000000000001',true);
update public.profiles set sensitive_memory_enabled=sensitive_memory_enabled where user_id='91000000-0000-4000-8000-000000000001';
do $$ begin
  begin
    update public.profiles set sensitive_memory_enabled=false where user_id='91000000-0000-4000-8000-000000000001';
    raise exception 'direct sensitive preference change was accepted';
  exception when insufficient_privilege then null; end;
end; $$;
rollback;
