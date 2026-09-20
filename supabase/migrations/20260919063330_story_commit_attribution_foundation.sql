-- V1.11 需求提交归属与精准变更分析：数据库基础层。
--
-- 设计边界：
--   * 旧 Job 保持 analysis_context_version=1 / scope_status=LEGACY；
--   * v2 的规则、需求输入、身份、repository manifest 和候选均在 Job/Task 维度冻结；
--   * 完整邮箱、diff 正文不进入普通表、RPC 输出或运行审计；
--   * 所有可信写入只经 ADMIN/service_role RPC，浏览器不能自报 manifest/hash；
--   * 本迁移只前滚，不删除业务数据，也不修改任何既有迁移。

begin;

create extension if not exists pgcrypto with schema extensions;

------------------------------------------------------------------------------
-- 1. 可视化归属规则：规则集、不可变发布版本、规则、模拟和 append-only 审计
------------------------------------------------------------------------------

create table if not exists public.analysis_attribution_rule_set (
  id uuid primary key default gen_random_uuid(),
  rule_set_code text not null unique check (rule_set_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  display_name text not null check (btrim(display_name) <> ''),
  description text,
  enabled boolean not null default true,
  current_published_version_id uuid,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.analysis_attribution_rule_version (
  id uuid primary key default gen_random_uuid(),
  rule_set_id uuid not null references public.analysis_attribution_rule_set(id) on delete restrict,
  version integer not null check (version >= 1),
  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'VALIDATED', 'PUBLISHED')),
  revision integer not null default 1 check (revision >= 1),
  schema_version integer not null default 1 check (schema_version = 1),
  canonical_config jsonb not null default '{}'::jsonb,
  ruleset_hash text check (ruleset_hash is null or ruleset_hash ~ '^(sha256:)?[0-9a-f]{64}$'),
  source_version_id uuid references public.analysis_attribution_rule_version(id) on delete restrict,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  validated_at timestamptz,
  published_by uuid references auth.users(id) on delete set null,
  published_at timestamptz,
  publish_reason text,
  unique (rule_set_id, version)
);

create table if not exists public.analysis_attribution_rule (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.analysis_attribution_rule_version(id) on delete cascade,
  rule_code text not null check (rule_code ~ '^ATTR_[A-Z0-9_]{3,80}$'),
  display_name text not null check (btrim(display_name) <> ''),
  description text not null check (btrim(description) <> ''),
  priority integer not null check (priority between 1 and 1000),
  enabled boolean not null default true,
  capability text not null check (capability in ('GIT_BASE', 'MR_OPTIONAL', 'SYSTEM')),
  condition_tree jsonb not null,
  action_type text not null check (action_type in (
    'SELECT_STRONG', 'ADD_AI_CANDIDATE', 'EXCLUDE_CURRENT_STORY',
    'MARK_EFFECTIVE_REVERTED', 'DOWNRANK_CANDIDATE', 'FLAG_CONFLICT',
    'GLOBAL_FALLBACK'
  )),
  reason_code text not null check (reason_code ~ '^[A-Z][A-Z0-9_]{2,80}$'),
  system_locked boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (version_id, rule_code)
);

create table if not exists public.analysis_attribution_rule_test_run (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.analysis_attribution_rule_version(id) on delete cascade,
  sample_set_id text not null check (btrim(sample_set_id) <> ''),
  sample_set_hash text not null check (sample_set_hash ~ '^(sha256:)?[0-9a-f]{64}$'),
  metrics jsonb not null default '{}'::jsonb,
  diff_summary jsonb not null default '{}'::jsonb,
  passed boolean not null,
  failure_code text,
  executed_by uuid references auth.users(id) on delete set null,
  executed_at timestamptz not null default now()
);

create table if not exists public.analysis_attribution_rule_audit (
  id bigserial primary key,
  rule_set_id uuid references public.analysis_attribution_rule_set(id) on delete restrict,
  version_id uuid references public.analysis_attribution_rule_version(id) on delete restrict,
  action text not null check (action in (
    'CREATE_DRAFT', 'SAVE_DRAFT', 'VALIDATE', 'SIMULATE', 'PUBLISH',
    'RESTORE', 'PERMISSION_DENIED'
  )),
  actor_id uuid references auth.users(id) on delete set null,
  reason text,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_attribution_rule_version_set
on public.analysis_attribution_rule_version(rule_set_id, version desc);
create index if not exists idx_attribution_rule_version_status
on public.analysis_attribution_rule_version(status, created_at desc);
create index if not exists idx_attribution_rule_version_rules
on public.analysis_attribution_rule(version_id, priority desc, sort_order, rule_code);
create index if not exists idx_attribution_rule_test_version
on public.analysis_attribution_rule_test_run(version_id, executed_at desc);
create index if not exists idx_attribution_rule_audit_set
on public.analysis_attribution_rule_audit(rule_set_id, created_at desc);

-- create-table-if-not-exists 不会为已存在对象补列；显式 ALTER 保证迁移可重复应用。
alter table public.analysis_attribution_rule_set
  add column if not exists current_published_version_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'analysis_attribution_rule_set_current_version_fk'
  ) then
    alter table public.analysis_attribution_rule_set
      add constraint analysis_attribution_rule_set_current_version_fk
      foreign key (current_published_version_id)
      references public.analysis_attribution_rule_version(id) on delete restrict;
  end if;
end $$;

create or replace function public.attribution_rule_version_config(p_version_id uuid)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'schemaVersion', 1,
    'rules', coalesce(jsonb_agg(jsonb_build_object(
      'ruleCode', rule.rule_code,
      'displayName', rule.display_name,
      'description', rule.description,
      'priority', rule.priority,
      'enabled', rule.enabled,
      'capability', rule.capability,
      'when', rule.condition_tree,
      'action', jsonb_build_object('type', rule.action_type, 'reasonCode', rule.reason_code),
      'systemLocked', rule.system_locked,
      'sortOrder', rule.sort_order
    ) order by rule.priority desc, rule.sort_order, rule.rule_code collate "C"), '[]'::jsonb)
  )
  from public.analysis_attribution_rule rule
  where rule.version_id = p_version_id;
$$;

create or replace function public.attribution_rule_version_hash(p_version_id uuid)
returns text
language sql
stable
set search_path = public, extensions
as $$
  select encode(digest(convert_to(public.attribution_rule_version_config(p_version_id)::text, 'UTF8'), 'sha256'), 'hex');
$$;

create or replace function public.enforce_attribution_rule_version_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status = 'PUBLISHED' then
    raise exception 'ATTRIBUTION_RULE_VERSION_IMMUTABLE';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists attribution_rule_version_immutable
on public.analysis_attribution_rule_version;
create trigger attribution_rule_version_immutable
before update or delete on public.analysis_attribution_rule_version
for each row execute function public.enforce_attribution_rule_version_immutable();

create or replace function public.enforce_published_attribution_rule_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (
    select 1 from public.analysis_attribution_rule_version version
    where version.id = old.version_id and version.status = 'PUBLISHED'
  ) then
    raise exception 'ATTRIBUTION_RULE_VERSION_IMMUTABLE';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists published_attribution_rule_immutable
on public.analysis_attribution_rule;
create trigger published_attribution_rule_immutable
before update or delete on public.analysis_attribution_rule
for each row execute function public.enforce_published_attribution_rule_immutable();

create or replace function public.reject_append_only_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- 父 Job/Batch 的受控级联清理会在嵌套触发器中进入；直接覆盖或直接删除事实仍拒绝。
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'APPEND_ONLY_RECORD_IMMUTABLE';
end;
$$;

drop trigger if exists attribution_rule_audit_append_only
on public.analysis_attribution_rule_audit;
create trigger attribution_rule_audit_append_only
before update or delete on public.analysis_attribution_rule_audit
for each row execute function public.reject_append_only_mutation();

drop trigger if exists attribution_rule_test_run_append_only
on public.analysis_attribution_rule_test_run;
create trigger attribution_rule_test_run_append_only
before update or delete on public.analysis_attribution_rule_test_run
for each row execute function public.reject_append_only_mutation();

------------------------------------------------------------------------------
-- 2. 发布随版本交付的 13 条系统规则。固定 UUID 使重复应用与跨环境身份一致。
------------------------------------------------------------------------------

insert into public.analysis_attribution_rule_set (
  id, rule_set_code, display_name, description, enabled
) values (
  '11110000-0000-4000-a000-000000000001',
  'STORY_COMMIT_ATTRIBUTION',
  '需求提交归属规则',
  'V1.11 系统预置规则；Job 只执行其冻结的发布版本。',
  true
) on conflict (id) do nothing;

insert into public.analysis_attribution_rule_version (
  id, rule_set_id, version, status, revision, schema_version, canonical_config,
  source_version_id, publish_reason
) values (
  '11110000-0000-4000-a000-000000000101',
  '11110000-0000-4000-a000-000000000001',
  1, 'DRAFT', 1, 1, '{}'::jsonb, null, 'V1.11 系统预置基线'
) on conflict (id) do nothing;

insert into public.analysis_attribution_rule (
  id, version_id, rule_code, display_name, description, priority, enabled,
  capability, condition_tree, action_type, reason_code, system_locked, sort_order
) values
('11110001-0000-4000-a000-000000000001','11110000-0000-4000-a000-000000000101','ATTR_RANGE_INCOMPLETE_FALLBACK','Git 范围不完整时全仓兜底','范围不完整、base 不可达或 hash 失败时禁止伪装精准分析。',1000,true,'SYSTEM','{"any":[{"field":"repository.enumeration_status","operator":"IN_ENUM","value":["SHALLOW_INCOMPLETE","RANGE_TOO_LARGE","FAILED"]}]}'::jsonb,'GLOBAL_FALLBACK','RANGE_INCOMPLETE',true,10),
('11110001-0000-4000-a000-000000000002','11110000-0000-4000-a000-000000000101','ATTR_EXPLICIT_COMMIT_STORY_ID','提交说明独立字段精确写明当前需求编码','结构化 Story-Id 精确相等且可达冻结 HEAD 时加入强关联主集。',900,true,'GIT_BASE','{"all":[{"field":"commit.structured_story_ids","operator":"EXACT_CURRENT_STORY_TOKEN"},{"field":"commit.reachability","operator":"EQUALS","value":"REACHABLE_FROM_FROZEN_HEAD"}]}'::jsonb,'SELECT_STRONG','EXPLICIT_STORY_ID',true,20),
('11110001-0000-4000-a000-000000000003','11110000-0000-4000-a000-000000000101','ATTR_EXPLICIT_MR_STORY_ID','合并申请独立字段精确写明当前需求编码','MR 增强可用且结构化 Story-Id 精确匹配时选择可达提交。',900,true,'MR_OPTIONAL','{"all":[{"field":"mr.capability_status","operator":"EQUALS","value":"AVAILABLE"},{"field":"mr.structured_story_ids","operator":"EXACT_CURRENT_STORY_TOKEN"}]}'::jsonb,'SELECT_STRONG','EXPLICIT_MR_STORY_ID',true,30),
('11110001-0000-4000-a000-000000000004','11110000-0000-4000-a000-000000000101','ATTR_SAME_EXPLICIT_MR_COMMIT','同一明确合并申请内的可达提交','精确命中需求的 MR 内其它可达提交一并进入强关联主集。',900,true,'MR_OPTIONAL','{"all":[{"field":"commit.mr_membership","operator":"BELONGS_TO_EXPLICIT_MR"},{"field":"commit.reachability","operator":"EQUALS","value":"REACHABLE_FROM_FROZEN_HEAD"}]}'::jsonb,'SELECT_STRONG','SAME_EXPLICIT_MR',true,40),
('11110001-0000-4000-a000-000000000005','11110000-0000-4000-a000-000000000101','ATTR_REVERT_CHAIN','回滚链仍保留需求关联','回滚相关提交保留关系并标记当前效果可能已撤销。',850,true,'GIT_BASE','{"all":[{"field":"commit.is_revert","operator":"IS_TRUE"},{"field":"commit.reverted_sha","operator":"REVERTS_RELATED_COMMIT"}]}'::jsonb,'MARK_EFFECTIVE_REVERTED','REVERT_OF_RELATED_COMMIT',true,50),
('11110001-0000-4000-a000-000000000006','11110000-0000-4000-a000-000000000101','ATTR_OTHER_STORY_EXCLUSION','明确只属于其它需求','精确命中其它需求且没有共享关系时排除当前需求。',800,true,'GIT_BASE','{"all":[{"field":"commit.structured_story_ids","operator":"EXACT_OTHER_STORY_TOKEN"}]}'::jsonb,'EXCLUDE_CURRENT_STORY','OTHER_STORY_EXPLICIT',true,60),
('11110001-0000-4000-a000-000000000007','11110000-0000-4000-a000-000000000101','ATTR_STORY_CODE_WITH_SUPPORT','需求号命中并有独立支持线索','非结构化标题或分支命中还需作者、MR 或模块独立线索。',700,true,'GIT_BASE','{"all":[{"field":"commit.story_tokens","operator":"EXACT_CURRENT_STORY_TOKEN"},{"field":"commit.support_signal","operator":"IN_ENUM","value":["VERIFIED_AUTHOR","EXPLICIT_MR","MODULE_OVERLAP"]}]}'::jsonb,'SELECT_STRONG','STORY_CODE_WITH_SUPPORT',true,70),
('11110001-0000-4000-a000-000000000008','11110000-0000-4000-a000-000000000101','ATTR_OWNER_WINDOW_MODULE_CANDIDATE','人员、时间与模块共同命中','已验证身份、辅助窗口和模块重合时交给 AI 判断。',500,true,'GIT_BASE','{"all":[{"field":"commit.author_identity","operator":"VERIFIED_IDENTITY_MATCH"},{"field":"commit.committed_at","operator":"WITHIN_FROZEN_WINDOW"},{"field":"commit.files","operator":"MODULE_OVERLAP"}]}'::jsonb,'ADD_AI_CANDIDATE','OWNER_WINDOW_MODULE',true,80),
('11110001-0000-4000-a000-000000000009','11110000-0000-4000-a000-000000000101','ATTR_STORY_TEXT_CANDIDATE','正文普通提及需求号','普通自然语言提及只进入 AI 候选，不直接确认。',500,true,'GIT_BASE','{"all":[{"field":"commit.body_story_tokens","operator":"EXACT_CURRENT_STORY_TOKEN"}]}'::jsonb,'ADD_AI_CANDIDATE','UNSTRUCTURED_STORY_MENTION',true,90),
('11110001-0000-4000-a000-000000000010','11110000-0000-4000-a000-000000000101','ATTR_BOT_GENERATED_DOWNRANK','机器人或生成文件仅降权','没有更强结构化关系时仅降权，不一律排除。',300,true,'GIT_BASE','{"any":[{"field":"commit.is_bot","operator":"IS_TRUE"},{"field":"commit.is_generated","operator":"IS_TRUE"}]}'::jsonb,'DOWNRANK_CANDIDATE','BOT_OR_GENERATED',true,100),
('11110001-0000-4000-a000-000000000011','11110000-0000-4000-a000-000000000101','ATTR_IDENTITY_AMBIGUOUS','身份映射冲突时不猜测','fingerprint 冲突或姓名不可区分时忽略身份强度并标冲突。',1000,true,'SYSTEM','{"all":[{"field":"identity.status","operator":"EQUALS","value":"AMBIGUOUS"}]}'::jsonb,'FLAG_CONFLICT','IDENTITY_AMBIGUOUS',true,110),
('11110001-0000-4000-a000-000000000012','11110000-0000-4000-a000-000000000101','ATTR_NO_CANDIDATE_FALLBACK','没有候选时全仓兜底','候选为空不能自动推出需求未实现。',100,true,'SYSTEM','{"all":[{"field":"scope.candidate_count","operator":"EQUALS","value":0}]}'::jsonb,'GLOBAL_FALLBACK','NO_CANDIDATE',true,120),
('11110001-0000-4000-a000-000000000013','11110000-0000-4000-a000-000000000101','ATTR_RULE_CONFLICT_FALLBACK','互斥规则冲突时全仓兜底','同优先级产生互斥终态时不猜测。',1000,true,'SYSTEM','{"all":[{"field":"scope.rule_conflict","operator":"IS_TRUE"}]}'::jsonb,'GLOBAL_FALLBACK','RULE_CONFLICT',true,130)
on conflict (id) do nothing;

-- 第一次应用时从真实规则行生成规范快照和 hash；重复应用不触碰发布版。
update public.analysis_attribution_rule_version version
set canonical_config = public.attribution_rule_version_config(version.id),
    ruleset_hash = public.attribution_rule_version_hash(version.id),
    status = 'PUBLISHED',
    validated_at = coalesce(validated_at, now()),
    published_at = coalesce(published_at, now())
where version.id = '11110000-0000-4000-a000-000000000101'
  and version.status <> 'PUBLISHED';

update public.analysis_attribution_rule_set
set current_published_version_id = '11110000-0000-4000-a000-000000000101',
    updated_at = now()
where id = '11110000-0000-4000-a000-000000000001'
  and current_published_version_id is null;

------------------------------------------------------------------------------
-- 3. Job v2 字段与仓库范围字段（旧行得到显式 LEGACY 语义）
------------------------------------------------------------------------------

alter table public.analysis_job
  add column if not exists analysis_context_version smallint not null default 1,
  add column if not exists commit_window_days integer not null default 21,
  add column if not exists scope_requested_at timestamptz,
  add column if not exists attribution_algorithm_version text,
  add column if not exists story_input_catalog_hash text,
  add column if not exists identity_snapshot_hash text,
  add column if not exists repository_manifest_hash text,
  add column if not exists selected_scope_hash text,
  add column if not exists scope_status text not null default 'LEGACY',
  add column if not exists scope_error_code text,
  add column if not exists required_worker_scope_version integer not null default 1,
  add column if not exists attribution_rule_version_id uuid
    references public.analysis_attribution_rule_version(id) on delete restrict,
  add column if not exists ruleset_hash text;

alter table public.analysis_job
  drop constraint if exists analysis_job_analysis_context_version_check,
  add constraint analysis_job_analysis_context_version_check
    check (analysis_context_version in (1, 2)),
  drop constraint if exists analysis_job_commit_window_days_check,
  add constraint analysis_job_commit_window_days_check
    check (commit_window_days in (14, 21, 28)),
  drop constraint if exists analysis_job_scope_status_check,
  add constraint analysis_job_scope_status_check
    check (scope_status in ('LEGACY', 'PREPARING', 'READY', 'DEGRADED', 'FAILED')),
  drop constraint if exists analysis_job_required_worker_scope_version_check,
  add constraint analysis_job_required_worker_scope_version_check
    check (required_worker_scope_version in (1, 2));

alter table public.analysis_job drop constraint if exists analysis_job_status_check;
alter table public.analysis_job add constraint analysis_job_status_check
check (status in (
  'QUEUED', 'PREPARING_CODE', 'PREPARING_SCOPE', 'PROCESSING', 'FINALIZING',
  'SUCCEEDED', 'FAILED'
));

drop index if exists public.uq_analysis_job_active_batch;
create unique index uq_analysis_job_active_batch
on public.analysis_job(batch_id)
where status in ('QUEUED', 'PREPARING_CODE', 'PREPARING_SCOPE', 'PROCESSING', 'FINALIZING');

alter table public.analysis_repository_snapshot
  add column if not exists base_sha text,
  add column if not exists head_sha text,
  add column if not exists range_source text,
  add column if not exists range_start_at timestamptz,
  add column if not exists range_end_at timestamptz,
  add column if not exists head_resolved_at timestamptz,
  add column if not exists ancestry_status text,
  add column if not exists enumeration_status text,
  add column if not exists commit_count integer,
  add column if not exists commit_manifest_hash text,
  add column if not exists diff_archive_status text not null default 'NOT_REQUESTED',
  add column if not exists diff_archive_bytes bigint not null default 0;

alter table public.analysis_repository_snapshot
  drop constraint if exists analysis_repository_snapshot_range_source_check,
  add constraint analysis_repository_snapshot_range_source_check check (
    range_source is null or range_source in (
      'PREVIOUS_SUCCESSFUL_JOB', 'TIME_DERIVED', 'RELEASE_MANIFEST', 'UNAVAILABLE'
    )
  ),
  drop constraint if exists analysis_repository_snapshot_ancestry_status_check,
  add constraint analysis_repository_snapshot_ancestry_status_check check (
    ancestry_status is null or ancestry_status in (
      'VERIFIED', 'BASE_UNREACHABLE', 'HEAD_MISSING', 'UNKNOWN'
    )
  ),
  drop constraint if exists analysis_repository_snapshot_enumeration_status_check,
  add constraint analysis_repository_snapshot_enumeration_status_check check (
    enumeration_status is null or enumeration_status in (
      'PENDING', 'COMPLETE', 'SHALLOW_INCOMPLETE', 'RANGE_TOO_LARGE',
      'BASELINE_REQUIRED', 'FAILED'
    )
  ),
  drop constraint if exists analysis_repository_snapshot_diff_archive_status_check,
  add constraint analysis_repository_snapshot_diff_archive_status_check check (
    diff_archive_status in ('NOT_REQUESTED', 'PREPARING', 'READY', 'PARTIAL', 'FAILED')
  ),
  drop constraint if exists analysis_repository_snapshot_range_time_check,
  add constraint analysis_repository_snapshot_range_time_check check (
    range_start_at is null or range_end_at is null or range_start_at < range_end_at
  ),
  drop constraint if exists analysis_repository_snapshot_commit_count_check,
  add constraint analysis_repository_snapshot_commit_count_check check (
    commit_count is null or commit_count between 0 and 2000
  );

-- 即使旧 Worker 仍调用既有 claim RPC，数据库也在状态转换边界 fail closed：
-- v2 Job/Task 只能交给心跳 capabilities 明确声明 storyCommitScopeVersion >= 2 的 Worker。
create or replace function public.enforce_story_commit_scope_worker_capability()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_required integer;
  v_capability text;
begin
  if tg_table_name = 'analysis_job' then
    v_required := new.required_worker_scope_version;
    if v_required >= 2 and new.status = 'PREPARING_CODE'
       and (old.status is distinct from new.status or old.worker_id is distinct from new.worker_id) then
      select heartbeat.capabilities->>'storyCommitScopeVersion' into v_capability
      from public.analysis_worker_heartbeat heartbeat
      where heartbeat.worker_id = new.worker_id;
      if v_capability is null or v_capability !~ '^[0-9]+$' or v_capability::integer < v_required then
        raise exception 'WORKER_STORY_COMMIT_SCOPE_UNSUPPORTED';
      end if;
    end if;
  else
    if new.agent_status = 'RUNNING'
       and (old.agent_status is distinct from new.agent_status or old.worker_id is distinct from new.worker_id) then
      select job.required_worker_scope_version into v_required
      from public.analysis_job job where job.id = new.job_id;
      if coalesce(v_required,1) >= 2 then
        select heartbeat.capabilities->>'storyCommitScopeVersion' into v_capability
        from public.analysis_worker_heartbeat heartbeat
        where heartbeat.worker_id = new.worker_id;
        if v_capability is null or v_capability !~ '^[0-9]+$' or v_capability::integer < v_required then
          raise exception 'WORKER_STORY_COMMIT_SCOPE_UNSUPPORTED';
        end if;
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_v2_job_worker_capability on public.analysis_job;
create trigger enforce_v2_job_worker_capability
before update of status, worker_id on public.analysis_job
for each row execute function public.enforce_story_commit_scope_worker_capability();

drop trigger if exists enforce_v2_task_worker_capability on public.analysis_story_task;
create trigger enforce_v2_task_worker_capability
before update of agent_status, worker_id on public.analysis_story_task
for each row execute function public.enforce_story_commit_scope_worker_capability();

-- Attempt/Session 必须复制这些冻结身份；Worker 后续写 profile 时不能只比较实时规则。
alter table public.analysis_agent_run
  add column if not exists story_input_catalog_hash text,
  add column if not exists identity_snapshot_hash text,
  add column if not exists repository_manifest_hash text,
  add column if not exists selected_scope_hash text,
  add column if not exists attribution_algorithm_version text,
  add column if not exists attribution_ruleset_hash text,
  add column if not exists scope_generation integer;

alter table public.analysis_session_checkpoint
  add column if not exists analysis_scope_hash text,
  add column if not exists attribution_ruleset_hash text;

create or replace function public.enforce_analysis_job_scope_identity_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.analysis_context_version = 2
     and old.scope_status in ('READY','DEGRADED')
     and (
       new.analysis_context_version is distinct from old.analysis_context_version
       or new.commit_window_days is distinct from old.commit_window_days
       or new.attribution_algorithm_version is distinct from old.attribution_algorithm_version
       or new.story_input_catalog_hash is distinct from old.story_input_catalog_hash
       or new.identity_snapshot_hash is distinct from old.identity_snapshot_hash
       or new.repository_manifest_hash is distinct from old.repository_manifest_hash
       or new.selected_scope_hash is distinct from old.selected_scope_hash
       or new.required_worker_scope_version is distinct from old.required_worker_scope_version
       or new.attribution_rule_version_id is distinct from old.attribution_rule_version_id
       or new.ruleset_hash is distinct from old.ruleset_hash
     ) then
    raise exception 'ANALYSIS_JOB_SCOPE_IDENTITY_IMMUTABLE';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_analysis_job_scope_identity_immutable on public.analysis_job;
create trigger enforce_analysis_job_scope_identity_immutable
before update on public.analysis_job
for each row execute function public.enforce_analysis_job_scope_identity_immutable();

create index if not exists idx_analysis_repo_snapshot_manifest
on public.analysis_repository_snapshot(job_id, enumeration_status, repository_name);

------------------------------------------------------------------------------
-- 4. 开发身份与 Job 输入冻结快照
------------------------------------------------------------------------------

create table if not exists public.developer_identity (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check (btrim(display_name) <> ''),
  employee_code text,
  status text not null default 'UNVERIFIED'
    check (status in ('VERIFIED', 'UNVERIFIED', 'CONFLICT', 'DISABLED')),
  revision integer not null default 1 check (revision >= 1),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_developer_identity_employee_code
on public.developer_identity(lower(employee_code)) where employee_code is not null;

create table if not exists public.developer_git_identity (
  id uuid primary key default gen_random_uuid(),
  developer_identity_id uuid not null references public.developer_identity(id) on delete restrict,
  provider text not null default 'gitlab' check (provider in ('git', 'gitlab')),
  email_fingerprint text check (email_fingerprint is null or email_fingerprint ~ '^[0-9a-f]{64}$'),
  masked_email text,
  email_domain text,
  author_name_aliases text[] not null default array[]::text[],
  gitlab_username text,
  gitlab_user_id text,
  verification_status text not null default 'UNVERIFIED'
    check (verification_status in ('VERIFIED', 'UNVERIFIED', 'CONFLICT', 'DISABLED')),
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  revision integer not null default 1 check (revision >= 1),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (valid_until is null or valid_until > valid_from),
  check (email_fingerprint is not null or cardinality(author_name_aliases) > 0
         or gitlab_user_id is not null or gitlab_username is not null)
);

create unique index if not exists uq_developer_git_identity_active_fingerprint
on public.developer_git_identity(provider, email_fingerprint)
where email_fingerprint is not null
  and verification_status in ('VERIFIED', 'UNVERIFIED')
  and valid_until is null;
create index if not exists idx_developer_git_identity_developer
on public.developer_git_identity(developer_identity_id, verification_status);

create table if not exists public.analysis_job_identity_snapshot (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.analysis_job(id) on delete cascade,
  source_developer_identity_id uuid not null references public.developer_identity(id) on delete restrict,
  source_git_identity_id uuid not null references public.developer_git_identity(id) on delete restrict,
  developer_display_name text not null,
  employee_code text,
  identity_status text not null,
  provider text not null,
  email_fingerprint text,
  masked_email text,
  email_domain text,
  author_name_aliases text[] not null default array[]::text[],
  gitlab_username text,
  gitlab_user_id text,
  verification_status text not null,
  snapshot_hash text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (job_id, source_git_identity_id)
);

create table if not exists public.analysis_job_story_snapshot (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.analysis_job(id) on delete cascade,
  story_id uuid not null references public.review_story(id) on delete restrict,
  story_code text not null,
  story_name text not null,
  owners_text text not null,
  normalized_developer_ids uuid[] not null default array[]::uuid[],
  project_name text,
  application_name text,
  release_window text,
  requirement_context jsonb not null default '{}'::jsonb,
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (job_id, story_id)
);

create or replace function public.reject_frozen_input_snapshot_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'ANALYSIS_SCOPE_INPUT_IMMUTABLE';
end;
$$;

drop trigger if exists analysis_job_identity_snapshot_immutable
on public.analysis_job_identity_snapshot;
create trigger analysis_job_identity_snapshot_immutable
before update on public.analysis_job_identity_snapshot
for each row execute function public.reject_frozen_input_snapshot_update();

drop trigger if exists analysis_job_story_snapshot_immutable
on public.analysis_job_story_snapshot;
create trigger analysis_job_story_snapshot_immutable
before update on public.analysis_job_story_snapshot
for each row execute function public.reject_frozen_input_snapshot_update();

------------------------------------------------------------------------------
-- 5. Repository commit/file manifest、Story scope/candidate/diff/access/expansion
------------------------------------------------------------------------------

create table if not exists public.analysis_repository_commit (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.analysis_repository_snapshot(id) on delete cascade,
  sha text not null check (sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  sequence_no integer not null check (sequence_no >= 0),
  parent_shas text[] not null default array[]::text[],
  tree_sha text check (tree_sha is null or tree_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  author_name text not null,
  author_email_fingerprint text check (author_email_fingerprint is null or author_email_fingerprint ~ '^[0-9a-f]{64}$'),
  author_email_masked text,
  authored_at timestamptz,
  committer_name text,
  committer_email_fingerprint text check (committer_email_fingerprint is null or committer_email_fingerprint ~ '^[0-9a-f]{64}$'),
  committer_email_masked text,
  committed_at timestamptz not null,
  subject text not null,
  message_body text,
  trailers jsonb not null default '{}'::jsonb,
  structured_story_ids text[] not null default array[]::text[],
  coauthor_email_fingerprints text[] not null default array[]::text[],
  is_merge boolean not null default false,
  is_revert boolean not null default false,
  reverted_sha text,
  patch_id text,
  files_changed integer not null default 0 check (files_changed >= 0),
  additions integer not null default 0 check (additions >= 0),
  deletions integer not null default 0 check (deletions >= 0),
  binary_files integer not null default 0 check (binary_files >= 0),
  effective_status text not null default 'UNKNOWN'
    check (effective_status in ('EFFECTIVE', 'REVERTED', 'PARTIAL', 'UNKNOWN')),
  created_at timestamptz not null default now(),
  unique (snapshot_id, sha),
  unique (snapshot_id, sequence_no),
  check (message_body is null or octet_length(message_body) <= 32768)
);

create table if not exists public.analysis_commit_file (
  id bigserial primary key,
  commit_id uuid not null references public.analysis_repository_commit(id) on delete cascade,
  file_order integer not null check (file_order >= 0),
  path text not null check (btrim(path) <> '' and path !~ '(^/|(^|/)\.\.(/|$)|\\)'),
  old_path text check (old_path is null or (btrim(old_path) <> '' and old_path !~ '(^/|(^|/)\.\.(/|$)|\\)')),
  change_type text not null check (change_type in ('ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'TYPE_CHANGED')),
  additions integer check (additions is null or additions >= 0),
  deletions integer check (deletions is null or deletions >= 0),
  is_binary boolean not null default false,
  created_at timestamptz not null default now(),
  unique (commit_id, file_order)
);

create index if not exists idx_analysis_repository_commit_snapshot_time
on public.analysis_repository_commit(snapshot_id, committed_at, sequence_no);
create index if not exists idx_analysis_repository_commit_sha
on public.analysis_repository_commit(sha);
create index if not exists idx_analysis_commit_file_commit
on public.analysis_commit_file(commit_id, file_order);

create table if not exists public.analysis_story_scope (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.analysis_story_task(id) on delete cascade,
  generation integer not null check (generation >= 1),
  scope_mode text not null check (scope_mode in (
    'EXACT_STORY_COMMITS', 'HYBRID_CANDIDATES', 'DEVELOPER_WINDOW',
    'REQUIREMENT_REF_ONLY', 'NO_CODE_EXPECTED', 'GLOBAL_FALLBACK'
  )),
  status text not null default 'PREPARING'
    check (status in ('PREPARING', 'READY', 'DEGRADED', 'FAILED')),
  current_scope_level text not null default 'PRIMARY'
    check (current_scope_level in ('PRIMARY', 'RELATED', 'GLOBAL')),
  algorithm_version text not null,
  ruleset_hash text not null check (ruleset_hash ~ '^(sha256:)?[0-9a-f]{64}$'),
  candidate_manifest_hash text not null check (candidate_manifest_hash ~ '^(sha256:)?[0-9a-f]{64}$'),
  scope_error_code text,
  degradation_reasons text[] not null default array[]::text[],
  candidate_count integer not null default 0 check (candidate_count between 0 and 200),
  strong_count integer not null default 0 check (strong_count between 0 and 200),
  ai_candidate_count integer not null default 0 check (ai_candidate_count between 0 and 200),
  ai_related_count integer not null default 0 check (ai_related_count between 0 and 200),
  ai_uncertain_count integer not null default 0 check (ai_uncertain_count between 0 and 200),
  triage_required_count integer not null default 0 check (triage_required_count between 0 and 200),
  triage_completed_count integer not null default 0 check (triage_completed_count between 0 and 200),
  triage_complete boolean not null default false,
  frozen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (task_id, generation)
);

create table if not exists public.analysis_story_commit_candidate (
  id uuid primary key,
  scope_id uuid not null references public.analysis_story_scope(id) on delete cascade,
  task_id uuid not null references public.analysis_story_task(id) on delete cascade,
  generation integer not null check (generation >= 1),
  commit_id uuid not null references public.analysis_repository_commit(id) on delete restrict,
  tier text not null check (tier in ('STRONG', 'AI_CANDIDATE', 'WEAK', 'EXCLUDED', 'CONFLICT')),
  selection_source text not null check (selection_source in ('RULE', 'MR', 'IDENTITY_WINDOW', 'FALLBACK')),
  rank_score numeric(8,3) not null default 0,
  reason_codes text[] not null check (cardinality(reason_codes) > 0),
  identity_match_type text check (identity_match_type is null or identity_match_type in (
    'VERIFIED_EMAIL', 'VERIFIED_GITLAB', 'NAME_ALIAS', 'NONE', 'AMBIGUOUS'
  )),
  story_match_location text check (story_match_location is null or story_match_location in (
    'COMMIT_TRAILER', 'COMMIT_SUBJECT', 'COMMIT_BODY', 'BRANCH', 'MR', 'NONE'
  )),
  matched_rule_id uuid references public.analysis_attribution_rule(id) on delete restrict,
  effective_status text not null default 'UNKNOWN'
    check (effective_status in ('EFFECTIVE', 'REVERTED', 'PARTIAL', 'UNKNOWN')),
  created_at timestamptz not null default now(),
  unique (task_id, generation, commit_id),
  unique (scope_id, id)
);

create table if not exists public.analysis_commit_diff_archive (
  id uuid primary key default gen_random_uuid(),
  commit_id uuid not null references public.analysis_repository_commit(id) on delete restrict,
  job_id uuid not null references public.analysis_job(id) on delete cascade,
  storage_bucket text not null default 'analysis-commit-diffs'
    check (storage_bucket = 'analysis-commit-diffs'),
  storage_object_prefix text,
  archive_sha256 text check (archive_sha256 is null or archive_sha256 ~ '^(sha256:)?[0-9a-f]{64}$'),
  size_bytes bigint not null default 0 check (size_bytes between 0 and 10485760),
  chunk_count integer not null default 0 check (chunk_count between 0 and 10000),
  status text not null check (status in ('AVAILABLE', 'UNAVAILABLE', 'TOO_LARGE', 'BINARY', 'FAILED')),
  error_code text,
  created_at timestamptz not null default now(),
  unique (job_id, commit_id),
  check ((status = 'AVAILABLE' and storage_object_prefix is not null and archive_sha256 is not null and chunk_count > 0)
      or status <> 'AVAILABLE')
);

create table if not exists public.analysis_story_commit_access (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.analysis_story_task(id) on delete cascade,
  candidate_id uuid not null references public.analysis_story_commit_candidate(id) on delete restrict,
  agent_run_id uuid not null references public.analysis_agent_run(id) on delete cascade,
  agent_node_id uuid references public.analysis_agent_node(id) on delete set null,
  tool_audit_id bigint references public.analysis_tool_audit(id) on delete set null,
  tool_call_id text not null check (btrim(tool_call_id) <> ''),
  access_kind text not null check (access_kind in ('SUMMARY', 'DIFF', 'FILE_LIST')),
  file_path text,
  cursor_value text,
  bytes_returned integer not null default 0 check (bytes_returned between 0 and 65536),
  diff_lines integer not null default 0 check (diff_lines between 0 and 200),
  truncated boolean not null default false,
  archive_sha256 text,
  accessed_at timestamptz not null default now(),
  unique (agent_run_id, candidate_id, tool_call_id, access_kind, file_path, cursor_value)
);

create table if not exists public.analysis_story_commit_relevance_verdict (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.analysis_story_task(id) on delete cascade,
  candidate_id uuid not null references public.analysis_story_commit_candidate(id) on delete restrict,
  agent_run_id uuid not null references public.analysis_agent_run(id) on delete cascade,
  triage_revision integer not null check (triage_revision >= 1),
  verdict text not null check (verdict in ('RELATED', 'UNRELATED', 'UNCERTAIN')),
  reason_codes text[] not null check (cardinality(reason_codes) > 0),
  confidence numeric(4,3) check (confidence is null or confidence between 0 and 1),
  diff_access_ids uuid[] not null default array[]::uuid[],
  summary text not null check (char_length(summary) between 1 and 500),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (agent_run_id, candidate_id, triage_revision)
);

create table if not exists public.analysis_scope_expansion (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.analysis_story_task(id) on delete cascade,
  agent_run_id uuid not null references public.analysis_agent_run(id) on delete cascade,
  agent_node_id uuid references public.analysis_agent_node(id) on delete set null,
  from_level text not null check (from_level in ('PRIMARY', 'RELATED', 'GLOBAL')),
  to_level text not null check (to_level in ('RELATED', 'GLOBAL')),
  reason_code text not null check (reason_code in (
    'DEPENDENCY_LOOKUP', 'CALLER_CALLEE_TRACE', 'CONFIG_OR_SCHEMA_TRACE',
    'TEST_COVERAGE_TRACE', 'CANDIDATES_INSUFFICIENT',
    'CROSS_REPOSITORY_CONTRACT', 'VERIFY_REVERT_OR_REPLACEMENT'
  )),
  created_at timestamptz not null default now(),
  unique (agent_run_id, from_level, to_level, reason_code),
  check ((from_level = 'PRIMARY' and to_level in ('RELATED', 'GLOBAL'))
      or (from_level = 'RELATED' and to_level = 'GLOBAL'))
);

create table if not exists public.analysis_scope_decision_audit (
  id bigserial primary key,
  job_id uuid references public.analysis_job(id) on delete cascade,
  task_id uuid references public.analysis_story_task(id) on delete cascade,
  candidate_id uuid references public.analysis_story_commit_candidate(id) on delete set null,
  decision_type text not null check (decision_type in (
    'IDENTITY_CONFIG', 'AUTO_SELECT', 'AUTO_EXCLUDE', 'AI_RELEVANCE',
    'SCOPE_EXPANSION', 'ADMIN_FEEDBACK', 'RECOMPUTE'
  )),
  source text not null check (source in ('ADMIN', 'RULE_ENGINE', 'AI', 'WORKER', 'DATABASE')),
  actor_id uuid references auth.users(id) on delete set null,
  agent_run_id uuid references public.analysis_agent_run(id) on delete set null,
  reason_codes text[] not null default array[]::text[],
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_analysis_story_scope_task
on public.analysis_story_scope(task_id, generation desc);
create index if not exists idx_story_commit_candidate_scope
on public.analysis_story_commit_candidate(scope_id, tier, rank_score desc, id);
create index if not exists idx_story_commit_candidate_commit
on public.analysis_story_commit_candidate(commit_id);
create index if not exists idx_story_commit_access_task
on public.analysis_story_commit_access(task_id, accessed_at);
create unique index if not exists uq_story_commit_access_idempotency
on public.analysis_story_commit_access(
  agent_run_id,candidate_id,tool_call_id,access_kind,
  coalesce(file_path,''),coalesce(cursor_value,'')
);
create index if not exists idx_story_commit_verdict_task
on public.analysis_story_commit_relevance_verdict(task_id, created_at);
create index if not exists idx_scope_expansion_task
on public.analysis_scope_expansion(task_id, created_at);
create index if not exists idx_scope_decision_audit_task
on public.analysis_scope_decision_audit(task_id, created_at);

-- 冻结后只允许运行态计数、triage 完成度和单调 scope level 变化。
create or replace function public.enforce_analysis_story_scope_freeze()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.frozen_at is not null and (
    new.task_id is distinct from old.task_id
    or new.generation is distinct from old.generation
    or new.scope_mode is distinct from old.scope_mode
    or new.algorithm_version is distinct from old.algorithm_version
    or new.ruleset_hash is distinct from old.ruleset_hash
    or new.candidate_manifest_hash is distinct from old.candidate_manifest_hash
    or new.scope_error_code is distinct from old.scope_error_code
    or new.degradation_reasons is distinct from old.degradation_reasons
    or new.candidate_count is distinct from old.candidate_count
    or new.strong_count is distinct from old.strong_count
    or new.ai_candidate_count is distinct from old.ai_candidate_count
    or new.frozen_at is distinct from old.frozen_at
  ) then
    raise exception 'ANALYSIS_STORY_SCOPE_IMMUTABLE';
  end if;
  return new;
end;
$$;

drop trigger if exists analysis_story_scope_freeze
on public.analysis_story_scope;
create trigger analysis_story_scope_freeze
before update on public.analysis_story_scope
for each row execute function public.enforce_analysis_story_scope_freeze();

create or replace function public.enforce_candidate_freeze()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  if exists (
    select 1 from public.analysis_story_scope scope
    where scope.id = old.scope_id and scope.frozen_at is not null
  ) then
    raise exception 'ANALYSIS_SCOPE_CANDIDATE_IMMUTABLE';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists story_commit_candidate_freeze
on public.analysis_story_commit_candidate;
create trigger story_commit_candidate_freeze
before update or delete on public.analysis_story_commit_candidate
for each row execute function public.enforce_candidate_freeze();

-- 事实表只追加，不允许覆盖“已读”“已判定”“已扩展”和审计历史。
drop trigger if exists story_commit_access_append_only on public.analysis_story_commit_access;
create trigger story_commit_access_append_only before update or delete
on public.analysis_story_commit_access for each row execute function public.reject_append_only_mutation();
drop trigger if exists story_commit_verdict_append_only on public.analysis_story_commit_relevance_verdict;
create trigger story_commit_verdict_append_only before update or delete
on public.analysis_story_commit_relevance_verdict for each row execute function public.reject_append_only_mutation();
drop trigger if exists scope_expansion_append_only on public.analysis_scope_expansion;
create trigger scope_expansion_append_only before update or delete
on public.analysis_scope_expansion for each row execute function public.reject_append_only_mutation();
drop trigger if exists scope_decision_audit_append_only on public.analysis_scope_decision_audit;
create trigger scope_decision_audit_append_only before update or delete
on public.analysis_scope_decision_audit for each row execute function public.reject_append_only_mutation();
drop trigger if exists commit_diff_archive_immutable on public.analysis_commit_diff_archive;
create trigger commit_diff_archive_immutable before update
on public.analysis_commit_diff_archive for each row execute function public.reject_frozen_input_snapshot_update();

-- 私有 diff bucket：没有 authenticated Storage policy，浏览器不能列举或下载。
insert into storage.buckets (id, name, public)
values ('analysis-commit-diffs', 'analysis-commit-diffs', false)
on conflict (id) do update set public = false;

drop policy if exists "authenticated read analysis commit diffs" on storage.objects;
drop policy if exists "authenticated write analysis commit diffs" on storage.objects;

------------------------------------------------------------------------------
-- 6. RLS：全部新增表 fail closed；只有规则目录提供 ADMIN 只读策略。
------------------------------------------------------------------------------

alter table public.analysis_attribution_rule_set enable row level security;
alter table public.analysis_attribution_rule_version enable row level security;
alter table public.analysis_attribution_rule enable row level security;
alter table public.analysis_attribution_rule_test_run enable row level security;
alter table public.analysis_attribution_rule_audit enable row level security;
alter table public.developer_identity enable row level security;
alter table public.developer_git_identity enable row level security;
alter table public.analysis_job_identity_snapshot enable row level security;
alter table public.analysis_job_story_snapshot enable row level security;
alter table public.analysis_repository_commit enable row level security;
alter table public.analysis_commit_file enable row level security;
alter table public.analysis_story_scope enable row level security;
alter table public.analysis_story_commit_candidate enable row level security;
alter table public.analysis_commit_diff_archive enable row level security;
alter table public.analysis_story_commit_access enable row level security;
alter table public.analysis_story_commit_relevance_verdict enable row level security;
alter table public.analysis_scope_expansion enable row level security;
alter table public.analysis_scope_decision_audit enable row level security;

drop policy if exists "admins read attribution rule sets" on public.analysis_attribution_rule_set;
create policy "admins read attribution rule sets" on public.analysis_attribution_rule_set
for select to authenticated using (public.is_admin());
drop policy if exists "admins read attribution rule versions" on public.analysis_attribution_rule_version;
create policy "admins read attribution rule versions" on public.analysis_attribution_rule_version
for select to authenticated using (public.is_admin());
drop policy if exists "admins read attribution rules" on public.analysis_attribution_rule;
create policy "admins read attribution rules" on public.analysis_attribution_rule
for select to authenticated using (public.is_admin());

-- 敏感 fingerprint、commit message/body、Storage locator 和可信写表均只经 RPC。
revoke all on table public.analysis_attribution_rule_test_run from anon, authenticated;
revoke all on table public.analysis_attribution_rule_audit from anon, authenticated;
revoke all on table public.developer_identity from anon, authenticated;
revoke all on table public.developer_git_identity from anon, authenticated;
revoke all on table public.analysis_job_identity_snapshot from anon, authenticated;
revoke all on table public.analysis_job_story_snapshot from anon, authenticated;
revoke all on table public.analysis_repository_commit from anon, authenticated;
revoke all on table public.analysis_commit_file from anon, authenticated;
revoke all on table public.analysis_story_scope from anon, authenticated;
revoke all on table public.analysis_story_commit_candidate from anon, authenticated;
revoke all on table public.analysis_commit_diff_archive from anon, authenticated;
revoke all on table public.analysis_story_commit_access from anon, authenticated;
revoke all on table public.analysis_story_commit_relevance_verdict from anon, authenticated;
revoke all on table public.analysis_scope_expansion from anon, authenticated;
revoke all on table public.analysis_scope_decision_audit from anon, authenticated;

grant select on table public.analysis_attribution_rule_set to authenticated;
grant select on table public.analysis_attribution_rule_version to authenticated;
grant select on table public.analysis_attribution_rule to authenticated;

------------------------------------------------------------------------------
-- 7. 管理 RPC：身份、规则草稿/校验/模拟结果/发布/恢复
------------------------------------------------------------------------------

create or replace function public.admin_list_developer_git_identities()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  perform public.ensure_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'developer_id', developer.id,
      'display_name', developer.display_name,
      'employee_code', developer.employee_code,
      'status', developer.status,
      'revision', developer.revision,
      'git_identity_id', git.id,
      'provider', git.provider,
      'masked_email', git.masked_email,
      'email_domain', git.email_domain,
      'author_name_aliases', git.author_name_aliases,
      'gitlab_username', git.gitlab_username,
      'gitlab_user_id', git.gitlab_user_id,
      'verification_status', git.verification_status,
      'git_revision', git.revision,
      'updated_at', greatest(developer.updated_at, git.updated_at)
    ) order by developer.display_name, git.created_at)
    from public.developer_identity developer
    join public.developer_git_identity git on git.developer_identity_id = developer.id
  ), '[]'::jsonb);
end;
$$;

create or replace function public.admin_upsert_developer_git_identity(
  p_actor_id uuid,
  p_developer_id uuid,
  p_git_identity_id uuid,
  p_display_name text,
  p_employee_code text,
  p_developer_status text,
  p_provider text,
  p_email_fingerprint text,
  p_masked_email text,
  p_email_domain text,
  p_author_name_aliases text[],
  p_gitlab_username text,
  p_gitlab_user_id text,
  p_verification_status text,
  p_expected_revision integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_developer public.developer_identity;
  v_git public.developer_git_identity;
  v_before jsonb;
begin
  perform public.assert_actor_is_admin(p_actor_id);
  if coalesce(btrim(p_display_name), '') = '' then raise exception 'DEVELOPER_DISPLAY_NAME_REQUIRED'; end if;
  if p_developer_status not in ('VERIFIED','UNVERIFIED','CONFLICT','DISABLED') then raise exception 'DEVELOPER_STATUS_INVALID'; end if;
  if p_verification_status not in ('VERIFIED','UNVERIFIED','CONFLICT','DISABLED') then raise exception 'GIT_IDENTITY_STATUS_INVALID'; end if;
  if p_email_fingerprint is not null and p_email_fingerprint !~ '^[0-9a-f]{64}$' then raise exception 'EMAIL_FINGERPRINT_INVALID'; end if;
  if p_masked_email is not null and position('@' in p_masked_email) = 0 then raise exception 'MASKED_EMAIL_INVALID'; end if;

  if p_developer_id is null then
    insert into public.developer_identity(display_name, employee_code, status, created_by, updated_by)
    values (btrim(p_display_name), nullif(btrim(p_employee_code), ''), p_developer_status, p_actor_id, p_actor_id)
    returning * into v_developer;
  else
    select * into v_developer from public.developer_identity where id = p_developer_id for update;
    if v_developer.id is null then raise exception 'DEVELOPER_IDENTITY_NOT_FOUND'; end if;
    if p_expected_revision is not null and v_developer.revision <> p_expected_revision then raise exception 'REVISION_CONFLICT'; end if;
    v_before := to_jsonb(v_developer) - 'created_by' - 'updated_by';
    update public.developer_identity
    set display_name = btrim(p_display_name), employee_code = nullif(btrim(p_employee_code), ''),
        status = p_developer_status, revision = revision + 1, updated_by = p_actor_id, updated_at = now()
    where id = v_developer.id returning * into v_developer;
  end if;

  if p_git_identity_id is null then
    insert into public.developer_git_identity(
      developer_identity_id, provider, email_fingerprint, masked_email, email_domain,
      author_name_aliases, gitlab_username, gitlab_user_id, verification_status,
      created_by, updated_by
    ) values (
      v_developer.id, coalesce(p_provider,'gitlab'), p_email_fingerprint,
      nullif(btrim(p_masked_email), ''), lower(nullif(btrim(p_email_domain), '')),
      coalesce(p_author_name_aliases,array[]::text[]), nullif(btrim(p_gitlab_username),''),
      nullif(btrim(p_gitlab_user_id),''), p_verification_status, p_actor_id, p_actor_id
    ) returning * into v_git;
  else
    select * into v_git from public.developer_git_identity where id = p_git_identity_id for update;
    if v_git.id is null or v_git.developer_identity_id <> v_developer.id then raise exception 'GIT_IDENTITY_NOT_FOUND'; end if;
    if p_expected_revision is not null and v_git.revision <> p_expected_revision then raise exception 'REVISION_CONFLICT'; end if;
    update public.developer_git_identity
    set provider = coalesce(p_provider,'gitlab'), email_fingerprint = p_email_fingerprint,
        masked_email = nullif(btrim(p_masked_email), ''), email_domain = lower(nullif(btrim(p_email_domain), '')),
        author_name_aliases = coalesce(p_author_name_aliases,array[]::text[]),
        gitlab_username = nullif(btrim(p_gitlab_username),''), gitlab_user_id = nullif(btrim(p_gitlab_user_id),''),
        verification_status = p_verification_status, revision = revision + 1,
        updated_by = p_actor_id, updated_at = now()
    where id = v_git.id returning * into v_git;
  end if;

  insert into public.analysis_scope_decision_audit(
    decision_type, source, actor_id, reason_codes, before_state, after_state
  ) values (
    'IDENTITY_CONFIG','ADMIN',p_actor_id,array['IDENTITY_CONFIG_UPDATED'],v_before,
    jsonb_build_object('developer_id',v_developer.id,'git_identity_id',v_git.id,
      'developer_status',v_developer.status,'verification_status',v_git.verification_status,
      'masked_email',v_git.masked_email)
  );
  return jsonb_build_object('developer_id',v_developer.id,'git_identity_id',v_git.id,
    'developer_revision',v_developer.revision,'git_revision',v_git.revision);
exception when unique_violation then
  raise exception 'EMAIL_FINGERPRINT_CONFLICT';
end;
$$;

create or replace function public.admin_list_attribution_rule_sets()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  perform public.ensure_admin();
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', rule_set.id, 'rule_set_code', rule_set.rule_set_code,
    'display_name', rule_set.display_name, 'description', rule_set.description,
    'enabled', rule_set.enabled, 'current_version_id', version.id,
    'current_version', version.version, 'ruleset_hash', version.ruleset_hash,
    'published_at', version.published_at,
    'rules', public.attribution_rule_version_config(version.id)->'rules'
  ) order by rule_set.rule_set_code)
  from public.analysis_attribution_rule_set rule_set
  left join public.analysis_attribution_rule_version version
    on version.id = rule_set.current_published_version_id), '[]'::jsonb);
end;
$$;

create or replace function public.admin_create_attribution_rule_draft(p_source_version_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source public.analysis_attribution_rule_version;
  v_id uuid;
  v_next integer;
  v_actor uuid := auth.uid();
begin
  perform public.ensure_admin();
  select * into v_source from public.analysis_attribution_rule_version
  where id = p_source_version_id and status = 'PUBLISHED';
  if v_source.id is null then raise exception 'PUBLISHED_RULE_VERSION_NOT_FOUND'; end if;
  select coalesce(max(version),0)+1 into v_next
  from public.analysis_attribution_rule_version where rule_set_id = v_source.rule_set_id;
  insert into public.analysis_attribution_rule_version(
    rule_set_id,version,status,revision,schema_version,canonical_config,source_version_id,created_by
  ) values (v_source.rule_set_id,v_next,'DRAFT',1,1,v_source.canonical_config,v_source.id,v_actor)
  returning id into v_id;
  insert into public.analysis_attribution_rule(
    version_id,rule_code,display_name,description,priority,enabled,capability,
    condition_tree,action_type,reason_code,system_locked,sort_order
  ) select v_id,rule_code,display_name,description,priority,enabled,capability,
    condition_tree,action_type,reason_code,system_locked,sort_order
  from public.analysis_attribution_rule where version_id = v_source.id;
  insert into public.analysis_attribution_rule_audit(rule_set_id,version_id,action,actor_id,after_state)
  values (v_source.rule_set_id,v_id,'CREATE_DRAFT',v_actor,jsonb_build_object('source_version_id',v_source.id));
  return v_id;
end;
$$;

create or replace function public.admin_save_attribution_rule_draft(
  p_draft_version_id uuid,
  p_expected_revision integer,
  p_rules jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version public.analysis_attribution_rule_version;
  v_rule jsonb;
  v_existing public.analysis_attribution_rule;
  v_actor uuid := auth.uid();
  v_before jsonb;
  v_field text;
  v_operator text;
begin
  perform public.ensure_admin();
  select * into v_version from public.analysis_attribution_rule_version
  where id = p_draft_version_id for update;
  if v_version.id is null or v_version.status not in ('DRAFT','VALIDATED') then raise exception 'RULE_DRAFT_NOT_EDITABLE'; end if;
  if v_version.revision <> p_expected_revision then raise exception 'REVISION_CONFLICT'; end if;
  if jsonb_typeof(p_rules) <> 'array' or jsonb_array_length(p_rules) > 100 then raise exception 'RULE_LIST_INVALID'; end if;
  v_before := public.attribution_rule_version_config(v_version.id);

  -- 系统锁定规则必须逐字保持；草稿保存只替换管理员自定义候选/降权规则。
  for v_rule in select * from jsonb_array_elements(p_rules)
  loop
    select * into v_existing from public.analysis_attribution_rule
    where version_id = v_version.id and rule_code = v_rule->>'ruleCode';
    if v_existing.system_locked then
      if v_existing.action_type <> v_rule->'action'->>'type'
         or v_existing.reason_code <> v_rule->'action'->>'reasonCode'
         or v_existing.condition_tree <> v_rule->'when'
         or v_existing.priority <> (v_rule->>'priority')::integer then
        raise exception 'SYSTEM_RULE_IMMUTABLE';
      end if;
    else
      if coalesce(v_rule->'action'->>'type','') not in ('ADD_AI_CANDIDATE','DOWNRANK_CANDIDATE') then
        raise exception 'CUSTOM_RULE_ACTION_FORBIDDEN';
      end if;
      if coalesce(v_rule->>'ruleCode','') !~ '^ATTR_[A-Z0-9_]{3,80}$' then raise exception 'RULE_CODE_INVALID'; end if;
      for v_field,v_operator in
        select item->>'field',item->>'operator' from jsonb_array_elements(coalesce(v_rule->'when'->'all','[]'::jsonb)) item
        union all
        select item->>'field',item->>'operator' from jsonb_array_elements(coalesce(v_rule->'when'->'any','[]'::jsonb)) item
      loop
        if v_field not in (
          'story.current_code','story.other_codes','commit.structured_story_ids','commit.story_tokens',
          'commit.body_story_tokens','commit.sha','commit.parent_shas','commit.reachability',
          'commit.author_identity','commit.committed_at','commit.files','commit.is_revert',
          'commit.reverted_sha','commit.is_bot','commit.is_generated','commit.mr_membership',
          'mr.capability_status','mr.structured_story_ids','repository.enumeration_status'
        ) then raise exception 'RULE_FIELD_FORBIDDEN'; end if;
        if v_operator not in (
          'EXACT_CURRENT_STORY_TOKEN','EXACT_OTHER_STORY_TOKEN','EQUALS','IN_ENUM',
          'VERIFIED_IDENTITY_MATCH','WITHIN_FROZEN_WINDOW','MODULE_OVERLAP',
          'BELONGS_TO_EXPLICIT_MR','REVERTS_RELATED_COMMIT','IS_TRUE','IS_FALSE'
        ) then raise exception 'RULE_OPERATOR_FORBIDDEN'; end if;
      end loop;
    end if;
  end loop;

  delete from public.analysis_attribution_rule where version_id = v_version.id and not system_locked;
  for v_rule in select * from jsonb_array_elements(p_rules)
  loop
    if not coalesce((v_rule->>'systemLocked')::boolean,false) then
      insert into public.analysis_attribution_rule(
        version_id,rule_code,display_name,description,priority,enabled,capability,
        condition_tree,action_type,reason_code,system_locked,sort_order
      ) values (
        v_version.id,v_rule->>'ruleCode',v_rule->>'displayName',v_rule->>'description',
        (v_rule->>'priority')::integer,coalesce((v_rule->>'enabled')::boolean,true),
        coalesce(v_rule->>'capability','GIT_BASE'),v_rule->'when',v_rule->'action'->>'type',
        v_rule->'action'->>'reasonCode',false,coalesce((v_rule->>'sortOrder')::integer,0)
      );
    end if;
  end loop;
  update public.analysis_attribution_rule_version
  set status='DRAFT',revision=revision+1,canonical_config=public.attribution_rule_version_config(id),
      ruleset_hash=null,validated_at=null
  where id=v_version.id returning revision into p_expected_revision;
  insert into public.analysis_attribution_rule_audit(rule_set_id,version_id,action,actor_id,before_state,after_state)
  values(v_version.rule_set_id,v_version.id,'SAVE_DRAFT',v_actor,v_before,public.attribution_rule_version_config(v_version.id));
  return p_expected_revision;
end;
$$;

create or replace function public.admin_validate_attribution_rule_draft(p_draft_version_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version public.analysis_attribution_rule_version;
  v_hash text;
  v_actor uuid := auth.uid();
begin
  perform public.ensure_admin();
  select * into v_version from public.analysis_attribution_rule_version where id=p_draft_version_id for update;
  if v_version.id is null or v_version.status not in ('DRAFT','VALIDATED') then raise exception 'RULE_DRAFT_NOT_EDITABLE'; end if;
  if not exists(select 1 from public.analysis_attribution_rule where version_id=v_version.id and enabled) then raise exception 'NO_ENABLED_RULES'; end if;
  if exists(select 1 from public.analysis_attribution_rule where version_id=v_version.id and not system_locked
    and (priority > 500 or action_type not in ('ADD_AI_CANDIDATE','DOWNRANK_CANDIDATE'))) then
    raise exception 'CUSTOM_RULE_SAFETY_BOUNDARY';
  end if;
  v_hash := public.attribution_rule_version_hash(v_version.id);
  update public.analysis_attribution_rule_version
  set status='VALIDATED', canonical_config=public.attribution_rule_version_config(id),
      ruleset_hash=v_hash, validated_at=now()
  where id=v_version.id;
  insert into public.analysis_attribution_rule_audit(rule_set_id,version_id,action,actor_id,after_state)
  values(v_version.rule_set_id,v_version.id,'VALIDATE',v_actor,jsonb_build_object('ruleset_hash',v_hash));
  return jsonb_build_object('valid',true,'ruleset_hash',v_hash,'revision',v_version.revision);
end;
$$;

-- 模拟由受信任服务执行并写回结果；浏览器无权自报 passed=true。
create or replace function public.admin_record_attribution_rule_test_run(
  p_actor_id uuid,
  p_version_id uuid,
  p_sample_set_id text,
  p_sample_set_hash text,
  p_metrics jsonb,
  p_diff_summary jsonb,
  p_passed boolean,
  p_failure_code text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version public.analysis_attribution_rule_version;
  v_id uuid;
begin
  perform public.assert_actor_is_admin(p_actor_id);
  select * into v_version from public.analysis_attribution_rule_version where id=p_version_id;
  if v_version.id is null or v_version.status <> 'VALIDATED' then raise exception 'RULE_VERSION_NOT_VALIDATED'; end if;
  if p_sample_set_hash !~ '^(sha256:)?[0-9a-f]{64}$' then raise exception 'SAMPLE_SET_HASH_INVALID'; end if;
  if p_passed and coalesce((p_metrics->>'strong_false_positive_count')::integer,0) <> 0 then
    raise exception 'GOLD_SET_FALSE_POSITIVE';
  end if;
  insert into public.analysis_attribution_rule_test_run(
    version_id,sample_set_id,sample_set_hash,metrics,diff_summary,passed,failure_code,executed_by
  ) values (p_version_id,p_sample_set_id,p_sample_set_hash,coalesce(p_metrics,'{}'),
    coalesce(p_diff_summary,'{}'),p_passed,p_failure_code,p_actor_id) returning id into v_id;
  insert into public.analysis_attribution_rule_audit(rule_set_id,version_id,action,actor_id,after_state)
  values(v_version.rule_set_id,v_version.id,'SIMULATE',p_actor_id,jsonb_build_object('test_run_id',v_id,'passed',p_passed));
  return v_id;
end;
$$;

create or replace function public.admin_publish_attribution_rule_version(
  p_draft_version_id uuid,
  p_expected_revision integer,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version public.analysis_attribution_rule_version;
  v_actor uuid := auth.uid();
  v_hash text;
begin
  perform public.ensure_admin();
  select * into v_version from public.analysis_attribution_rule_version where id=p_draft_version_id for update;
  if v_version.id is null or v_version.status <> 'VALIDATED' then raise exception 'RULE_VERSION_NOT_VALIDATED'; end if;
  if v_version.revision <> p_expected_revision then raise exception 'REVISION_CONFLICT'; end if;
  if coalesce(btrim(p_reason),'')='' then raise exception 'PUBLISH_REASON_REQUIRED'; end if;
  if not exists(select 1 from public.analysis_attribution_rule_test_run test
    where test.version_id=v_version.id and test.passed order by test.executed_at desc limit 1) then
    raise exception 'RULE_SIMULATION_REQUIRED';
  end if;
  v_hash := public.attribution_rule_version_hash(v_version.id);
  if v_hash is distinct from v_version.ruleset_hash then raise exception 'ATTRIBUTION_RULESET_MISMATCH'; end if;
  update public.analysis_attribution_rule_version
  set status='PUBLISHED',published_by=v_actor,published_at=now(),publish_reason=btrim(p_reason)
  where id=v_version.id;
  update public.analysis_attribution_rule_set
  set current_published_version_id=v_version.id,updated_at=now()
  where id=v_version.rule_set_id;
  insert into public.analysis_attribution_rule_audit(rule_set_id,version_id,action,actor_id,reason,after_state)
  values(v_version.rule_set_id,v_version.id,'PUBLISH',v_actor,btrim(p_reason),jsonb_build_object('ruleset_hash',v_hash));
  return jsonb_build_object('version_id',v_version.id,'version',v_version.version,'ruleset_hash',v_hash);
end;
$$;

create or replace function public.admin_restore_attribution_rule_version(p_source_version_id uuid,p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source public.analysis_attribution_rule_version;
  v_actor uuid:=auth.uid(); v_id uuid; v_next integer;
begin
  perform public.ensure_admin();
  if coalesce(btrim(p_reason),'')='' then raise exception 'RESTORE_REASON_REQUIRED'; end if;
  select * into v_source from public.analysis_attribution_rule_version where id=p_source_version_id and status='PUBLISHED';
  if v_source.id is null then raise exception 'PUBLISHED_RULE_VERSION_NOT_FOUND'; end if;
  select coalesce(max(version),0)+1 into v_next from public.analysis_attribution_rule_version where rule_set_id=v_source.rule_set_id;
  insert into public.analysis_attribution_rule_version(
    rule_set_id,version,status,revision,schema_version,canonical_config,ruleset_hash,
    source_version_id,created_by,validated_at,published_by,published_at,publish_reason
  ) values(v_source.rule_set_id,v_next,'PUBLISHED',1,1,v_source.canonical_config,v_source.ruleset_hash,
    v_source.id,v_actor,now(),v_actor,now(),btrim(p_reason)) returning id into v_id;
  insert into public.analysis_attribution_rule(
    version_id,rule_code,display_name,description,priority,enabled,capability,
    condition_tree,action_type,reason_code,system_locked,sort_order
  ) select v_id,rule_code,display_name,description,priority,enabled,capability,
    condition_tree,action_type,reason_code,system_locked,sort_order
  from public.analysis_attribution_rule where version_id=v_source.id;
  update public.analysis_attribution_rule_set set current_published_version_id=v_id,updated_at=now()
  where id=v_source.rule_set_id;
  insert into public.analysis_attribution_rule_audit(rule_set_id,version_id,action,actor_id,reason,after_state)
  values(v_source.rule_set_id,v_id,'RESTORE',v_actor,btrim(p_reason),jsonb_build_object('source_version_id',v_source.id));
  return jsonb_build_object('version_id',v_id,'version',v_next,'ruleset_hash',v_source.ruleset_hash);
end;
$$;

------------------------------------------------------------------------------
-- 8. Worker fencing helpers 与冻结/manifest/scope RPC
------------------------------------------------------------------------------

create or replace function public.assert_analysis_scope_job_writer(
  p_job_id uuid,
  p_worker_id text,
  p_allowed_statuses text[]
)
returns public.analysis_job
language plpgsql
security definer
set search_path = public
as $$
declare v_job public.analysis_job;
begin
  select * into v_job from public.analysis_job where id=p_job_id for update;
  if v_job.id is null then raise exception 'JOB_NOT_FOUND'; end if;
  if v_job.analysis_context_version <> 2 or v_job.required_worker_scope_version <> 2 then raise exception 'STORY_COMMIT_SCOPE_V2_REQUIRED'; end if;
  if v_job.worker_id is distinct from p_worker_id then raise exception 'JOB_LEASE_LOST'; end if;
  if not (v_job.status = any(p_allowed_statuses)) then raise exception 'JOB_SCOPE_STATE_INVALID'; end if;
  return v_job;
end;
$$;

create or replace function public.assert_analysis_scope_task_claim(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid
)
returns public.analysis_story_task
language plpgsql
security definer
set search_path = public
as $$
declare v_task public.analysis_story_task;
begin
  select * into v_task from public.analysis_story_task where id=p_task_id for update;
  if v_task.id is null then raise exception 'TASK_NOT_FOUND'; end if;
  if v_task.worker_id is distinct from p_worker_id
     or v_task.claim_token_digest is distinct from public.agent_claim_token_digest(p_claim_token)
     or v_task.lease_expires_at is null or v_task.lease_expires_at < now()
     or v_task.agent_status <> 'RUNNING' then raise exception 'TASK_LEASE_LOST'; end if;
  return v_task;
end;
$$;

create or replace function public.freeze_analysis_job_scope_inputs(p_job_id uuid,p_worker_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_job public.analysis_job; v_version public.analysis_attribution_rule_version;
  v_story_hash text; v_identity_hash text;
begin
  v_job := public.assert_analysis_scope_job_writer(p_job_id,p_worker_id,array['PREPARING_CODE','PREPARING_SCOPE']);
  select version.* into v_version
  from public.analysis_attribution_rule_set rule_set
  join public.analysis_attribution_rule_version version on version.id=rule_set.current_published_version_id
  where rule_set.rule_set_code='STORY_COMMIT_ATTRIBUTION' and rule_set.enabled and version.status='PUBLISHED';
  if v_version.id is null then raise exception 'PUBLISHED_ATTRIBUTION_RULESET_REQUIRED'; end if;
  if v_version.ruleset_hash is distinct from public.attribution_rule_version_hash(v_version.id) then
    raise exception 'ATTRIBUTION_RULESET_MISMATCH';
  end if;
  if exists(select 1 from public.analysis_job_story_snapshot where job_id=p_job_id) then
    select story_input_catalog_hash,identity_snapshot_hash into v_story_hash,v_identity_hash
    from public.analysis_job where id=p_job_id;
    return jsonb_build_object('story_input_catalog_hash',v_story_hash,'identity_snapshot_hash',v_identity_hash,
      'rule_version_id',v_version.id,'ruleset_hash',v_version.ruleset_hash,'idempotent',true);
  end if;

  insert into public.analysis_job_story_snapshot(
    job_id,story_id,story_code,story_name,owners_text,normalized_developer_ids,project_name,application_name,
    release_window,requirement_context,input_hash
  ) select p_job_id,story.id,story.story_code,story.story_name,story.owners_text,
    array(
      select distinct developer.id
      from public.developer_identity developer
      where developer.status='VERIFIED' and exists(
        select 1 from regexp_split_to_table(story.owners_text,'[，,、；;]') as owner(owner_token)
        where btrim(owner.owner_token)=developer.display_name
           or (developer.employee_code is not null and btrim(owner.owner_token) in (
             developer.display_name||'（'||developer.employee_code||'）',
             developer.display_name||'('||developer.employee_code||')'
           ))
      )
      order by developer.id
    ),story.project_name,story.application_name,story.release_window,
    jsonb_strip_nulls(jsonb_build_object(
      'detailed_description',story.source_data->'详细描述',
      'related_features',story.source_data->'关联特性',
      'source_status',story.source_status
    )),
    encode(digest(convert_to(concat_ws(E'\n',story.story_code,story.story_name,story.owners_text,
      coalesce(story.project_name,''),coalesce(story.application_name,''),coalesce(story.release_window,''),
      jsonb_strip_nulls(jsonb_build_object('detailed_description',story.source_data->'详细描述',
        'related_features',story.source_data->'关联特性','source_status',story.source_status))::text),'UTF8'),'sha256'),'hex')
  from public.analysis_story_task task join public.review_story story on story.id=task.story_id
  where task.job_id=p_job_id order by story.story_code;

  insert into public.analysis_job_identity_snapshot(
    job_id,source_developer_identity_id,source_git_identity_id,developer_display_name,
    employee_code,identity_status,provider,email_fingerprint,masked_email,email_domain,
    author_name_aliases,gitlab_username,gitlab_user_id,verification_status,snapshot_hash
  ) select p_job_id,developer.id,git.id,developer.display_name,developer.employee_code,
    developer.status,git.provider,git.email_fingerprint,git.masked_email,git.email_domain,
    git.author_name_aliases,git.gitlab_username,git.gitlab_user_id,git.verification_status,
    encode(digest(convert_to(concat_ws(E'\n',developer.id::text,git.id::text,developer.display_name,
      coalesce(developer.employee_code,''),developer.status,git.provider,coalesce(git.email_fingerprint,''),
      coalesce(git.masked_email,''),coalesce(git.email_domain,''),array_to_string(git.author_name_aliases,E'\n'),
      coalesce(git.gitlab_username,''),coalesce(git.gitlab_user_id,''),git.verification_status),'UTF8'),'sha256'),'hex')
  from public.developer_identity developer
  join public.developer_git_identity git on git.developer_identity_id=developer.id
  where developer.status <> 'DISABLED' and git.verification_status <> 'DISABLED'
    and git.valid_from <= now() and (git.valid_until is null or git.valid_until > now())
  order by developer.id,git.id;

  select encode(digest(convert_to(coalesce(string_agg(input_hash,E'\n' order by story_code),'empty'),'UTF8'),'sha256'),'hex')
  into v_story_hash from public.analysis_job_story_snapshot where job_id=p_job_id;
  select encode(digest(convert_to(coalesce(string_agg(snapshot_hash,E'\n' order by source_git_identity_id),'empty'),'UTF8'),'sha256'),'hex')
  into v_identity_hash from public.analysis_job_identity_snapshot where job_id=p_job_id;

  update public.analysis_job set status='PREPARING_SCOPE',scope_status='PREPARING',scope_requested_at=coalesce(scope_requested_at,now()),
    attribution_rule_version_id=v_version.id,ruleset_hash=v_version.ruleset_hash,
    story_input_catalog_hash=v_story_hash,identity_snapshot_hash=v_identity_hash,
    attribution_algorithm_version=coalesce(attribution_algorithm_version,'story-attribution-v2')
  where id=p_job_id;
  return jsonb_build_object('story_input_catalog_hash',v_story_hash,'identity_snapshot_hash',v_identity_hash,
    'rule_version_id',v_version.id,'ruleset_hash',v_version.ruleset_hash,'idempotent',false);
end;
$$;

create or replace function public.save_analysis_repository_commit_manifest(
  p_job_id uuid,
  p_worker_id text,
  p_repository_name text,
  p_manifest jsonb,
  p_manifest_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_job public.analysis_job; v_snapshot public.analysis_repository_snapshot;
  v_commits jsonb; v_commit jsonb; v_file jsonb; v_commit_id uuid;
  v_count integer; v_enumeration text; v_head text; v_existing_hash text;
begin
  v_job := public.assert_analysis_scope_job_writer(p_job_id,p_worker_id,array['PREPARING_CODE','PREPARING_SCOPE']);
  if p_repository_name not in ('kdmanage-backend','kdmanage-frontend','tmanage-backend','tmanage-frontend') then raise exception 'REPOSITORY_NOT_ALLOWED'; end if;
  if p_manifest_hash !~ '^(sha256:)?[0-9a-f]{64}$' then raise exception 'MANIFEST_HASH_INVALID'; end if;
  if jsonb_typeof(p_manifest) <> 'object' then raise exception 'COMMIT_MANIFEST_INVALID'; end if;
  v_commits := coalesce(p_manifest->'commits','[]'::jsonb);
  if jsonb_typeof(v_commits) <> 'array' then raise exception 'COMMIT_MANIFEST_INVALID'; end if;
  v_count := jsonb_array_length(v_commits);
  v_enumeration := p_manifest->>'enumeration_status';
  if v_enumeration='COMPLETE' and (v_count > 2000 or v_count <> coalesce((p_manifest->>'commit_count')::integer,v_count)) then
    raise exception 'COMMIT_MANIFEST_COUNT_MISMATCH';
  end if;
  if v_enumeration <> 'COMPLETE' and v_count <> 0 then raise exception 'INCOMPLETE_RANGE_MUST_NOT_STORE_PARTIAL_MANIFEST'; end if;
  v_head := lower(p_manifest->>'head_sha');
  if v_head !~ '^[0-9a-f]{40}([0-9a-f]{24})?$' then raise exception 'HEAD_SHA_INVALID'; end if;

  select * into v_snapshot from public.analysis_repository_snapshot
  where job_id=p_job_id and repository_name=p_repository_name for update;
  if v_snapshot.id is not null and v_snapshot.commit_manifest_hash=p_manifest_hash
     and v_snapshot.enumeration_status=v_enumeration then
    return jsonb_build_object('snapshot_id',v_snapshot.id,'commit_count',v_snapshot.commit_count,'idempotent',true);
  end if;
  if exists(select 1 from public.analysis_story_scope scope join public.analysis_story_task task on task.id=scope.task_id
    where task.job_id=p_job_id and scope.frozen_at is not null) then raise exception 'ANALYSIS_SCOPE_ALREADY_FROZEN'; end if;

  if v_snapshot.id is null then
    insert into public.analysis_repository_snapshot(job_id,repository_name,requested_branch,commit_sha,commit_subject)
    values(p_job_id,p_repository_name,v_job.requested_branch,v_head,nullif(p_manifest->>'head_subject',''))
    returning * into v_snapshot;
  else
    delete from public.analysis_repository_commit where snapshot_id=v_snapshot.id;
  end if;

  update public.analysis_repository_snapshot set
    commit_sha=v_head,head_sha=v_head,base_sha=nullif(lower(p_manifest->>'base_sha'),''),
    range_source=coalesce(p_manifest->>'range_source','UNAVAILABLE'),
    range_start_at=(p_manifest->>'range_start_at')::timestamptz,
    range_end_at=(p_manifest->>'range_end_at')::timestamptz,
    head_resolved_at=(p_manifest->>'head_resolved_at')::timestamptz,
    ancestry_status=coalesce(p_manifest->>'ancestry_status','UNKNOWN'),
    enumeration_status=v_enumeration,commit_count=v_count,commit_manifest_hash=p_manifest_hash,
    prepared_at=now()
  where id=v_snapshot.id returning * into v_snapshot;

  for v_commit in select * from jsonb_array_elements(v_commits)
  loop
    insert into public.analysis_repository_commit(
      snapshot_id,sha,sequence_no,parent_shas,tree_sha,author_name,author_email_fingerprint,
      author_email_masked,authored_at,committer_name,committer_email_fingerprint,
      committer_email_masked,committed_at,subject,message_body,trailers,structured_story_ids,
      coauthor_email_fingerprints,is_merge,is_revert,reverted_sha,patch_id,files_changed,
      additions,deletions,binary_files,effective_status
    ) values (
      v_snapshot.id,lower(v_commit->>'sha'),(v_commit->>'sequence_no')::integer,
      array(select lower(value) from jsonb_array_elements_text(coalesce(v_commit->'parent_shas','[]'::jsonb)) value),
      nullif(lower(v_commit->>'tree_sha'),''),v_commit->>'author_name',nullif(v_commit->>'author_email_fingerprint',''),
      nullif(v_commit->>'author_email_masked',''),nullif(v_commit->>'authored_at','')::timestamptz,
      nullif(v_commit->>'committer_name',''),nullif(v_commit->>'committer_email_fingerprint',''),
      nullif(v_commit->>'committer_email_masked',''),(v_commit->>'committed_at')::timestamptz,
      v_commit->>'subject',left(nullif(v_commit->>'message_body',''),32768),coalesce(v_commit->'trailers','{}'::jsonb),
      array(select value from jsonb_array_elements_text(coalesce(v_commit->'structured_story_ids','[]'::jsonb)) value),
      array(select value from jsonb_array_elements_text(coalesce(v_commit->'coauthor_email_fingerprints','[]'::jsonb)) value),
      coalesce((v_commit->>'is_merge')::boolean,false),coalesce((v_commit->>'is_revert')::boolean,false),
      nullif(lower(v_commit->>'reverted_sha'),''),nullif(v_commit->>'patch_id',''),
      coalesce((v_commit->>'files_changed')::integer,0),coalesce((v_commit->>'additions')::integer,0),
      coalesce((v_commit->>'deletions')::integer,0),coalesce((v_commit->>'binary_files')::integer,0),
      coalesce(v_commit->>'effective_status','UNKNOWN')
    ) returning id into v_commit_id;
    for v_file in select * from jsonb_array_elements(coalesce(v_commit->'files','[]'::jsonb))
    loop
      insert into public.analysis_commit_file(commit_id,file_order,path,old_path,change_type,additions,deletions,is_binary)
      values(v_commit_id,(v_file->>'file_order')::integer,v_file->>'path',nullif(v_file->>'old_path',''),
        v_file->>'change_type',nullif(v_file->>'additions','')::integer,nullif(v_file->>'deletions','')::integer,
        coalesce((v_file->>'binary')::boolean,false));
    end loop;
  end loop;

  select encode(digest(convert_to(coalesce(string_agg(repository_name||':'||commit_manifest_hash,E'\n' order by repository_name),'empty'),'UTF8'),'sha256'),'hex')
  into v_existing_hash from public.analysis_repository_snapshot where job_id=p_job_id and commit_manifest_hash is not null;
  update public.analysis_job set repository_manifest_hash=v_existing_hash where id=p_job_id;
  return jsonb_build_object('snapshot_id',v_snapshot.id,'commit_count',v_count,'idempotent',false);
end;
$$;

create or replace function public.save_analysis_commit_diff_archives(
  p_job_id uuid,
  p_worker_id text,
  p_archives jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.analysis_job; v_item jsonb; v_commit_id uuid; v_snapshot public.analysis_repository_snapshot;
  v_commit_sha text; v_prefix text; v_existing public.analysis_commit_diff_archive; v_count integer:=0;
begin
  v_job:=public.assert_analysis_scope_job_writer(p_job_id,p_worker_id,array['PREPARING_SCOPE']);
  if jsonb_typeof(p_archives)<>'array' or jsonb_array_length(p_archives)>200 then raise exception 'DIFF_ARCHIVE_LIST_INVALID'; end if;
  for v_item in select * from jsonb_array_elements(p_archives)
  loop
    select repo_commit.id into v_commit_id
    from public.analysis_repository_commit repo_commit
    join public.analysis_repository_snapshot snapshot on snapshot.id=repo_commit.snapshot_id
    where snapshot.job_id=p_job_id and snapshot.repository_name=v_item->>'repository_name'
      and repo_commit.sha=lower(v_item->>'sha');
    select snapshot.* into v_snapshot
    from public.analysis_repository_snapshot snapshot
    join public.analysis_repository_commit repo_commit on repo_commit.snapshot_id=snapshot.id
    where repo_commit.id=v_commit_id;
    if v_commit_id is null then raise exception 'DIFF_COMMIT_NOT_IN_JOB_MANIFEST'; end if;
    v_commit_sha:=lower(v_item->>'sha');
    v_prefix:=p_job_id::text||'/'||v_snapshot.repository_name||'/'||v_commit_sha||'/'||v_snapshot.commit_manifest_hash||'/';
    if v_item->>'status'='AVAILABLE' and (
      v_item->>'storage_object_prefix' is null
      or left(v_item->>'storage_object_prefix',length(v_prefix))<>v_prefix
      or coalesce(v_item->>'archive_sha256','') !~ '^(sha256:)?[0-9a-f]{64}$'
      or coalesce((v_item->>'size_bytes')::bigint,0)<=0
      or coalesce((v_item->>'chunk_count')::integer,0)<=0
    ) then raise exception 'DIFF_ARCHIVE_METADATA_INVALID'; end if;
    select * into v_existing from public.analysis_commit_diff_archive
    where job_id=p_job_id and commit_id=v_commit_id;
    if v_existing.id is not null then
      if v_existing.status is distinct from v_item->>'status'
         or v_existing.archive_sha256 is distinct from nullif(v_item->>'archive_sha256','')
         or v_existing.storage_object_prefix is distinct from nullif(v_item->>'storage_object_prefix','') then
        raise exception 'DIFF_ARCHIVE_IMMUTABLE';
      end if;
    else
      insert into public.analysis_commit_diff_archive(
        commit_id,job_id,storage_object_prefix,archive_sha256,size_bytes,chunk_count,status,error_code
      ) values(v_commit_id,p_job_id,nullif(v_item->>'storage_object_prefix',''),nullif(v_item->>'archive_sha256',''),
        coalesce((v_item->>'size_bytes')::bigint,0),coalesce((v_item->>'chunk_count')::integer,0),
        v_item->>'status',nullif(v_item->>'error_code',''));
    end if;
    v_count:=v_count+1;
  end loop;
  update public.analysis_repository_snapshot snapshot set
    diff_archive_status=case
      when exists(select 1 from public.analysis_commit_diff_archive archive
        join public.analysis_repository_commit repo_commit on repo_commit.id=archive.commit_id
        where repo_commit.snapshot_id=snapshot.id and archive.status in('FAILED','UNAVAILABLE')) then 'PARTIAL'
      when exists(select 1 from public.analysis_commit_diff_archive archive
        join public.analysis_repository_commit repo_commit on repo_commit.id=archive.commit_id
        where repo_commit.snapshot_id=snapshot.id and archive.status='AVAILABLE') then 'READY'
      else diff_archive_status end,
    diff_archive_bytes=(select coalesce(sum(archive.size_bytes),0) from public.analysis_commit_diff_archive archive
      join public.analysis_repository_commit repo_commit on repo_commit.id=archive.commit_id where repo_commit.snapshot_id=snapshot.id)
  where snapshot.job_id=p_job_id;
  return jsonb_build_object('archive_count',v_count);
end;
$$;

create or replace function public.save_analysis_story_scopes(
  p_job_id uuid,
  p_worker_id text,
  p_algorithm_version text,
  p_scopes jsonb,
  p_scope_catalog_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.analysis_job; v_scope_input jsonb; v_candidate jsonb;
  v_scope_id uuid; v_task_id uuid; v_commit_id uuid; v_rule_id uuid;
  v_generation integer; v_scope_count integer:=0;
begin
  v_job := public.assert_analysis_scope_job_writer(p_job_id,p_worker_id,array['PREPARING_SCOPE']);
  if p_algorithm_version is distinct from v_job.attribution_algorithm_version then raise exception 'ATTRIBUTION_ALGORITHM_MISMATCH'; end if;
  if p_scope_catalog_hash !~ '^(sha256:)?[0-9a-f]{64}$' or jsonb_typeof(p_scopes)<>'array' then raise exception 'SCOPE_MANIFEST_INVALID'; end if;
  if jsonb_array_length(p_scopes) <> (select count(*) from public.analysis_story_task where job_id=p_job_id) then
    raise exception 'ALL_STORY_SCOPES_REQUIRED';
  end if;

  for v_scope_input in select * from jsonb_array_elements(p_scopes)
  loop
    v_task_id := (v_scope_input->>'task_id')::uuid;
    v_generation := coalesce((v_scope_input->>'generation')::integer,1);
    if not exists(select 1 from public.analysis_story_task where id=v_task_id and job_id=p_job_id) then raise exception 'SCOPE_TASK_JOB_MISMATCH'; end if;
    if jsonb_array_length(coalesce(v_scope_input->'candidates','[]'::jsonb)) > 200 then raise exception 'STORY_CANDIDATE_LIMIT_EXCEEDED'; end if;
    select id into v_scope_id from public.analysis_story_scope where task_id=v_task_id and generation=v_generation for update;
    if v_scope_id is not null and exists(select 1 from public.analysis_story_scope where id=v_scope_id and frozen_at is not null) then
      raise exception 'ANALYSIS_SCOPE_ALREADY_FROZEN';
    end if;
    if v_scope_id is not null then delete from public.analysis_story_scope where id=v_scope_id; end if;
    insert into public.analysis_story_scope(
      task_id,generation,scope_mode,status,current_scope_level,algorithm_version,ruleset_hash,
      candidate_manifest_hash,scope_error_code,degradation_reasons
    ) values (
      v_task_id,v_generation,v_scope_input->>'scope_mode',coalesce(v_scope_input->>'status','PREPARING'),
      coalesce(v_scope_input->>'current_scope_level',case when v_scope_input->>'scope_mode'='GLOBAL_FALLBACK' then 'GLOBAL' else 'PRIMARY' end),
      p_algorithm_version,v_job.ruleset_hash,v_scope_input->>'candidate_manifest_hash',
      nullif(v_scope_input->>'scope_error_code',''),
      array(select value from jsonb_array_elements_text(coalesce(v_scope_input->'degradation_reasons','[]'::jsonb)) value)
    ) returning id into v_scope_id;

    for v_candidate in select * from jsonb_array_elements(coalesce(v_scope_input->'candidates','[]'::jsonb))
    loop
      select repo_commit.id into v_commit_id
      from public.analysis_repository_commit repo_commit
      join public.analysis_repository_snapshot snapshot on snapshot.id=repo_commit.snapshot_id
      where snapshot.job_id=p_job_id and snapshot.repository_name=v_candidate->>'repository_name'
        and repo_commit.sha=lower(v_candidate->>'sha');
      if v_commit_id is null then raise exception 'CANDIDATE_COMMIT_NOT_IN_JOB_MANIFEST'; end if;
      select rule.id into v_rule_id from public.analysis_attribution_rule rule
      where rule.version_id=v_job.attribution_rule_version_id and rule.rule_code=v_candidate->>'rule_code';
      if v_candidate->>'selection_source'='RULE' and v_rule_id is null then
        raise exception 'CANDIDATE_RULE_NOT_IN_FROZEN_VERSION';
      end if;
      insert into public.analysis_story_commit_candidate(
        id,scope_id,task_id,generation,commit_id,tier,selection_source,rank_score,
        reason_codes,identity_match_type,story_match_location,matched_rule_id,effective_status
      ) values (
        (v_candidate->>'candidate_id')::uuid,v_scope_id,v_task_id,v_generation,v_commit_id,
        v_candidate->>'tier',v_candidate->>'selection_source',coalesce((v_candidate->>'rank_score')::numeric,0),
        array(select value from jsonb_array_elements_text(v_candidate->'reason_codes') value),
        nullif(v_candidate->>'identity_match_type',''),nullif(v_candidate->>'story_match_location',''),
        v_rule_id,coalesce(v_candidate->>'effective_status','UNKNOWN')
      );
      insert into public.analysis_scope_decision_audit(job_id,task_id,candidate_id,decision_type,source,reason_codes,after_state)
      values(p_job_id,v_task_id,(v_candidate->>'candidate_id')::uuid,
        case when v_candidate->>'tier'='EXCLUDED' then 'AUTO_EXCLUDE' else 'AUTO_SELECT' end,
        'RULE_ENGINE',array(select value from jsonb_array_elements_text(v_candidate->'reason_codes') value),
        jsonb_build_object('tier',v_candidate->>'tier','generation',v_generation));
    end loop;
    update public.analysis_story_scope scope set
      candidate_count=(select count(*) from public.analysis_story_commit_candidate c where c.scope_id=scope.id),
      strong_count=(select count(*) from public.analysis_story_commit_candidate c where c.scope_id=scope.id and c.tier='STRONG'),
      ai_candidate_count=(select count(*) from public.analysis_story_commit_candidate c where c.scope_id=scope.id and c.tier in ('AI_CANDIDATE','WEAK')),
      triage_required_count=(select count(*) from public.analysis_story_commit_candidate c where c.scope_id=scope.id and c.tier in ('AI_CANDIDATE','WEAK'))
    where scope.id=v_scope_id;
    v_scope_count:=v_scope_count+1;
  end loop;
  update public.analysis_job set selected_scope_hash=p_scope_catalog_hash where id=p_job_id;
  return jsonb_build_object('scope_count',v_scope_count,'scope_catalog_hash',p_scope_catalog_hash);
end;
$$;

create or replace function public.finalize_analysis_story_scope(
  p_job_id uuid,p_worker_id text,p_expected_generation integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_job public.analysis_job; v_total integer; v_degraded integer;
begin
  v_job:=public.assert_analysis_scope_job_writer(p_job_id,p_worker_id,array['PREPARING_SCOPE']);
  select count(*),count(*) filter(where scope.status in ('DEGRADED','FAILED') or scope.scope_mode='GLOBAL_FALLBACK')
  into v_total,v_degraded from public.analysis_story_scope scope
  join public.analysis_story_task task on task.id=scope.task_id
  where task.job_id=p_job_id and scope.generation=p_expected_generation;
  if v_total<>(select count(*) from public.analysis_story_task where job_id=p_job_id) then raise exception 'ALL_STORY_SCOPES_REQUIRED'; end if;
  if exists(select 1 from public.analysis_repository_snapshot where job_id=p_job_id and enumeration_status is null) then
    raise exception 'REPOSITORY_SCOPE_NOT_PREPARED';
  end if;
  update public.analysis_story_scope scope set frozen_at=now(),
    status=case when status='PREPARING' then 'READY' else status end,
    triage_complete=(triage_required_count=0),updated_at=now()
  from public.analysis_story_task task where task.id=scope.task_id and task.job_id=p_job_id
    and scope.generation=p_expected_generation and scope.frozen_at is null;
  update public.analysis_job set status='PROCESSING',scope_status=case when v_degraded>0 then 'DEGRADED' else 'READY' end,
    scope_error_code=case when v_degraded>0 then coalesce(scope_error_code,'PARTIAL_SCOPE_DEGRADED') else null end
  where id=p_job_id;
  return jsonb_build_object('scope_count',v_total,'degraded_count',v_degraded,
    'scope_status',case when v_degraded>0 then 'DEGRADED' else 'READY' end);
end;
$$;

------------------------------------------------------------------------------
-- 9. Attempt 读取/判定/扩展 RPC（claim fencing + 幂等）
------------------------------------------------------------------------------

create or replace function public.get_story_task_analysis_scope(
  p_task_id uuid,p_worker_id text,p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_task public.analysis_story_task; v_scope public.analysis_story_scope;
begin
  v_task:=public.assert_analysis_scope_task_claim(p_task_id,p_worker_id,p_claim_token);
  select * into v_scope from public.analysis_story_scope where task_id=p_task_id and frozen_at is not null order by generation desc limit 1;
  if v_scope.id is null then raise exception 'ANALYSIS_SCOPE_NOT_FROZEN'; end if;
  return jsonb_build_object(
    'task_id',p_task_id,'generation',v_scope.generation,'scope_mode',v_scope.scope_mode,
    'status',v_scope.status,'current_scope_level',v_scope.current_scope_level,
    'algorithm_version',v_scope.algorithm_version,'ruleset_hash',v_scope.ruleset_hash,
    'candidate_manifest_hash',v_scope.candidate_manifest_hash,
    'scope_error_code',v_scope.scope_error_code,'degradation_reasons',v_scope.degradation_reasons,
    'candidate_count',v_scope.candidate_count,'strong_count',v_scope.strong_count,
    'ai_candidate_count',v_scope.ai_candidate_count,'triage_complete',v_scope.triage_complete,
    'candidates',coalesce((select jsonb_agg(jsonb_build_object(
      'candidate_id',candidate.id,'tier',candidate.tier,'rank_score',candidate.rank_score,
      'reason_codes',candidate.reason_codes,'repository',snapshot.repository_name,
      'short_sha',left(repo_commit.sha,12),'subject',repo_commit.subject,'author_name',repo_commit.author_name,
      'author_email_masked',repo_commit.author_email_masked,'committed_at',repo_commit.committed_at,
      'files_changed',repo_commit.files_changed,'additions',repo_commit.additions,'deletions',repo_commit.deletions,
      'effective_status',candidate.effective_status,
      'diff_status',coalesce(archive.status,'UNAVAILABLE')
    ) order by case candidate.tier when 'STRONG' then 1 when 'AI_CANDIDATE' then 2 when 'WEAK' then 3 else 4 end,
      candidate.rank_score desc,candidate.id)
    from public.analysis_story_commit_candidate candidate
    join public.analysis_repository_commit repo_commit on repo_commit.id=candidate.commit_id
    join public.analysis_repository_snapshot snapshot on snapshot.id=repo_commit.snapshot_id
    left join public.analysis_commit_diff_archive archive on archive.commit_id=repo_commit.id and archive.job_id=v_task.job_id
    where candidate.scope_id=v_scope.id),'[]'::jsonb)
  );
end;
$$;

create or replace function public.record_story_commit_access(
  p_task_id uuid,p_worker_id text,p_claim_token uuid,p_agent_run_id uuid,
  p_agent_node_id uuid,p_candidate_id uuid,p_tool_audit_id bigint,p_tool_call_id text,
  p_access_kind text,p_file_path text,p_cursor_value text,p_bytes_returned integer,
  p_diff_lines integer,p_truncated boolean,p_archive_sha256 text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_task public.analysis_story_task; v_id uuid;
begin
  v_task:=public.assert_analysis_scope_task_claim(p_task_id,p_worker_id,p_claim_token);
  if not exists(select 1 from public.analysis_agent_run run where run.id=p_agent_run_id and run.task_id=p_task_id and run.agent_attempt=v_task.agent_attempt) then raise exception 'AGENT_RUN_MISMATCH'; end if;
  if not exists(select 1 from public.analysis_story_commit_candidate where id=p_candidate_id and task_id=p_task_id) then raise exception 'CANDIDATE_TASK_MISMATCH'; end if;
  select id into v_id from public.analysis_story_commit_access where agent_run_id=p_agent_run_id
    and candidate_id=p_candidate_id and tool_call_id=p_tool_call_id and access_kind=p_access_kind
    and file_path is not distinct from p_file_path and cursor_value is not distinct from p_cursor_value;
  if v_id is not null then return v_id; end if;
  insert into public.analysis_story_commit_access(
    task_id,candidate_id,agent_run_id,agent_node_id,tool_audit_id,tool_call_id,access_kind,
    file_path,cursor_value,bytes_returned,diff_lines,truncated,archive_sha256
  ) values(p_task_id,p_candidate_id,p_agent_run_id,p_agent_node_id,p_tool_audit_id,p_tool_call_id,
    p_access_kind,p_file_path,p_cursor_value,coalesce(p_bytes_returned,0),coalesce(p_diff_lines,0),
    coalesce(p_truncated,false),p_archive_sha256) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.submit_story_commit_relevance_verdict(
  p_task_id uuid,p_worker_id text,p_claim_token uuid,p_agent_run_id uuid,p_candidate_id uuid,
  p_triage_revision integer,p_verdict text,p_reason_codes text[],p_confidence numeric,
  p_diff_access_ids uuid[],p_summary text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_task public.analysis_story_task; v_candidate public.analysis_story_commit_candidate;
  v_scope public.analysis_story_scope; v_existing public.analysis_story_commit_relevance_verdict;
  v_hash text; v_required integer; v_completed integer; v_related integer; v_uncertain integer;
  v_allowed text[]:=array['CODE_SEMANTIC_MATCH','MODULE_MATCH','CALL_CHAIN_MATCH','TEST_CHANGE_MATCH',
    'CONFIG_SCHEMA_MATCH','DIFFERENT_FEATURE','INSUFFICIENT_CONTEXT','DIFF_UNAVAILABLE','REVERT_OR_REPLACEMENT_UNCLEAR'];
begin
  v_task:=public.assert_analysis_scope_task_claim(p_task_id,p_worker_id,p_claim_token);
  select * into v_candidate from public.analysis_story_commit_candidate where id=p_candidate_id and task_id=p_task_id;
  if v_candidate.id is null or v_candidate.tier not in ('AI_CANDIDATE','WEAK') then raise exception 'CANDIDATE_NOT_AI_TRIAGE'; end if;
  select * into v_scope from public.analysis_story_scope where id=v_candidate.scope_id and frozen_at is not null;
  if v_scope.id is null then raise exception 'ANALYSIS_SCOPE_NOT_FROZEN'; end if;
  if p_verdict not in ('RELATED','UNRELATED','UNCERTAIN')
     or not (coalesce(p_reason_codes,array[]::text[]) <@ v_allowed) then raise exception 'TRIAGE_VERDICT_INVALID'; end if;
  if char_length(coalesce(p_summary,'')) not between 1 and 500 then raise exception 'TRIAGE_SUMMARY_INVALID'; end if;
  if not exists(select 1 from public.analysis_agent_run run where run.id=p_agent_run_id and run.task_id=p_task_id and run.agent_attempt=v_task.agent_attempt) then raise exception 'AGENT_RUN_MISMATCH'; end if;
  if exists(select 1 from unnest(coalesce(p_diff_access_ids,array[]::uuid[])) access_id
    where not exists(select 1 from public.analysis_story_commit_access access
      where access.id=access_id and access.task_id=p_task_id and access.candidate_id=p_candidate_id
        and access.agent_run_id=p_agent_run_id and access.access_kind='DIFF')) then raise exception 'DIFF_ACCESS_EVIDENCE_INVALID'; end if;
  if cardinality(coalesce(p_diff_access_ids,array[]::uuid[]))=0
     and not ('DIFF_UNAVAILABLE'=any(p_reason_codes) or 'INSUFFICIENT_CONTEXT'=any(p_reason_codes)) then
    raise exception 'DIFF_ACCESS_REQUIRED';
  end if;
  if cardinality(coalesce(p_diff_access_ids,array[]::uuid[]))=0 and p_verdict<>'UNCERTAIN' then raise exception 'UNREADABLE_DIFF_REQUIRES_UNCERTAIN'; end if;
  v_hash:=encode(digest(convert_to(concat_ws(E'\n',p_candidate_id::text,p_triage_revision::text,p_verdict,
    array_to_string(p_reason_codes,','),coalesce(p_confidence::text,''),array_to_string(coalesce(p_diff_access_ids,array[]::uuid[]),','),p_summary),'UTF8'),'sha256'),'hex');
  select * into v_existing from public.analysis_story_commit_relevance_verdict
  where agent_run_id=p_agent_run_id and candidate_id=p_candidate_id and triage_revision=p_triage_revision;
  if v_existing.id is not null then
    if v_existing.payload_hash<>v_hash then raise exception 'TRIAGE_VERDICT_CONFLICT'; end if;
  else
    insert into public.analysis_story_commit_relevance_verdict(
      task_id,candidate_id,agent_run_id,triage_revision,verdict,reason_codes,confidence,diff_access_ids,summary,payload_hash
    ) values(p_task_id,p_candidate_id,p_agent_run_id,p_triage_revision,p_verdict,p_reason_codes,p_confidence,
      coalesce(p_diff_access_ids,array[]::uuid[]),p_summary,v_hash);
    insert into public.analysis_scope_decision_audit(job_id,task_id,candidate_id,decision_type,source,agent_run_id,reason_codes,after_state)
    values(v_task.job_id,p_task_id,p_candidate_id,'AI_RELEVANCE','AI',p_agent_run_id,p_reason_codes,
      jsonb_build_object('verdict',p_verdict,'triage_revision',p_triage_revision));
  end if;
  v_required:=v_scope.triage_required_count;
  select count(*),count(*) filter(where verdict='RELATED'),count(*) filter(where verdict='UNCERTAIN')
  into v_completed,v_related,v_uncertain
  from public.analysis_story_commit_relevance_verdict verdict
  where verdict.agent_run_id=p_agent_run_id and verdict.triage_revision=p_triage_revision
    and verdict.candidate_id in(select id from public.analysis_story_commit_candidate where scope_id=v_scope.id and tier in('AI_CANDIDATE','WEAK'));
  update public.analysis_story_scope set triage_completed_count=v_completed,ai_related_count=v_related,
    ai_uncertain_count=v_uncertain,triage_complete=(v_completed=v_required),updated_at=now()
  where id=v_scope.id;
  return jsonb_build_object('completed_count',v_completed,'required_count',v_required,'triage_complete',v_completed=v_required);
end;
$$;

create or replace function public.record_analysis_scope_expansion(
  p_task_id uuid,p_worker_id text,p_claim_token uuid,p_agent_run_id uuid,p_agent_node_id uuid,
  p_from_level text,p_to_level text,p_reason_code text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_task public.analysis_story_task; v_scope public.analysis_story_scope; v_id uuid;
begin
  v_task:=public.assert_analysis_scope_task_claim(p_task_id,p_worker_id,p_claim_token);
  select * into v_scope from public.analysis_story_scope where task_id=p_task_id and frozen_at is not null order by generation desc limit 1 for update;
  if v_scope.id is null then raise exception 'ANALYSIS_SCOPE_NOT_FROZEN'; end if;
  if v_scope.current_scope_level<>p_from_level then raise exception 'SCOPE_EXPANSION_FROM_MISMATCH'; end if;
  if not exists(select 1 from public.analysis_agent_run where id=p_agent_run_id and task_id=p_task_id and agent_attempt=v_task.agent_attempt) then raise exception 'AGENT_RUN_MISMATCH'; end if;
  select id into v_id from public.analysis_scope_expansion where agent_run_id=p_agent_run_id and from_level=p_from_level and to_level=p_to_level and reason_code=p_reason_code;
  if v_id is not null then return v_id; end if;
  insert into public.analysis_scope_expansion(task_id,agent_run_id,agent_node_id,from_level,to_level,reason_code)
  values(p_task_id,p_agent_run_id,p_agent_node_id,p_from_level,p_to_level,p_reason_code) returning id into v_id;
  update public.analysis_story_scope set current_scope_level=p_to_level,updated_at=now() where id=v_scope.id;
  insert into public.analysis_scope_decision_audit(job_id,task_id,decision_type,source,agent_run_id,reason_codes,before_state,after_state)
  values(v_task.job_id,p_task_id,'SCOPE_EXPANSION','AI',p_agent_run_id,array[p_reason_code],
    jsonb_build_object('scope_level',p_from_level),jsonb_build_object('scope_level',p_to_level));
  return v_id;
end;
$$;

------------------------------------------------------------------------------
-- 10. 监控与管理员反馈 RPC：只返回脱敏摘要，不返回 fingerprint/body/diff/locator
------------------------------------------------------------------------------

create or replace function public.get_analysis_story_scope_summary(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare v_batch_id uuid; v_scope public.analysis_story_scope;
begin
  select job.batch_id into v_batch_id from public.analysis_story_task task join public.analysis_job job on job.id=task.job_id where task.id=p_task_id;
  if v_batch_id is null then return null; end if;
  perform public.ensure_view_review_batch(v_batch_id);
  select * into v_scope from public.analysis_story_scope where task_id=p_task_id order by generation desc limit 1;
  if v_scope.id is null then return null; end if;
  return jsonb_build_object('task_id',p_task_id,'generation',v_scope.generation,'scope_mode',v_scope.scope_mode,
    'scope_status',v_scope.status,'scope_error_code',v_scope.scope_error_code,'current_scope_level',v_scope.current_scope_level,
    'candidate_count',v_scope.candidate_count,'strong_count',v_scope.strong_count,'ai_candidate_count',v_scope.ai_candidate_count,
    'ai_related_count',v_scope.ai_related_count,'ai_uncertain_count',v_scope.ai_uncertain_count,
    'read_count',(select count(distinct candidate_id) from public.analysis_story_commit_access where task_id=p_task_id),
    'reverted_count',(select count(*) from public.analysis_story_commit_candidate where scope_id=v_scope.id and effective_status='REVERTED'),
    'algorithm_version',v_scope.algorithm_version,'manifest_hash',v_scope.candidate_manifest_hash,
    'degradation_reasons',v_scope.degradation_reasons,'frozen_at',v_scope.frozen_at);
end;
$$;

create or replace function public.get_analysis_story_scope_commits(p_task_id uuid,p_cursor integer default 0,p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare v_batch_id uuid; v_scope public.analysis_story_scope; v_offset integer:=greatest(coalesce(p_cursor,0),0); v_limit integer:=least(greatest(coalesce(p_limit,50),1),100); v_total integer;
begin
  select job.batch_id into v_batch_id from public.analysis_story_task task join public.analysis_job job on job.id=task.job_id where task.id=p_task_id;
  if v_batch_id is null then return null; end if;
  perform public.ensure_view_review_batch(v_batch_id);
  select * into v_scope from public.analysis_story_scope where task_id=p_task_id order by generation desc limit 1;
  if v_scope.id is null then return jsonb_build_object('items','[]'::jsonb,'total',0,'has_more',false,'next_cursor',null); end if;
  select count(*) into v_total from public.analysis_story_commit_candidate where scope_id=v_scope.id;
  return jsonb_build_object('generation',v_scope.generation,'manifest_hash',v_scope.candidate_manifest_hash,'total',v_total,
    'items',coalesce((select jsonb_agg(result_row.item order by result_row.ordinal) from (
      select row_number() over() ordinal,jsonb_build_object(
        'candidate_id',candidate.id,'tier',candidate.tier,'repository',snapshot.repository_name,
        'short_sha',left(repo_commit.sha,12),'subject',repo_commit.subject,'author_name',repo_commit.author_name,
        'author_email_masked',repo_commit.author_email_masked,'committed_at',repo_commit.committed_at,
        'files_changed',repo_commit.files_changed,'additions',repo_commit.additions,'deletions',repo_commit.deletions,
        'reason_codes',candidate.reason_codes,'effective_status',candidate.effective_status,
        'read',exists(select 1 from public.analysis_story_commit_access access where access.candidate_id=candidate.id),
        'ai_verdict',(select verdict.verdict from public.analysis_story_commit_relevance_verdict verdict where verdict.candidate_id=candidate.id order by verdict.created_at desc limit 1)
      ) item
      from public.analysis_story_commit_candidate candidate
      join public.analysis_repository_commit repo_commit on repo_commit.id=candidate.commit_id
      join public.analysis_repository_snapshot snapshot on snapshot.id=repo_commit.snapshot_id
      where candidate.scope_id=v_scope.id
      order by case candidate.tier when 'STRONG' then 1 when 'AI_CANDIDATE' then 2 when 'WEAK' then 3 when 'CONFLICT' then 4 else 5 end,
        candidate.rank_score desc,candidate.id offset v_offset limit v_limit
    ) result_row),'[]'::jsonb),
    'has_more',v_offset+v_limit<v_total,'next_cursor',case when v_offset+v_limit<v_total then v_offset+v_limit else null end);
end;
$$;

create or replace function public.record_story_commit_attribution_feedback(
  p_task_id uuid,p_candidate_id uuid,p_corrected_relevance text,p_reason text
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v_job_id uuid; v_batch_id uuid; v_id bigint; v_actor uuid:=auth.uid();
begin
  perform public.ensure_admin();
  if p_corrected_relevance not in ('RELATED','UNRELATED','UNCERTAIN') then raise exception 'FEEDBACK_RELEVANCE_INVALID'; end if;
  if coalesce(btrim(p_reason),'')='' then raise exception 'FEEDBACK_REASON_REQUIRED'; end if;
  select task.job_id,job.batch_id into v_job_id,v_batch_id from public.analysis_story_task task join public.analysis_job job on job.id=task.job_id where task.id=p_task_id;
  if not exists(select 1 from public.analysis_story_commit_candidate where id=p_candidate_id and task_id=p_task_id) then raise exception 'CANDIDATE_TASK_MISMATCH'; end if;
  insert into public.analysis_scope_decision_audit(job_id,task_id,candidate_id,decision_type,source,actor_id,reason_codes,after_state)
  values(v_job_id,p_task_id,p_candidate_id,'ADMIN_FEEDBACK','ADMIN',v_actor,array['ADMIN_CORRECTION'],
    jsonb_build_object('corrected_relevance',p_corrected_relevance,'reason',btrim(p_reason))) returning id into v_id;
  return v_id;
end;
$$;

------------------------------------------------------------------------------
-- 11. 最小权限：显式撤销 PUBLIC/anon/authenticated，再按调用方授予
------------------------------------------------------------------------------

revoke execute on function public.attribution_rule_version_config(uuid) from public, anon;
revoke execute on function public.attribution_rule_version_hash(uuid) from public, anon, authenticated;
grant execute on function public.attribution_rule_version_config(uuid) to authenticated, service_role;
grant execute on function public.attribution_rule_version_hash(uuid) to service_role;

revoke execute on function public.admin_list_developer_git_identities() from public, anon;
grant execute on function public.admin_list_developer_git_identities() to authenticated, service_role;
revoke execute on function public.admin_upsert_developer_git_identity(uuid,uuid,uuid,text,text,text,text,text,text,text,text[],text,text,text,integer) from public, anon, authenticated;
grant execute on function public.admin_upsert_developer_git_identity(uuid,uuid,uuid,text,text,text,text,text,text,text,text[],text,text,text,integer) to service_role;
revoke execute on function public.admin_list_attribution_rule_sets() from public, anon;
grant execute on function public.admin_list_attribution_rule_sets() to authenticated, service_role;
revoke execute on function public.admin_create_attribution_rule_draft(uuid) from public, anon;
grant execute on function public.admin_create_attribution_rule_draft(uuid) to authenticated;
revoke execute on function public.admin_save_attribution_rule_draft(uuid,integer,jsonb) from public, anon;
grant execute on function public.admin_save_attribution_rule_draft(uuid,integer,jsonb) to authenticated;
revoke execute on function public.admin_validate_attribution_rule_draft(uuid) from public, anon;
grant execute on function public.admin_validate_attribution_rule_draft(uuid) to authenticated;
revoke execute on function public.admin_record_attribution_rule_test_run(uuid,uuid,text,text,jsonb,jsonb,boolean,text) from public, anon, authenticated;
grant execute on function public.admin_record_attribution_rule_test_run(uuid,uuid,text,text,jsonb,jsonb,boolean,text) to service_role;
revoke execute on function public.admin_publish_attribution_rule_version(uuid,integer,text) from public, anon;
grant execute on function public.admin_publish_attribution_rule_version(uuid,integer,text) to authenticated;
revoke execute on function public.admin_restore_attribution_rule_version(uuid,text) from public, anon;
grant execute on function public.admin_restore_attribution_rule_version(uuid,text) to authenticated;

revoke execute on function public.assert_analysis_scope_job_writer(uuid,text,text[]) from public, anon, authenticated;
revoke execute on function public.assert_analysis_scope_task_claim(uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.assert_analysis_scope_job_writer(uuid,text,text[]) to service_role;
grant execute on function public.assert_analysis_scope_task_claim(uuid,text,uuid) to service_role;
revoke execute on function public.freeze_analysis_job_scope_inputs(uuid,text) from public, anon, authenticated;
grant execute on function public.freeze_analysis_job_scope_inputs(uuid,text) to service_role;
revoke execute on function public.save_analysis_repository_commit_manifest(uuid,text,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.save_analysis_repository_commit_manifest(uuid,text,text,jsonb,text) to service_role;
revoke execute on function public.save_analysis_commit_diff_archives(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.save_analysis_commit_diff_archives(uuid,text,jsonb) to service_role;
revoke execute on function public.save_analysis_story_scopes(uuid,text,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.save_analysis_story_scopes(uuid,text,text,jsonb,text) to service_role;
revoke execute on function public.finalize_analysis_story_scope(uuid,text,integer) from public, anon, authenticated;
grant execute on function public.finalize_analysis_story_scope(uuid,text,integer) to service_role;
revoke execute on function public.get_story_task_analysis_scope(uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.get_story_task_analysis_scope(uuid,text,uuid) to service_role;
revoke execute on function public.record_story_commit_access(uuid,text,uuid,uuid,uuid,uuid,bigint,text,text,text,text,integer,integer,boolean,text) from public, anon, authenticated;
grant execute on function public.record_story_commit_access(uuid,text,uuid,uuid,uuid,uuid,bigint,text,text,text,text,integer,integer,boolean,text) to service_role;
revoke execute on function public.submit_story_commit_relevance_verdict(uuid,text,uuid,uuid,uuid,integer,text,text[],numeric,uuid[],text) from public, anon, authenticated;
grant execute on function public.submit_story_commit_relevance_verdict(uuid,text,uuid,uuid,uuid,integer,text,text[],numeric,uuid[],text) to service_role;
revoke execute on function public.record_analysis_scope_expansion(uuid,text,uuid,uuid,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.record_analysis_scope_expansion(uuid,text,uuid,uuid,uuid,text,text,text) to service_role;

revoke execute on function public.get_analysis_story_scope_summary(uuid) from public, anon;
grant execute on function public.get_analysis_story_scope_summary(uuid) to authenticated, service_role;
revoke execute on function public.get_analysis_story_scope_commits(uuid,integer,integer) from public, anon;
grant execute on function public.get_analysis_story_scope_commits(uuid,integer,integer) to authenticated, service_role;
revoke execute on function public.record_story_commit_attribution_feedback(uuid,uuid,text,text) from public, anon;
grant execute on function public.record_story_commit_attribution_feedback(uuid,uuid,text,text) to authenticated;

-- 触发器/内部 helper 不应成为客户端 API。
revoke execute on function public.enforce_attribution_rule_version_immutable() from public, anon, authenticated;
revoke execute on function public.enforce_published_attribution_rule_immutable() from public, anon, authenticated;
revoke execute on function public.reject_append_only_mutation() from public, anon, authenticated;
revoke execute on function public.reject_frozen_input_snapshot_update() from public, anon, authenticated;
revoke execute on function public.enforce_analysis_story_scope_freeze() from public, anon, authenticated;
revoke execute on function public.enforce_candidate_freeze() from public, anon, authenticated;
revoke execute on function public.enforce_story_commit_scope_worker_capability() from public, anon, authenticated;
revoke execute on function public.enforce_analysis_job_scope_identity_immutable() from public, anon, authenticated;

comment on table public.analysis_repository_commit is
  'Authoritative commit metadata only when its repository snapshot enumeration_status is COMPLETE. Never stores raw email.';
comment on table public.analysis_story_commit_candidate is
  'Frozen rule-engine relationship. Candidate does not mean factual ownership; AI verdicts are separate append-only rows.';
comment on table public.analysis_story_commit_access is
  'Append-only proof that a concrete run read summary/file-list/diff for a frozen candidate; no diff body is stored.';
comment on table public.analysis_scope_expansion is
  'Append-only PRIMARY->RELATED->GLOBAL expansion facts. Levels can only widen.';
comment on table public.analysis_scope_decision_audit is
  'Append-only identity, deterministic selection, AI relevance, expansion and administrator feedback audit.';

commit;
