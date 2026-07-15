-- Defense in depth for the one initial-repository path that publishes file
-- content directly. API, plan construction, and Worker all apply the same
-- policy; this trigger prevents a privileged caller from bypassing them.
begin;

create or replace function public.enforce_agent_operation_publication_safety()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  action jsonb;
  action_path text;
  action_content text;
begin
  if new.type <> 'agent.operation'
     or new.payload->>'kind' <> 'initial_repository' then
    return new;
  end if;
  if jsonb_typeof(new.payload->'actions') <> 'array'
     or jsonb_array_length(new.payload->'actions') not between 1 and 22 then
    raise exception 'agent_operation_actions_invalid' using errcode = '23514';
  end if;

  for action in select value from jsonb_array_elements(new.payload->'actions') loop
    if action->>'kind' not in ('write_file', 'delete_file', 'create_repo', 'enable_pages') then
      raise exception 'agent_operation_action_invalid' using errcode = '23514';
    end if;
    if action->>'kind' in ('write_file', 'delete_file') then
      action_path := action->>'path';
      if coalesce(action_path, '') = ''
         or length(action_path) > 500
         or action_path ~ '[\\[:cntrl:]]'
         or action_path ~ '(^|/)\.\.(/|$)'
         or action_path ~* '(^|/)\.git(/|$)'
         or action_path ~* '(^|/)\.env(?:\..*)?$'
         or action_path ~* '\.(?:pem|key|p12|pfx|jks|keystore|secret)$'
         or action_path ~* '(^|/)(?:credentials\.(?:json|ya?ml)|id_(?:rsa|ed25519|ecdsa))$'
         or action_path ~* 'private[_-]?key' then
        raise exception 'agent_operation_sensitive_path' using errcode = '23514';
      end if;
    end if;
    if action->>'kind' = 'write_file' then
      action_content := action->>'newContent';
      if action_content is null or octet_length(action_content) > 700000
         or action_content ~ '-----BEGIN(?: RSA| EC| DSA| OPENSSH)? PRIVATE KEY-----'
         or action_content ~ 'sk-[A-Za-z0-9]{20,}'
         or action_content ~ 'gh[po]_[A-Za-z0-9]{36}'
         or action_content ~* 'Authorization[[:space:]]*[:=][[:space:]]*Bearer[[:space:]]+[^[:space:]]+'
         or action_content ~* '(password|secret)[[:space:]]*[:=][[:space:]]*["''][^"'']{4,}["'']'
         or action_content ~* 'token[[:space:]]*[:=][[:space:]]*["''][^"'']{8,}["'']' then
        raise exception 'agent_operation_secret_content' using errcode = '23514';
      end if;
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function public.enforce_agent_operation_publication_safety()
  from public, anon, authenticated, service_role;

drop trigger if exists enforce_agent_operation_publication_safety on public.jobs;
create trigger enforce_agent_operation_publication_safety
before insert or update of type, payload on public.jobs
for each row execute function public.enforce_agent_operation_publication_safety();

commit;
