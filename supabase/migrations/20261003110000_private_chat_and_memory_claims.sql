-- Private streams retain billing metadata only; first-turn memory uses modern JWT claims.
begin;
create or replace function public.guard_conversation_memory_setting()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.memory_enabled is distinct from old.memory_enabled
    and coalesce(nullif(current_setting('request.jwt.claim.role',true),''),
      nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','') <> 'service_role'
    and exists(select 1 from public.messages where conversation_id=old.id and role='user') then
    raise exception 'conversation_memory_setting_locked' using errcode='55000';
  end if;
  return new;
end; $$;
revoke all on function public.guard_conversation_memory_setting() from public,anon,authenticated,service_role;

create or replace function public.reserve_job_admission()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sku text;
  v_price public.job_price_catalog%rowtype;
  v_funding text := 'quota';
  v_billing_class text := coalesce(new.payload->>'billingClass', 'platform');
  v_reserve_tokens bigint := 0;
  v_reserve_cost_micros bigint := 0;
  v_raw_limit bigint;
  v_balance bigint := 0;
  v_tokens_5h bigint := 0;
  v_tokens_7d bigint := 0;
  v_held_tokens bigint := 0;
  v_limit_5h bigint := 500000;
  v_limit_7d bigint := 10000000;
  v_wall_time_ms bigint := 3600000;
  v_now timestamptz := clock_timestamp();
  v_quote jsonb;
  v_quote_hash text;
  v_reconciliation_ready boolean := false;
begin
  new.billing_contract_version := 2;
  v_sku := case
    when new.type = 'chat.generation' and new.payload->>'outputKind' = 'image' then 'media.image'
    when new.type = 'chat.generation' and new.payload->>'outputKind' = 'video' then 'media.video'
    when new.type in ('chat.generation', 'chat.private') then 'chat.text'
    when new.type = 'chat.title' then 'chat.title'
    when new.type = 'agent.task' then 'agent.task'
    when new.type = 'agent.operation' then 'agent.operation'
    else 'internal.default'
  end;

  select catalog.* into strict v_price
  from public.job_price_activation_heads as head
  join public.job_price_activations as activation
    on activation.sku = head.sku
   and activation.price_version = head.price_version
   and activation.activation_generation = head.activation_generation
  join public.job_price_catalog as catalog
    on catalog.sku = head.sku and catalog.version = head.price_version
  where head.sku = v_sku
  for key share of catalog;

  select snapshot.healthy
    and snapshot.generated_at >= v_now - interval '10 minutes'
  into v_reconciliation_ready
  from public.billing_reconciliation_snapshots as snapshot
  where snapshot.singleton;
  if not coalesce(v_reconciliation_ready, false) then
    raise exception 'billing_reconciliation_unhealthy'
      using errcode = '55000',
            detail = 'New paid work is disabled until the authoritative balance snapshot reconciles.';
  end if;

  if v_price.raw_token_cap is not null then
    if coalesce(new.budget->>'tokenLimit', '') ~ '^[0-9]{1,13}$' then
      v_raw_limit := least((new.budget->>'tokenLimit')::bigint, v_price.raw_token_cap);
    else
      v_raw_limit := v_price.raw_token_cap;
    end if;
    new.budget := jsonb_set(new.budget, '{tokenLimit}', to_jsonb(v_raw_limit), true);
    v_reserve_tokens := greatest(
      v_price.default_reserve_tokens,
      (v_raw_limit * v_price.token_multiplier_millis + 999) / 1000
    );
  else
    v_reserve_tokens := v_price.default_reserve_tokens;
  end if;
  v_reserve_cost_micros := v_price.reserve_cost_micros;

  if v_billing_class = 'customer' then
    v_funding := 'customer';
    v_reserve_tokens := 0;
    v_reserve_cost_micros := 0;
  elsif v_billing_class <> 'platform' then
    raise exception 'invalid_job_billing_class' using errcode = '22023';
  end if;

  insert into public.profiles(user_id, balance)
  values (new.principal_id, 0)
  on conflict (user_id) do nothing;
  select greatest(coalesce(balance, 0), 0)::bigint,
         greatest(coalesce(limit_5h, 500000), 0)::bigint,
         greatest(coalesce(limit_week, 10000000), 0)::bigint
  into v_balance, v_limit_5h, v_limit_7d
  from public.profiles where user_id = new.principal_id for update;

  if v_funding <> 'customer' and v_reserve_tokens > 0 then
    select
      greatest(coalesce(sum(case when created_at >= v_now - interval '5 hours'
        then case direction when 'debit' then weighted_tokens else -weighted_tokens end
        else 0 end), 0), 0)::bigint,
      greatest(coalesce(sum(case when created_at >= v_now - interval '7 days'
        then case direction when 'debit' then weighted_tokens else -weighted_tokens end
        else 0 end), 0), 0)::bigint
    into v_tokens_5h, v_tokens_7d
    from public.ledger_entries where principal_id = new.principal_id;
    select coalesce(sum(reserved_tokens), 0)::bigint into v_held_tokens
    from public.job_admission_reservations
    where principal_id = new.principal_id and status = 'held' and funding = 'quota';

    if v_tokens_5h + v_held_tokens + v_reserve_tokens > v_limit_5h
       or v_tokens_7d + v_held_tokens + v_reserve_tokens > v_limit_7d then
      v_funding := 'balance';
      if v_balance < v_reserve_tokens then
        raise exception 'insufficient_job_credit'
          using errcode = 'P0001',
                detail = 'Atomic admission requires the full maximum-cost reservation.';
      end if;
      perform set_config('mychat.balance_source', 'job.admission.hold', true);
      update public.profiles set
        balance = v_balance - v_reserve_tokens,
        quota_version = coalesce(quota_version, 0) + 1
      where user_id = new.principal_id;
    end if;
  end if;

  if coalesce(new.budget->>'wallTimeMs', '') ~ '^[0-9]{1,13}$' then
    v_wall_time_ms := least((new.budget->>'wallTimeMs')::bigint, 86400000);
  end if;
  v_quote := public.build_job_price_quote_v2(
    v_sku, v_price.version, v_price.default_reserve_tokens,
    v_price.raw_token_cap, v_price.token_multiplier_millis,
    v_price.reserve_cost_micros, v_price.currency, v_funding,
    v_billing_class, v_reserve_tokens, v_reserve_cost_micros
  );
  v_quote_hash := public.job_price_quote_hash(v_quote);

  insert into public.job_admission_reservations(
    job_id, principal_id, sku, price_version, funding, status,
    reserved_tokens, reserved_cost_micros, price_quote, price_quote_hash,
    created_at, expires_at
  ) values (
    new.id, new.principal_id, v_sku, v_price.version, v_funding, 'held',
    v_reserve_tokens, v_reserve_cost_micros, v_quote, v_quote_hash, v_now,
    v_now + make_interval(secs => ((v_wall_time_ms + 3600000) / 1000)::double precision)
  );
  if v_funding = 'balance' then
    insert into public.job_balance_movements(
      job_id, principal_id, kind, tokens, created_at
    ) values (new.id, new.principal_id, 'hold', v_reserve_tokens, v_now);
  end if;

  new.payload := new.payload || jsonb_build_object('admission', jsonb_build_object(
    'schemaVersion', 2,
    'billingContractVersion', 2,
    'funding', v_funding,
    'sku', v_sku,
    'priceVersion', v_price.version,
    'reservedTokens', v_reserve_tokens,
    'reservedCostMicros', v_reserve_cost_micros,
    'quoteHash', v_quote_hash
  ));
  return new;
end;
$$;

create or replace function public.guard_private_job_metadata()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.type='chat.private' and new.cancel_reason is not null then
    new.cancel_reason := 'private_cancelled';
  end if;
  if new.type='chat.private' and (
    new.subject <> '{}'::jsonb or new.progress <> '{}'::jsonb
    or new.payload - array['schemaVersion','billingClass','outputKind','modelId','admission'] <> '{}'::jsonb
    or new.payload->>'schemaVersion' is distinct from '1'
    or new.payload->>'billingClass' is distinct from 'platform'
    or new.payload->>'outputKind' is distinct from 'text'
    or length(coalesce(new.payload->>'modelId','')) not between 1 and 160
    or (new.payload ? 'admission' and (
      jsonb_typeof(new.payload->'admission') is distinct from 'object'
      or (new.payload->'admission') - array['schemaVersion','billingContractVersion','funding','sku',
        'priceVersion','reservedTokens','reservedCostMicros','quoteHash'] <> '{}'::jsonb
      or new.payload->'admission'->>'sku' is distinct from 'chat.text'
    ))
    or (new.result is not null and (
      jsonb_typeof(new.result)<>'object'
      or new.result - array['schemaVersion','totalTokens'] <> '{}'::jsonb
      or coalesce(new.result->>'schemaVersion','1') <> '1'
      or coalesce(new.result->>'totalTokens','0') !~ '^[0-9]{1,12}$'
    ))
  ) then raise exception 'private_job_content_forbidden' using errcode='22023'; end if;
  return new;
end; $$;
revoke all on function public.guard_private_job_metadata() from public,anon,authenticated,service_role;
drop trigger if exists jobs_private_metadata_guard on public.jobs;
create trigger jobs_private_metadata_guard before insert or update on public.jobs
for each row execute function public.guard_private_job_metadata();

create or replace function public.guard_private_job_events()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare private_job boolean;
begin
  select type='chat.private' into private_job from public.jobs where id=new.job_id;
  if private_job then
    if tg_table_name <> 'job_events' then
      raise exception 'private_job_content_forbidden' using errcode='22023';
    end if;
    if new.kind not in ('job.accepted','job.leased','job.terminal','job.cancel_requested')
      or new.payload - array['status','type','queue','attempt','maxAttempts','leaseVersion','leaseExpiresAt',
        'result','errorClass','errorCode','retryable','cancelRequestedAt','reason','cancelReason'] <> '{}'::jsonb
      or (new.payload ? 'result' and new.payload->'result' <> 'null'::jsonb and (
        jsonb_typeof(new.payload->'result') <> 'object'
        or (new.payload->'result') - array['schemaVersion','totalTokens'] <> '{}'::jsonb
      )) then
      raise exception 'private_job_content_forbidden' using errcode='22023';
    end if;
  end if;
  return new;
end; $$;
revoke all on function public.guard_private_job_events() from public,anon,authenticated,service_role;
drop trigger if exists private_event_metadata_guard on public.job_events;
create trigger private_event_metadata_guard before insert or update on public.job_events
for each row execute function public.guard_private_job_events();
drop trigger if exists private_checkpoint_guard on public.job_checkpoints;
create trigger private_checkpoint_guard before insert or update on public.job_checkpoints
for each row execute function public.guard_private_job_events();
drop trigger if exists private_tool_effect_guard on public.job_tool_effects;
create trigger private_tool_effect_guard before insert or update on public.job_tool_effects
for each row execute function public.guard_private_job_events();

-- Admission and lease are in the same transaction. A crashed private stream is
-- never replayed: the standard chat worker exhausts its single attempt after expiry.
create or replace function public.admit_private_chat_v1(
  input_job_id uuid,input_principal_id uuid,input_auth_class text,
  input_model_id text,input_worker_id text,input_token_limit integer
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_result jsonb; v_job public.jobs%rowtype; v_now timestamptz:=clock_timestamp();
begin
  if input_worker_id is null or length(input_worker_id) not between 1 and 256
    or input_token_limit is null or input_token_limit not between 1 and 160000 then
    raise exception 'invalid_private_admission' using errcode='22023';
  end if;
  v_result := public.enqueue_job(input_job_id,'chat.private','chat',input_principal_id,input_auth_class,
    '{}'::jsonb,'private:'||input_job_id::text,encode(sha256(input_job_id::text::bytea),'hex'),
    jsonb_build_object('schemaVersion',1,'billingClass','platform','outputKind','text','modelId',input_model_id),
    jsonb_build_object('wallTimeMs',300000,'tokenLimit',input_token_limit,'toolCallLimit',16),0,1,v_now);
  if v_result->>'enqueued' <> 'true' then
    raise exception 'private_request_cannot_be_replayed' using errcode='23505';
  end if;
  update public.jobs set status='leased',attempt=1,lease_owner=input_worker_id,lease_version=1,
    lease_expires_at=v_now+interval '30 seconds',started_at=v_now,updated_at=v_now,event_sequence=2
    where id=input_job_id returning * into v_job;
  insert into public.job_events(job_id,principal_id,seq,kind,payload,worker_id,lease_version)
    values(input_job_id,input_principal_id,2,'job.leased',jsonb_build_object('status','leased','attempt',1,
      'leaseVersion',1,'leaseExpiresAt',v_job.lease_expires_at),input_worker_id,1);
  return public.job_contract_json(v_job);
end; $$;
revoke all on function public.admit_private_chat_v1(uuid,uuid,text,text,text,integer)
from public,anon,authenticated,service_role;
grant execute on function public.admit_private_chat_v1(uuid,uuid,text,text,text,integer) to service_role;
commit;
