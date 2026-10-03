do $$
begin
  if not public.verify_schema_contract_v9(
    9,
    '2692c458d54feeaa330fb2e33ba2bda4429efc0104a5e78eea1b3df131bee97d',
    59
  ) then
    raise exception 'remote MCP connector schema contract verification failed';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'mcp_connectors'
      and roles && array['anon', 'authenticated']::name[]
  ) then
    raise exception 'remote MCP connector storage must not have browser-role policies';
  end if;

  if has_table_privilege('anon', 'public.mcp_connectors', 'SELECT')
     or has_table_privilege('authenticated', 'public.mcp_connectors', 'SELECT') then
    raise exception 'remote MCP credential ciphertext is exposed to a browser role';
  end if;
end;
$$;
