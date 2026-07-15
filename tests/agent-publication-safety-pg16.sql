\set ON_ERROR_STOP on

do $$
begin
  begin
    insert into public.jobs(
      id, type, queue, principal_id, auth_class, subject,
      idempotency_key, input_hash, payload, budget
    ) values (
      '89700000-0000-4000-8000-000000000001', 'agent.operation', 'agent',
      '00000000-0000-4000-8000-000000000001', 'registered',
      '{"taskId":"80500000-0000-4000-8000-000000000001"}'::jsonb,
      'unsafe-path-fixture', repeat('1', 64),
      '{"kind":"initial_repository","actions":[{"kind":"write_file","path":".env","newContent":"SAFE=value"}]}'::jsonb,
      '{}'::jsonb
    );
    raise exception 'sensitive path reached the job control plane';
  exception when check_violation then
    if sqlerrm <> 'agent_operation_sensitive_path' then raise; end if;
  end;

  begin
    insert into public.jobs(
      id, type, queue, principal_id, auth_class, subject,
      idempotency_key, input_hash, payload, budget
    ) values (
      '89700000-0000-4000-8000-000000000002', 'agent.operation', 'agent',
      '00000000-0000-4000-8000-000000000001', 'registered',
      '{"taskId":"80500000-0000-4000-8000-000000000001"}'::jsonb,
      'unsafe-content-fixture', repeat('2', 64),
      '{"kind":"initial_repository","actions":[{"kind":"write_file","path":"config.ts","newContent":"const key = ''sk-abcdefghijklmnopqrstuvwxyz123456''"}]}'::jsonb,
      '{}'::jsonb
    );
    raise exception 'secret content reached the job control plane';
  exception when check_violation then
    if sqlerrm <> 'agent_operation_secret_content' then raise; end if;
  end;
end;
$$;

set role authenticated;
do $$
begin
  if has_function_privilege(
    'authenticated', 'public.enforce_agent_operation_publication_safety()', 'EXECUTE'
  ) then
    raise exception 'browser can invoke publication safety trigger directly';
  end if;
end;
$$;
reset role;
