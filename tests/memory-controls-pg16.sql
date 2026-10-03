\set ON_ERROR_STOP on

insert into auth.users(id) values
  ('81000000-0000-4000-8000-000000000001'),
  ('81000000-0000-4000-8000-000000000002');
insert into public.profiles(user_id, memory_enabled, sensitive_memory_enabled) values
  ('81000000-0000-4000-8000-000000000001', true, true),
  ('81000000-0000-4000-8000-000000000002', true, false);
insert into public.projects(id, user_id, name) values
  ('82000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', 'Memory control test');
insert into public.memories(id, user_id, content, sensitive) values
  ('83000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', 'ordinary global', false),
  ('83000000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000001', 'sensitive global', true),
  ('83000000-0000-4000-8000-000000000003', '81000000-0000-4000-8000-000000000002', 'other account', false);
insert into public.project_memories(id, user_id, project_id, content, sensitive) values
  ('84000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001', 'ordinary project', false),
  ('84000000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001', 'sensitive project', true);

do $$
declare
  removed integer;
begin
  removed := public.set_user_sensitive_memory_enabled(
    '81000000-0000-4000-8000-000000000001', false
  );
  if removed <> 2 then raise exception 'sensitive opt-out deleted %, expected 2', removed; end if;
  if exists (select 1 from public.memories where id='83000000-0000-4000-8000-000000000002')
     or exists (select 1 from public.project_memories where id='84000000-0000-4000-8000-000000000002') then
    raise exception 'sensitive opt-out left sensitive rows behind';
  end if;
  if (select sensitive_memory_enabled from public.profiles
      where user_id='81000000-0000-4000-8000-000000000001') then
    raise exception 'sensitive opt-out did not persist';
  end if;

  begin
    insert into public.memories(user_id, content, sensitive)
    values ('81000000-0000-4000-8000-000000000001', 'rejected sensitive', true);
    raise exception 'sensitive insert succeeded without consent';
  exception when insufficient_privilege then
    null;
  end;

  removed := public.reset_user_memories('81000000-0000-4000-8000-000000000001');
  if removed <> 2 then raise exception 'memory reset deleted %, expected 2', removed; end if;
  if exists (select 1 from public.memories where user_id='81000000-0000-4000-8000-000000000001')
     or exists (select 1 from public.project_memories where user_id='81000000-0000-4000-8000-000000000001') then
    raise exception 'memory reset left rows behind';
  end if;
  if not exists (select 1 from public.memories where id='83000000-0000-4000-8000-000000000003') then
    raise exception 'memory reset crossed an account boundary';
  end if;
  if not (select memory_enabled from public.profiles
          where user_id='81000000-0000-4000-8000-000000000001') then
    raise exception 'memory reset changed the pause setting';
  end if;
end;
$$;

do $$
begin
  if not has_function_privilege('service_role', 'public.reset_user_memories(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.reset_user_memories(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.reset_user_memories(uuid)', 'EXECUTE') then
    raise exception 'memory reset function has invalid grants';
  end if;
  if not has_function_privilege('service_role', 'public.set_user_sensitive_memory_enabled(uuid,boolean)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.set_user_sensitive_memory_enabled(uuid,boolean)', 'EXECUTE')
     or has_function_privilege('anon', 'public.set_user_sensitive_memory_enabled(uuid,boolean)', 'EXECUTE') then
    raise exception 'sensitive preference function has invalid grants';
  end if;
end;
$$;
