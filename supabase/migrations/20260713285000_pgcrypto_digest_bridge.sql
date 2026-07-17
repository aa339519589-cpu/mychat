-- Supabase installs pgcrypto in the protected extensions schema, while older
-- functions resolve digest through their fixed public search path. Preserve the
-- narrow bytea/text contract without exposing extension execution to browsers.
begin;

do $$
begin
  if to_regprocedure('public.digest(bytea,text)') is null then
    execute $function$
      create function public.digest(input bytea, algorithm text)
      returns bytea
      language sql
      immutable
      strict
      parallel safe
      set search_path = pg_catalog, extensions, pg_temp
      as 'select extensions.digest(input, algorithm)'
    $function$;
  end if;
end;
$$;

revoke all on function public.digest(bytea,text)
  from public, anon, authenticated;
grant execute on function public.digest(bytea,text)
  to service_role;

comment on function public.digest(bytea,text) is
  'Service-only compatibility bridge to extensions.digest for fixed-search-path functions.';

commit;
