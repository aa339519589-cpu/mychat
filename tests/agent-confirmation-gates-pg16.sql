\set ON_ERROR_STOP on

insert into public.agent_tasks(id, user_id, status) values (
  '85000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  'running'
) on conflict (id) do update set status = excluded.status;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
set request.jwt.claim.role = 'authenticated';

do $$
declare
  created jsonb;
  resolved jsonb;
  consumed jsonb;
  second_consume jsonb;
  swapped jsonb;
  rejected jsonb;
  plan text := '{"baseBranch":"main","files":[".github/workflows/deploy.yml"],"head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","operation":"publish","payload":{"deployPages":true,"diffSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"repo":"owner/repo","taskId":"85000000-0000-4000-8000-000000000001","userId":"00000000-0000-4000-8000-000000000001","version":1,"workspaceBranch":"agent/task","workspaceStateSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}';
  swapped_plan text := '{"baseBranch":"main","files":[".github/workflows/deploy.yml"],"head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","operation":"publish","payload":{"deployPages":false,"diffSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"repo":"owner/repo","taskId":"85000000-0000-4000-8000-000000000001","userId":"00000000-0000-4000-8000-000000000001","version":1,"workspaceBranch":"agent/task","workspaceStateSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}';
begin
  if has_table_privilege('authenticated', 'public.agent_confirmation_gates', 'SELECT')
     or has_table_privilege('service_role', 'public.agent_confirmation_gates', 'SELECT') then
    raise exception 'confirmation token hashes have a direct table grant';
  end if;

  created := public.create_agent_confirmation_gate(
    '00000000-0000-4000-8000-000000000001',
    '85000000-0000-4000-8000-000000000001',
    'publish', 'high', 'Workflow publish', 'Touches workflow',
    array['.github/workflows/deploy.yml'], plan, repeat('a', 64),
    'running', 600
  );
  if created->>'status' <> 'pending'
     or created ? 'tokenHash'
     or created ? 'planCanonical'
     or (select status from public.agent_tasks
         where id = '85000000-0000-4000-8000-000000000001') <> 'waiting_for_user' then
    raise exception 'confirmation creation leaked a secret or missed task CAS: %', created;
  end if;

  begin
    perform public.resolve_agent_confirmation_gate(
      '00000000-0000-4000-8000-000000000001',
      '85000000-0000-4000-8000-000000000001',
      (created->>'id')::uuid, 'publish', repeat('a', 64),
      'CONFIRM', null
    );
    raise exception 'non-canonical action was accepted';
  exception when invalid_parameter_value then null;
  end;

  resolved := public.resolve_agent_confirmation_gate(
    '00000000-0000-4000-8000-000000000001',
    '85000000-0000-4000-8000-000000000001',
    (created->>'id')::uuid, 'publish', repeat('a', 64),
    'confirm', null
  );
  if resolved->>'status' <> 'approved'
     or (select status from public.agent_tasks
         where id = '85000000-0000-4000-8000-000000000001') <> 'running' then
    raise exception 'confirmation approval failed: %', resolved;
  end if;

  swapped := public.consume_agent_confirmation_gate(
    '00000000-0000-4000-8000-000000000001',
    '85000000-0000-4000-8000-000000000001',
    (created->>'id')::uuid, 'publish', swapped_plan, repeat('a', 64)
  );
  if swapped->>'reason' <> 'plan_mismatch' then
    raise exception 'plan swap was not rejected: %', swapped;
  end if;

  consumed := public.consume_agent_confirmation_gate(
    '00000000-0000-4000-8000-000000000001',
    '85000000-0000-4000-8000-000000000001',
    (created->>'id')::uuid, 'publish', plan, repeat('a', 64)
  );
  second_consume := public.consume_agent_confirmation_gate(
    '00000000-0000-4000-8000-000000000001',
    '85000000-0000-4000-8000-000000000001',
    (created->>'id')::uuid, 'publish', plan, repeat('a', 64)
  );
  if consumed->>'status' <> 'consumed'
     or second_consume->>'reason' <> 'already_consumed' then
    raise exception 'single-use consume CAS failed: first %, second %', consumed, second_consume;
  end if;

  created := public.create_agent_confirmation_gate(
    '00000000-0000-4000-8000-000000000001',
    '85000000-0000-4000-8000-000000000001',
    'publish', 'high', 'Workflow publish', 'Touches workflow',
    array['.github/workflows/deploy.yml'], plan, repeat('b', 64),
    'running', 600
  );
  rejected := public.resolve_agent_confirmation_gate(
    '00000000-0000-4000-8000-000000000001',
    '85000000-0000-4000-8000-000000000001',
    (created->>'id')::uuid, 'publish', repeat('b', 64),
    'reject', 'not intended'
  );
  if rejected->>'status' <> 'rejected' then
    raise exception 'atomic rejection failed: %', rejected;
  end if;
end;
$$;

reset request.jwt.claim.sub;
reset request.jwt.claim.role;
reset role;
