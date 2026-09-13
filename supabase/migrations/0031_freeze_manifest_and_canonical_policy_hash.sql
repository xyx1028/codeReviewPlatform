-- 0031: freeze the active Harness manifest at enqueue time and use the same
-- canonical JSON policy hash as the Worker.

begin;

-- Matches worker/src/ai/policy/v4-capability-policy.ts stableStringify:
-- object keys sorted by C collation, no insignificant whitespace, arrays keep order.
create or replace function public.v4_canonical_jsonb_text(p_value jsonb)
returns text
language plpgsql
immutable
strict
set search_path = public
as $$
declare
  v_type text := jsonb_typeof(p_value);
  v_result text;
begin
  if v_type = 'object' then
    select '{' || coalesce(string_agg(
      to_jsonb(entry.key)::text || ':' || public.v4_canonical_jsonb_text(entry.value),
      ',' order by entry.key collate "C"
    ), '') || '}'
    into v_result
    from jsonb_each(p_value) entry;
    return v_result;
  elsif v_type = 'array' then
    select '[' || coalesce(string_agg(
      public.v4_canonical_jsonb_text(item.value),
      ',' order by item.ordinality
    ), '') || ']'
    into v_result
    from jsonb_array_elements(p_value) with ordinality item(value, ordinality);
    return v_result;
  end if;
  return p_value::text;
end;
$$;

create or replace function public.v4_policy_hash(p_policy jsonb)
returns text
language sql
immutable
strict
set search_path = public
as $$
  select encode(sha256(convert_to(public.v4_canonical_jsonb_text(p_policy), 'UTF8')), 'hex');
$$;

revoke execute on function public.v4_canonical_jsonb_text(jsonb)
  from public, anon, authenticated;
revoke execute on function public.v4_policy_hash(jsonb)
  from public, anon, authenticated;
grant execute on function public.v4_canonical_jsonb_text(jsonb) to service_role;
grant execute on function public.v4_policy_hash(jsonb) to service_role;

-- Golden parity check against Worker policyHash(V4_DEFAULT_POLICY). Migration aborts if
-- PostgreSQL canonicalization ever diverges from the TypeScript implementation.
do $$
declare
  v_hash text;
begin
  select public.v4_policy_hash(manifest.default_policy) into v_hash
  from public.v4_harness_manifest manifest
  where manifest.is_active;
  if v_hash is distinct from 'ff8f5ef459f00e2e1c52543a90528e379988ecd32d0f549de9bf283cd7ffc464' then
    raise exception 'V4_POLICY_HASH_PARITY_FAILED: %', coalesce(v_hash, '<null>');
  end if;
end;
$$;

-- Worker 会对域名白名单做 trim/lowercase/dedupe/sort；数据库先用同一规则保存，
-- 保证冻结 snapshot 的 canonical hash 与 Worker 归一化后的 hash 完全一致。
create or replace function public.normalize_v4_model_web_domains()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.web_allowed_domains := coalesce((
    select array_agg(domain order by domain collate "C")
    from (
      select distinct lower(btrim(value)) as domain
      from unnest(coalesce(new.web_allowed_domains, array[]::text[])) value
      where btrim(value) <> ''
        and position('/' in value) = 0
        and position(' ' in value) = 0
        and lower(btrim(value)) ~ '^[a-z0-9.-]+$'
    ) normalized
  ), array[]::text[]);
  return new;
end;
$$;

revoke execute on function public.normalize_v4_model_web_domains()
  from public, anon, authenticated;
grant execute on function public.normalize_v4_model_web_domains() to service_role;

drop trigger if exists normalize_v4_model_web_domains on public.ai_model_config;
create trigger normalize_v4_model_web_domains
before insert or update of web_allowed_domains on public.ai_model_config
for each row execute function public.normalize_v4_model_web_domains();

update public.ai_model_config
set web_allowed_domains = web_allowed_domains;

-- Enqueue 的 INSERT 仍由既有 RPC 完成；触发器在同一事务内用 active manifest
-- 冻结 Harness/contract 身份，并覆盖旧 SQL 的非规范 policy hash。
create or replace function public.freeze_v4_job_manifest_and_policy_hash()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_manifest public.v4_harness_manifest;
begin
  if new.policy_version <> 4 then
    return new;
  end if;

  select * into v_manifest
  from public.v4_harness_manifest manifest
  where manifest.is_active;
  if v_manifest.manifest_revision is null then
    raise exception 'V4_HARNESS_MANIFEST_MISSING';
  end if;
  if new.capability_policy_snapshot is null
     or new.capability_policy_snapshot = '{}'::jsonb then
    raise exception 'V4_CAPABILITY_POLICY_MISSING';
  end if;

  new.policy_hash := public.v4_policy_hash(new.capability_policy_snapshot);
  new.harness_version := v_manifest.harness_version;
  new.capability_contract_hash := v_manifest.manifest_hash;
  return new;
end;
$$;

revoke execute on function public.freeze_v4_job_manifest_and_policy_hash()
  from public, anon, authenticated;
grant execute on function public.freeze_v4_job_manifest_and_policy_hash() to service_role;

drop trigger if exists freeze_v4_job_manifest_and_policy_hash on public.analysis_job;
create trigger freeze_v4_job_manifest_and_policy_hash
before insert on public.analysis_job
for each row execute function public.freeze_v4_job_manifest_and_policy_hash();

-- claim 创建 run 时以 Job 冻结哈希为准，覆盖 0027 中 jsonb::text 的旧算法。
create or replace function public.copy_v4_job_policy_hash_to_run()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select job.policy_hash into new.policy_hash
  from public.analysis_job job
  where job.id = new.job_id;
  if new.policy_hash is null then
    raise exception 'V4_CAPABILITY_POLICY_MISSING';
  end if;
  return new;
end;
$$;

revoke execute on function public.copy_v4_job_policy_hash_to_run()
  from public, anon, authenticated;
grant execute on function public.copy_v4_job_policy_hash_to_run() to service_role;

drop trigger if exists copy_v4_job_policy_hash_to_run on public.analysis_agent_run;
create trigger copy_v4_job_policy_hash_to_run
before insert on public.analysis_agent_run
for each row execute function public.copy_v4_job_policy_hash_to_run();

-- 0031 部署前已经排队但尚未结束的 V4 Job 绑定当前 r1 manifest，并修正哈希。
update public.analysis_job job
set policy_hash = public.v4_policy_hash(job.capability_policy_snapshot),
    harness_version = manifest.harness_version,
    capability_contract_hash = manifest.manifest_hash
from public.v4_harness_manifest manifest
where manifest.is_active
  and job.policy_version = 4
  and job.capability_policy_snapshot <> '{}'::jsonb
  and job.status in ('QUEUED', 'PREPARING_CODE', 'PROCESSING', 'FINALIZING');

update public.analysis_agent_run run
set policy_hash = job.policy_hash
from public.analysis_job job
where job.id = run.job_id
  and job.policy_version = 4
  and job.status in ('QUEUED', 'PREPARING_CODE', 'PROCESSING', 'FINALIZING')
  and run.sealed_at is null;

-- 冻结后 manifest 身份和策略哈希同样不可改；profile_hash 仍由首次 attempt 回填。
create or replace function public.enforce_analysis_job_policy_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.policy_version is distinct from old.policy_version then
    raise exception 'analysis_job.policy_version is immutable';
  end if;
  if old.capability_policy_snapshot <> '{}'::jsonb
     and new.capability_policy_snapshot is distinct from old.capability_policy_snapshot then
    raise exception 'analysis_job.capability_policy_snapshot is immutable once frozen';
  end if;
  if old.policy_version = 4 and (
    new.policy_hash is distinct from old.policy_hash
    or new.harness_version is distinct from old.harness_version
    or new.capability_contract_hash is distinct from old.capability_contract_hash
  ) then
    raise exception 'analysis_job V4 manifest identity is immutable once frozen';
  end if;
  return new;
end;
$$;

comment on function public.v4_policy_hash(jsonb) is
  'Canonical V4 policy hash; byte-compatible with Worker stableStringify + SHA-256.';
comment on trigger freeze_v4_job_manifest_and_policy_hash on public.analysis_job is
  'Freezes active Harness version/manifest hash and canonical policy hash for each new V4 job.';

commit;
