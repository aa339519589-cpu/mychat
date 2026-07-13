\set ON_ERROR_STOP on

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
set request.jwt.claim.role = 'authenticated';

do $$
declare
  v_result jsonb;
  v_plan text;
  v_gate jsonb;
  v_hash text;
begin
  if has_table_privilege('authenticated','public.agent_tasks','UPDATE')
     or has_table_privilege('authenticated','public.agent_workspaces','INSERT')
     or has_table_privilege('authenticated','public.agent_artifacts','DELETE') then
    raise exception 'browser role retained worker lifecycle mutation privileges';
  end if;

  v_result := public.enqueue_agent_task_job(
    '00000000-0000-4000-8000-000000000001',
    '89500000-0000-4000-8000-000000000001',
    'atomic task', 'owner/repo',
    '80600000-0000-4000-8000-000000000001',
    '89500000-0000-4000-8000-000000000002',
    '80700000-0000-4000-8000-000000000001',
    '89500000-0000-4000-8000-000000000003',
    'registered', 'agent-atomic-fixture', repeat('a',64),
    '{"schemaVersion":1,"tier":"正构","usingBalance":true}'::jsonb
  );
  if v_result->>'enqueued' <> 'true'
     or not exists (
       select 1 from public.agent_tasks task join public.jobs job
         on job.subject->>'taskId' = task.id::text
       where task.id='89500000-0000-4000-8000-000000000001'
         and job.id='89500000-0000-4000-8000-000000000003'
     ) then raise exception 'task and job were not atomically created: %', v_result; end if;

  v_hash := repeat('b',64);
  v_plan := jsonb_build_object(
    'version',1,'userId','00000000-0000-4000-8000-000000000001',
    'taskId','89500000-0000-4000-8000-000000000010','repo',null,
    'operation','publish','files',jsonb_build_array('README.md'),
    'baseBranch','main','workspaceBranch',null,'head',null,
    'workspaceStateSha256',v_hash,
    'payload',jsonb_build_object(
      'kind','initial_repository','operationInputSha256',v_hash
    )
  )::text;
  v_gate := public.create_agent_operation_confirmation(
    '00000000-0000-4000-8000-000000000001',
    '89500000-0000-4000-8000-000000000010','initial publish',
    v_plan,repeat('c',64),'Create repository','External GitHub side effect',array['README.md']
  );
  perform public.resolve_agent_confirmation_gate(
    '00000000-0000-4000-8000-000000000001',
    '89500000-0000-4000-8000-000000000010',(v_gate->>'id')::uuid,
    'publish',repeat('c',64),'confirm',null
  );
  v_result := public.enqueue_agent_operation(
    '00000000-0000-4000-8000-000000000001',
    '89500000-0000-4000-8000-000000000010',(v_gate->>'id')::uuid,
    'publish',v_plan,repeat('c',64),
    '89500000-0000-4000-8000-000000000011','registered',
    'agent-operation-fixture',repeat('d',64),
    jsonb_build_object(
      'schemaVersion',1,'kind','initial_repository',
      'taskId','89500000-0000-4000-8000-000000000010',
      'message','publish','actions',jsonb_build_array(jsonb_build_object('kind','create_repo','name','fixture')),
      'targetRepo',null,'deployPages',false,'snapshot',null,
      'operationHash',v_hash,
      'planHash',encode(digest(convert_to(v_plan,'UTF8'),'sha256'),'hex')
    ),null,null
  );
  if v_result->>'enqueued' <> 'true' then
    raise exception 'confirmed operation was not atomically bound: %', v_result;
  end if;
end;
$$;
reset role;

do $$
declare
  v_claim jsonb;
  v_result jsonb;
begin
  if (select confirmation_id from public.jobs where idempotency_key='agent-operation-fixture') is null then
    raise exception 'confirmed operation lacks durable confirmation binding';
  end if;
  v_claim := public.claim_next_job('authority-worker',array['agent'],120);
  if v_claim->'job'->>'id' = '89500000-0000-4000-8000-000000000011' then
    v_result := public.read_agent_operation_authority(
      '89500000-0000-4000-8000-000000000011','authority-worker',1
    );
    if v_result->>'ok' <> 'true' then raise exception 'operation fence authority unreadable: %', v_result; end if;
    perform public.finalize_job(
      '89500000-0000-4000-8000-000000000011','authority-worker',1,'cancelled','{}'::jsonb
    );
    v_claim := public.claim_next_job('authority-worker',array['agent'],120);
  end if;
  if v_claim->'job'->>'id' <> '89500000-0000-4000-8000-000000000003' then
    raise exception 'unexpected authority fixture claim: %', v_claim;
  end if;
  v_result := public.bind_agent_workspace_branch(
    '89500000-0000-4000-8000-000000000003','authority-worker',1,
    'agent/atomic-fixture'
  );
  if v_result->>'ok' <> 'true'
     or (select agent_branch from public.agent_tasks
         where id='89500000-0000-4000-8000-000000000001') <> 'agent/atomic-fixture' then
    raise exception 'workspace branch was not fenced and bound: %', v_result;
  end if;
  insert into public.agent_artifacts(
    id,task_id,user_id,kind,title,content,meta
  ) values (
    '89500000-0000-4000-8000-000000000020',
    '89500000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000001','summary',
    'snapshot:89500000-0000-4000-8000-000000000021',
    jsonb_build_object('format','cas-v1','manifest',jsonb_build_object(
      'snapshotId','89500000-0000-4000-8000-000000000021',
      'taskId','89500000-0000-4000-8000-000000000001',
      'userId','00000000-0000-4000-8000-000000000001',
      'reason','authority:fixture','manifestDigest',repeat('e',64),
      'treeDigest',repeat('f',64),'head',repeat('a',40)
    ))::text,'{}'::jsonb
  );
  v_result := public.advance_agent_workspace_head(
    '89500000-0000-4000-8000-000000000003','authority-worker',1,
    '89500000-0000-4000-8000-000000000021',repeat('e',64),repeat('f',64),repeat('a',40)
  );
  if v_result->>'ok' <> 'true'
     or (select version from public.agent_workspace_heads
         where task_id='89500000-0000-4000-8000-000000000001') <> 1 then
    raise exception 'workspace current-head did not advance: %', v_result;
  end if;

  update public.profiles set balance=100 where user_id='00000000-0000-4000-8000-000000000001';
  insert into public.ledger_entries(
    principal_id,job_id,idempotency_key,reason,direction,weighted_tokens,metadata
  ) values (
    '00000000-0000-4000-8000-000000000001','89500000-0000-4000-8000-000000000003',
    'balance-settlement-fixture','test','debit',30,'{"usingBalance":true}'
  ) on conflict (principal_id,idempotency_key) do nothing;
  insert into public.ledger_entries(
    principal_id,job_id,idempotency_key,reason,direction,weighted_tokens,metadata
  ) values (
    '00000000-0000-4000-8000-000000000001','89500000-0000-4000-8000-000000000003',
    'balance-settlement-fixture','test','debit',30,'{"usingBalance":true}'
  ) on conflict (principal_id,idempotency_key) do nothing;
  if (select balance from public.profiles where user_id='00000000-0000-4000-8000-000000000001') <> 70
     or (select count(*) from public.ledger_balance_settlements
         where principal_id='00000000-0000-4000-8000-000000000001') <> 1 then
    raise exception 'ledger balance settlement was not exactly once';
  end if;
end;
$$;
reset role;
