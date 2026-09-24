-- 把受评审仓库白名单从 4 个扩到 5 个：新增 kwork/kwork-server。
--
-- 这次改动的真正难点不是"多加一个名字"，而是**这份名单原本散落在 8 个地方**：
-- 2 个 CHECK 约束 + 6 个 plpgsql 函数，其中还有 3 处硬编码的数字 4（"必须正好 4 个快照"）。
-- 漏掉任何一处的表现都不是报错，而是更糟的形态：
--
--   * 漏掉 `analysis_repository_snapshot` 的 CHECK → Worker 冻结第 5 个仓时插入被拒，
--     整个 Job 在准备阶段失败；
--   * 漏掉 `save_repository_snapshots` 的数量校验 → 第 5 个仓被静默丢掉，Job "成功"了，
--     但后续覆盖率与归属分析建立在缺一块的快照上，报表里看不出任何异常；
--   * 漏掉 `analysis_runtime_event_payload` 的字段允许列表 → 监控台里第 5 个仓的运行事件
--     被静默丢弃，于是"那个仓好像从来没被搜过"；
--   * 漏掉 `save_analysis_repository_merge_requests` 的项目路径映射 → 第 5 个仓的 MR 采集
--     以 `REPOSITORY_NOT_ALLOWED` 失败。
--
-- 所以这份迁移做的第一件事是**建立单一事实来源**（`analysis_repository_catalog()`），
-- 然后把那 6 个函数里的字面量清单全部换成对它的调用。下一次加仓库只需要改那一个函数，
-- 不必再做一次 8 处的考古。
--
-- 注意 kwork-server 的路径与前四个不同：它在 `kwork/kwork-server`，不在 `kwork/manage/` 下。
-- 所以目录里存的是完整的 GitLab 项目路径，而不是"用名字拼前缀"。
--
-- 两个 CHECK 约束刻意**保留字面量清单**，不改成调用目录函数：
--   1. CHECK 里引用函数会让 pg_dump/restore 产生顺序依赖（约束先于函数创建就会失败）；
--   2. 更重要的是，函数体变了 Postgres **不会**重新校验已有行，于是约束的含义会悄悄漂移 ——
--      一个"看起来还在管事"的约束实际上已经允许了别的东西。字面量清单虽然要多改一处，
--      但它在 `\d+` 里是自解释的。
--
-- Worker 与数据库必须同批上线：`save_repository_snapshots` 现在要求快照数量等于白名单长度，
-- 旧 Worker（只送 4 个）打在新库上会明确失败。这是刻意的 —— 见该函数里的注释。

begin;

------------------------------------------------------------------------------
-- 1. 单一事实来源
------------------------------------------------------------------------------

/*
 * 受评审仓库目录。
 *
 * `name` 是平台内部标识（也是 workspace 里的目录名、快照表里的 `repository_name`）；
 * `gitlab_project` 是 GitLab 上的完整项目路径，用于 MR 采集时校验 `web_url`。
 * 两者不是同一个东西，也不能互相推导 —— kwork-server 就不在 `kwork/manage/` 下。
 *
 * 排序固定按 name，与 Worker 侧 `REPOSITORIES` 的顺序无关：任何依赖顺序的地方都必须
 * 自己排序，不能依赖这里的书写顺序。
 */
create or replace function public.analysis_repository_catalog()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_array(
    jsonb_build_object('name', 'kdmanage-backend',  'gitlab_project', 'kwork/manage/kdmanage-backend'),
    jsonb_build_object('name', 'kdmanage-frontend', 'gitlab_project', 'kwork/manage/kdmanage-frontend'),
    jsonb_build_object('name', 'kwork-server',      'gitlab_project', 'kwork/kwork-server'),
    jsonb_build_object('name', 'tmanage-backend',   'gitlab_project', 'kwork/manage/tmanage-backend'),
    jsonb_build_object('name', 'tmanage-frontend',  'gitlab_project', 'kwork/manage/tmanage-frontend')
  );
$$;

comment on function public.analysis_repository_catalog() is
  'Single source of truth for the reviewed repository whitelist. Adding a repository means '
  'editing this function; every other SQL site derives from it. Keep it in sync with '
  'worker/src/git/repositories.ts (asserted by supabase/tests and a worker unit test).';

create or replace function public.analysis_allowed_repository_names()
returns text[]
language sql
immutable
as $$
  select array_agg(entry->>'name' order by entry->>'name')
  from jsonb_array_elements(public.analysis_repository_catalog()) as entry;
$$;

create or replace function public.analysis_allowed_repository_count()
returns integer
language sql
immutable
as $$
  select jsonb_array_length(public.analysis_repository_catalog());
$$;

/*
 * "所有仓库的 HEAD 都还不知道"这个初始对象。
 *
 * 写成函数而不是字面量，是因为它的键集合必须与白名单**同时**变化：少一个键，
 * 下游按键取值的地方拿到的是 SQL null 而不是"这个仓没有上一次的 HEAD"，两者在
 * 增量分析里会走到不同的分支。
 */
create or replace function public.analysis_empty_repository_heads()
returns jsonb
language sql
immutable
as $$
  select coalesce(jsonb_object_agg(name, null::jsonb), '{}'::jsonb)
  from unnest(public.analysis_allowed_repository_names()) as name;
$$;

/*
 * 平台仓库名 → GitLab 项目路径。不在白名单里返回 null，调用方据此抛
 * `REPOSITORY_NOT_ALLOWED`（保持既有错误码不变）。
 */
create or replace function public.analysis_repository_gitlab_project(p_repository_name text)
returns text
language sql
immutable
as $$
  select entry->>'gitlab_project'
  from jsonb_array_elements(public.analysis_repository_catalog()) as entry
  where entry->>'name' = p_repository_name;
$$;

------------------------------------------------------------------------------
-- 2. CHECK 约束：扩到 5 个（字面量，理由见文件头）
--
-- 这是**放宽**，原有 4 个名字全部保留，所以已有行必然通过校验；
-- `analysis_agent_evidence` 目前只有几百行，直接 validate 不会长时间持锁。
------------------------------------------------------------------------------

alter table public.analysis_repository_snapshot
  drop constraint if exists analysis_repository_snapshot_repository_name_check,
  add constraint analysis_repository_snapshot_repository_name_check
    check (repository_name in (
      'kdmanage-backend', 'kdmanage-frontend', 'kwork-server',
      'tmanage-backend', 'tmanage-frontend'
    ));

alter table public.analysis_agent_evidence
  drop constraint if exists analysis_agent_evidence_repository_name_check,
  add constraint analysis_agent_evidence_repository_name_check
    check (repository_name in (
      'kdmanage-backend', 'kdmanage-frontend', 'kwork-server',
      'tmanage-backend', 'tmanage-frontend'
    ));

-- 一致性哨兵：约束清单与目录函数必须说同一件事。
-- 两者本来就要分别维护（见文件头），所以这里在迁移时就把"忘了改另一处"挡掉。
do $$
declare
  v_missing text;
begin
  select string_agg(name, ', ')
  into v_missing
  from unnest(public.analysis_allowed_repository_names()) as name
  where not exists (
    select 1
    from pg_constraint
    where conname = 'analysis_repository_snapshot_repository_name_check'
      and pg_get_constraintdef(oid) like '%' || name || '%'
  );
  if v_missing is not null then
    raise exception
      'repository whitelist drift: % is in analysis_repository_catalog() but not in the '
      'analysis_repository_snapshot CHECK constraint', v_missing;
  end if;
end $$;

------------------------------------------------------------------------------
-- 3. 把 6 个函数里的字面量清单换成目录函数调用
--
-- 下面的定义由 `scripts/generate-repository-whitelist-migration.mjs` 从**迁移前数据库里的
-- 权威定义**（`pg_get_functiondef`）生成：只做定点替换，其余逐字不动。
-- 这样做的理由是 `freeze_analysis_job_scope_inputs` 刚被 Linky 那批迁移改过 ——
-- 手抄一遍等于把别人刚做的改动重新录入一次，偏一个字符就会静默回退掉它。
------------------------------------------------------------------------------

-- analysis_runtime_event_payload：仅把硬编码仓库清单换成白名单函数调用，其余逐字保持迁移前的权威定义。
CREATE OR REPLACE FUNCTION public.analysis_runtime_event_payload(p_event_type text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare
  v_spec jsonb := public.analysis_runtime_event_catalog() -> p_event_type;
  v_keys text[];
  v_key text;
  v_raw text;
  v_out jsonb := '{}'::jsonb;
  v_int bigint;
begin
  if v_spec is null then
    return '{}'::jsonb;
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    return '{}'::jsonb;
  end if;

  select coalesce(array_agg(value::text), array[]::text[])
    into v_keys
  from jsonb_array_elements_text(v_spec -> 'keys') as t(value);

  foreach v_key in array v_keys loop
    v_raw := nullif(btrim(coalesce(p_payload ->> v_key, '')), '');
    if v_raw is null then
      continue;
    end if;

    case v_key
      -- ── 枚举型：不在词表里就丢弃，绝不透传任意文案 ──
      when 'agent_role' then
        if v_raw in ('root-reviewer', 'research-child', 'implementation-child',
                     'critic-child', 'workflow-child') then
          v_out := v_out || jsonb_build_object(v_key, v_raw);
        end if;
      when 'provider' then
        if v_raw in ('root', 'spawn', 'fork', 'workflow', 'ralph') then
          v_out := v_out || jsonb_build_object(v_key, v_raw);
        end if;
      when 'tool_name' then
        if v_raw = any (public.analysis_runtime_known_tool_names()) then
          v_out := v_out || jsonb_build_object(v_key, v_raw);
        end if;
      when 'permission_verdict' then
        if v_raw in ('ALLOW', 'DENY', 'CANCELLED') then
          v_out := v_out || jsonb_build_object(v_key, v_raw);
        end if;
      when 'model_request_kind' then
        if v_raw in ('loop', 'retry', 'compaction', 'session-title', 'ralph', 'other') then
          v_out := v_out || jsonb_build_object(v_key, v_raw);
        end if;
      when 'repository_name' then
        if v_raw = any (public.analysis_allowed_repository_names()) then
          v_out := v_out || jsonb_build_object(v_key, v_raw);
        end if;
      when 'reason_code' then
        -- 稳定机器码，不是异常 message。含空格/小写/超长的一律丢弃。
        if v_raw ~ '^[A-Z][A-Z0-9_]{0,63}$' then
          v_out := v_out || jsonb_build_object(v_key, v_raw);
        end if;

      -- ── 布尔 ──
      when 'collapsed', 'truncated', 'resumed' then
        if lower(v_raw) in ('true', 'false') then
          v_out := v_out || jsonb_build_object(v_key, lower(v_raw) = 'true');
        end if;

      -- ── 数值 ──
      when 'delegation_depth', 'attempt_number', 'session_revision', 'request_bytes',
           'response_bytes', 'agent_count', 'active_children', 'duration_ms',
           'exit_code', 'output_bytes', 'hit_count', 'line_span', 'retry_index',
           'events_reported', 'events_dropped', 'input_tokens', 'output_tokens' then
        begin
          v_int := v_raw::bigint;
        exception when others then
          v_int := null;
        end;
        if v_int is not null then
          -- exit_code 允许负数（信号终止），其余计量字段不允许。
          if v_key = 'exit_code' or v_int >= 0 then
            v_out := v_out || jsonb_build_object(v_key, v_int);
          end if;
        end if;

      else
        -- 目录里出现了未实现的键：宁可丢弃也不透传。
        null;
    end case;
  end loop;

  return v_out;
end;
$function$;

-- analysis_job_frozen_scope_input_payload：仅把硬编码仓库清单换成白名单函数调用，其余逐字保持迁移前的权威定义。
CREATE OR REPLACE FUNCTION public.analysis_job_frozen_scope_input_payload(p_job_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'stories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'task_id', task.id,
        'story_id', story.story_id,
        'story_code', story.story_code,
        'story_name', story.story_name,
        'owners_text', story.owners_text,
        'normalized_developer_ids', to_jsonb(story.normalized_developer_ids),
        'project_name', story.project_name,
        'application_name', story.application_name,
        'release_window', story.release_window,
        'requirement_context', story.requirement_context,
        'input_hash', story.input_hash
      ) order by story.story_code collate "C", task.id)
      from public.analysis_job_story_snapshot story
      join public.analysis_story_task task
        on task.job_id=story.job_id and task.story_id=story.story_id
      where story.job_id=p_job_id
    ), '[]'::jsonb),
    'identities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'developer_id', identity.source_developer_identity_id,
        'display_name', identity.developer_display_name,
        'email_fingerprint', identity.email_fingerprint,
        'author_name_aliases', to_jsonb(identity.author_name_aliases),
        'verification_status', identity.verification_status
      ) order by identity.source_developer_identity_id, identity.source_git_identity_id)
      from public.analysis_job_identity_snapshot identity
      where identity.job_id=p_job_id
    ), '[]'::jsonb),
    'previous_repository_heads', coalesce(job.previous_repository_heads, public.analysis_empty_repository_heads())
  )
  from public.analysis_job job
  where job.id=p_job_id;
$function$;

-- freeze_analysis_job_scope_inputs：仅把硬编码仓库清单换成白名单函数调用，其余逐字保持迁移前的权威定义。
CREATE OR REPLACE FUNCTION public.freeze_analysis_job_scope_inputs(p_job_id uuid, p_worker_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_job public.analysis_job;
  v_version public.analysis_attribution_rule_version;
  v_story_hash text;
  v_identity_hash text;
  v_previous_heads jsonb;
  v_payload jsonb;
begin
  v_job := public.assert_analysis_scope_job_writer(
    p_job_id,p_worker_id,array['PREPARING_CODE','PREPARING_SCOPE']
  );

  if v_job.attribution_rule_version_id is not null then
    select * into v_version
    from public.analysis_attribution_rule_version
    where id=v_job.attribution_rule_version_id and status='PUBLISHED';
  else
    select version.* into v_version
    from public.analysis_attribution_rule_set rule_set
    join public.analysis_attribution_rule_version version
      on version.id=rule_set.current_published_version_id
    where rule_set.rule_set_code='STORY_COMMIT_ATTRIBUTION'
      and rule_set.enabled and version.status='PUBLISHED';
  end if;
  if v_version.id is null then raise exception 'PUBLISHED_ATTRIBUTION_RULESET_REQUIRED'; end if;
  if v_version.ruleset_hash is distinct from public.attribution_rule_version_hash(v_version.id)
     or (v_job.ruleset_hash is not null and v_job.ruleset_hash is distinct from v_version.ruleset_hash) then
    raise exception 'ATTRIBUTION_RULESET_MISMATCH';
  end if;

  if v_job.previous_repository_heads is null then
    select jsonb_object_agg(repositories.repository_name, previous.head_sha order by repositories.repository_name)
    into v_previous_heads
    from unnest(public.analysis_allowed_repository_names()) as repositories(repository_name)
    left join lateral (
      select coalesce(snapshot.head_sha,lower(snapshot.commit_sha)) as head_sha
      from public.analysis_job prior_job
      join public.analysis_repository_snapshot snapshot on snapshot.job_id=prior_job.id
      where prior_job.id<>v_job.id
        and prior_job.analysis_context_version=2
        and prior_job.status='SUCCEEDED'
        and prior_job.requested_branch=v_job.requested_branch
        and prior_job.created_at<v_job.created_at
        and snapshot.repository_name=repositories.repository_name
        and coalesce(snapshot.head_sha,lower(snapshot.commit_sha)) is not null
      order by prior_job.finished_at desc nulls last,prior_job.created_at desc,prior_job.id desc
      limit 1
    ) previous on true;
    update public.analysis_job
    set previous_repository_heads=v_previous_heads
    where id=p_job_id
    returning * into v_job;
  end if;

  if exists(select 1 from public.analysis_job_story_snapshot where job_id=p_job_id) then
    select story_input_catalog_hash,identity_snapshot_hash
      into v_story_hash,v_identity_hash
    from public.analysis_job where id=p_job_id;
    update public.analysis_job
    set status='PREPARING_SCOPE',scope_status='PREPARING',
        scope_requested_at=coalesce(scope_requested_at,now()),locked_at=now()
    where id=p_job_id and status in ('PREPARING_CODE','PREPARING_SCOPE');
    v_payload:=public.analysis_job_frozen_scope_input_payload(p_job_id);
    return jsonb_build_object(
      'story_input_catalog_hash',v_story_hash,
      'identity_snapshot_hash',v_identity_hash,
      'rule_version_id',v_version.id,
      'ruleset_hash',v_version.ruleset_hash,
      'idempotent',true
    ) || v_payload;
  end if;

  insert into public.analysis_job_story_snapshot(
    job_id,story_id,story_code,story_name,owners_text,normalized_developer_ids,
    project_name,application_name,release_window,requirement_context,input_hash
  )
  select p_job_id,story.id,story.story_code,story.story_name,story.owners_text,
    array(
      select distinct developer.id
      from public.developer_identity developer
      where developer.status='VERIFIED' and exists(
        select 1
        from regexp_split_to_table(story.owners_text,'[，,、；;]') as owner(owner_token)
        where btrim(owner.owner_token)=developer.display_name
           or (developer.employee_code is not null and btrim(owner.owner_token) in (
             developer.display_name||'（'||developer.employee_code||'）',
             developer.display_name||'('||developer.employee_code||')'
           ))
      ) order by developer.id
    ),story.project_name,story.application_name,story.release_window,
    public.review_story_requirement_context(story),
    encode(digest(convert_to(concat_ws(E'\n',story.story_code,story.story_name,story.owners_text,
      coalesce(story.project_name,''),coalesce(story.application_name,''),
      coalesce(story.release_window,''),
      public.review_story_requirement_context(story)::text),'UTF8'),'sha256'),'hex')
  from public.analysis_story_task task
  join public.review_story story on story.id=task.story_id
  where task.job_id=p_job_id
  order by story.story_code;

  insert into public.analysis_job_identity_snapshot(
    job_id,source_developer_identity_id,source_git_identity_id,developer_display_name,
    employee_code,identity_status,provider,email_fingerprint,masked_email,email_domain,
    author_name_aliases,gitlab_username,gitlab_user_id,verification_status,snapshot_hash
  )
  select p_job_id,developer.id,git.id,developer.display_name,developer.employee_code,
    developer.status,git.provider,git.email_fingerprint,git.masked_email,git.email_domain,
    git.author_name_aliases,git.gitlab_username,git.gitlab_user_id,git.verification_status,
    encode(digest(convert_to(concat_ws(E'\n',developer.id::text,git.id::text,
      developer.display_name,coalesce(developer.employee_code,''),developer.status,
      git.provider,coalesce(git.email_fingerprint,''),coalesce(git.masked_email,''),
      coalesce(git.email_domain,''),array_to_string(git.author_name_aliases,E'\n'),
      coalesce(git.gitlab_username,''),coalesce(git.gitlab_user_id,''),
      git.verification_status),'UTF8'),'sha256'),'hex')
  from public.developer_identity developer
  join public.developer_git_identity git on git.developer_identity_id=developer.id
  where developer.status<>'DISABLED' and git.verification_status<>'DISABLED'
    and git.valid_from<=now() and (git.valid_until is null or git.valid_until>now())
  order by developer.id,git.id;

  select encode(digest(convert_to(coalesce(string_agg(input_hash,E'\n' order by story_code),'empty'),
    'UTF8'),'sha256'),'hex')
  into v_story_hash
  from public.analysis_job_story_snapshot where job_id=p_job_id;

  select encode(digest(convert_to(coalesce(string_agg(snapshot_hash,E'\n' order by source_git_identity_id),
    'empty'),'UTF8'),'sha256'),'hex')
  into v_identity_hash
  from public.analysis_job_identity_snapshot where job_id=p_job_id;

  update public.analysis_job
  set status='PREPARING_SCOPE',scope_status='PREPARING',
      scope_requested_at=coalesce(scope_requested_at,now()),locked_at=now(),
      attribution_rule_version_id=v_version.id,ruleset_hash=v_version.ruleset_hash,
      story_input_catalog_hash=v_story_hash,identity_snapshot_hash=v_identity_hash,
      attribution_algorithm_version=coalesce(attribution_algorithm_version,'story-attribution-v2')
  where id=p_job_id;

  v_payload:=public.analysis_job_frozen_scope_input_payload(p_job_id);
  return jsonb_build_object(
    'story_input_catalog_hash',v_story_hash,
    'identity_snapshot_hash',v_identity_hash,
    'rule_version_id',v_version.id,
    'ruleset_hash',v_version.ruleset_hash,
    'idempotent',false
  ) || v_payload;
end;
$function$;

-- save_repository_snapshots：仅把硬编码仓库清单换成白名单函数调用，其余逐字保持迁移前的权威定义。
CREATE OR REPLACE FUNCTION public.save_repository_snapshots(p_job_id uuid, p_worker_id text, p_snapshots jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_job public.analysis_job;
  v_snap jsonb;
  v_existing_inputs boolean;
begin
  select * into v_job from public.analysis_job where id=p_job_id for update;
  if v_job.id is null then raise exception 'job not found'; end if;
  if v_job.execution_engine<>'deepseek-harness-acp' then raise exception 'LEGACY_ENGINE_RETIRED'; end if;
  if v_job.status not in ('PREPARING_CODE','PREPARING_SCOPE') then
    raise exception 'job is not in a preparation state';
  end if;
  if v_job.worker_id is distinct from p_worker_id then raise exception 'JOB_LEASE_LOST'; end if;
  if jsonb_typeof(p_snapshots)<>'array'
     or jsonb_array_length(p_snapshots)<>public.analysis_allowed_repository_count() then
    raise exception 'exactly % repository snapshots are required',
      public.analysis_allowed_repository_count();
  end if;
  if (select count(distinct value->>'repository_name') from jsonb_array_elements(p_snapshots) value)
       <>public.analysis_allowed_repository_count()
     or exists(
       select 1 from jsonb_array_elements(p_snapshots) value
       where not (value->>'repository_name' = any (public.analysis_allowed_repository_names()))
          or lower(coalesce(value->>'commit_sha','')) !~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
     ) then
    raise exception 'REPOSITORY_SNAPSHOT_SET_INVALID';
  end if;

  select exists(select 1 from public.analysis_job_story_snapshot where job_id=p_job_id)
  into v_existing_inputs;

  -- PREPARING_SCOPE 被接管或 HTTP 重试时，保留已经冻结的 commit/scope/audit。
  -- 只有四仓 HEAD 与第一次冻结完全一致才允许续跑；分支已移动则由 Worker 的
  -- catch 路径调用 fail_claimed_analysis_job，绝不混合两代输入。
  if v_job.analysis_context_version=2 and v_existing_inputs then
    if (select count(*) from public.analysis_repository_snapshot where job_id=p_job_id)
         <>jsonb_array_length(p_snapshots)
       or exists(
         select 1
         from jsonb_array_elements(p_snapshots) value
         left join public.analysis_repository_snapshot snapshot
           on snapshot.job_id=p_job_id
          and snapshot.repository_name=value->>'repository_name'
         where snapshot.id is null
            or lower(snapshot.commit_sha)<>lower(value->>'commit_sha')
       ) then
      raise exception 'PREPARATION_RECLAIM_HEAD_MISMATCH';
    end if;
    update public.analysis_job set locked_at=now() where id=p_job_id;
    perform public.freeze_analysis_job_scope_inputs(p_job_id,p_worker_id);
    return;
  end if;

  delete from public.analysis_repository_snapshot where job_id=p_job_id;
  for v_snap in select * from jsonb_array_elements(p_snapshots)
  loop
    insert into public.analysis_repository_snapshot(
      job_id,repository_name,requested_branch,commit_sha,commit_subject,
      head_sha,head_resolved_at,enumeration_status,mr_enrichment_status
    ) values(
      p_job_id,v_snap->>'repository_name',
      coalesce(v_snap->>'requested_branch',v_job.requested_branch),
      lower(v_snap->>'commit_sha'),nullif(v_snap->>'commit_subject',''),
      case when v_job.analysis_context_version=2 then lower(v_snap->>'commit_sha') else null end,
      case when v_job.analysis_context_version=2 then now() else null end,
      case when v_job.analysis_context_version=2 then 'PENDING' else null end,
      'UNAVAILABLE'
    );
  end loop;

  if v_job.analysis_context_version=1 then
    update public.analysis_job set status='PROCESSING' where id=p_job_id;
  else
    perform public.freeze_analysis_job_scope_inputs(p_job_id,p_worker_id);
  end if;
end;
$function$;

-- save_analysis_repository_commit_manifest：仅把硬编码仓库清单换成白名单函数调用，其余逐字保持迁移前的权威定义。
CREATE OR REPLACE FUNCTION public.save_analysis_repository_commit_manifest(p_job_id uuid, p_worker_id text, p_repository_name text, p_manifest jsonb, p_manifest_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_job public.analysis_job; v_snapshot public.analysis_repository_snapshot;
  v_commits jsonb; v_commit jsonb; v_file jsonb; v_commit_id uuid;
  v_count integer; v_enumeration text; v_head text; v_existing_hash text;
begin
  v_job := public.assert_analysis_scope_job_writer(p_job_id,p_worker_id,array['PREPARING_CODE','PREPARING_SCOPE']);
  if not (p_repository_name = any (public.analysis_allowed_repository_names())) then raise exception 'REPOSITORY_NOT_ALLOWED'; end if;
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
$function$;

-- save_analysis_repository_merge_requests：仅把硬编码仓库清单换成白名单函数调用，其余逐字保持迁移前的权威定义。
CREATE OR REPLACE FUNCTION public.save_analysis_repository_merge_requests(p_job_id uuid, p_worker_id text, p_repository_name text, p_status text, p_error_code text, p_merge_requests jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_job public.analysis_job;
  v_snapshot public.analysis_repository_snapshot;
  v_mr jsonb;
  v_membership jsonb;
  v_mr_id uuid;
  v_commit_id uuid;
  v_expected_project text;
  v_mr_count integer := 0;
  v_relation_count integer := 0;
begin
  v_job := public.assert_analysis_scope_job_writer(
    p_job_id,p_worker_id,array['PREPARING_SCOPE']
  );

  v_expected_project := public.analysis_repository_gitlab_project(p_repository_name);
  if v_expected_project is null then raise exception 'REPOSITORY_NOT_ALLOWED'; end if;
  if p_status not in ('UNAVAILABLE','COMPLETE','PARTIAL','FAILED') then
    raise exception 'MR_ENRICHMENT_STATUS_INVALID';
  end if;
  if (p_status = 'COMPLETE' and nullif(btrim(coalesce(p_error_code,'')),'') is not null)
     or (p_status <> 'COMPLETE' and nullif(btrim(coalesce(p_error_code,'')),'') is null) then
    raise exception 'MR_ENRICHMENT_ERROR_CODE_INVALID';
  end if;
  if jsonb_typeof(p_merge_requests) <> 'array'
     or jsonb_array_length(p_merge_requests) > 2000 then
    raise exception 'MR_METADATA_INPUT_INVALID';
  end if;
  if p_status in ('UNAVAILABLE','FAILED') and jsonb_array_length(p_merge_requests) <> 0 then
    raise exception 'MR_FAILED_STATUS_MUST_NOT_STORE_ROWS';
  end if;

  select * into v_snapshot
  from public.analysis_repository_snapshot
  where job_id=p_job_id and repository_name=p_repository_name
  for update;
  if v_snapshot.id is null then raise exception 'REPOSITORY_SNAPSHOT_NOT_FOUND'; end if;
  if v_snapshot.enumeration_status <> 'COMPLETE' or v_snapshot.commit_manifest_hash is null then
    raise exception 'COMMIT_MANIFEST_NOT_READY';
  end if;
  if exists(
    select 1
    from public.analysis_story_scope scope
    join public.analysis_story_task task on task.id=scope.task_id
    where task.job_id=p_job_id and scope.frozen_at is not null
  ) then raise exception 'ANALYSIS_SCOPE_ALREADY_FROZEN'; end if;

  delete from public.analysis_repository_merge_request where snapshot_id=v_snapshot.id;

  for v_mr in select * from jsonb_array_elements(p_merge_requests)
  loop
    if jsonb_typeof(v_mr) <> 'object'
       or v_mr->>'provider_project_id' is distinct from v_expected_project
       or coalesce((v_mr->>'merge_request_iid')::bigint,0) <= 0
       or coalesce(btrim(v_mr->>'title'),'') = ''
       or coalesce(btrim(v_mr->>'source_branch'),'') = ''
       or v_mr->>'target_branch' is distinct from v_job.requested_branch
       or coalesce(btrim(v_mr->>'author_username'),'') = ''
       or coalesce(btrim(v_mr->>'author_provider_id'),'') = ''
       or coalesce(v_mr->>'metadata_hash','') !~ '^(sha256:)?[0-9a-f]{64}$'
       or nullif(v_mr->>'provider_created_at','') is null
       or nullif(v_mr->>'provider_updated_at','') is null
       or nullif(v_mr->>'collected_at','') is null
       or jsonb_typeof(coalesce(v_mr->'structured_story_ids','[]'::jsonb)) <> 'array'
       or jsonb_typeof(coalesce(v_mr->'commits','[]'::jsonb)) <> 'array'
       or jsonb_array_length(coalesce(v_mr->'commits','[]'::jsonb)) > 5000 then
      raise exception 'MR_METADATA_INPUT_INVALID';
    end if;

    insert into public.analysis_repository_merge_request(
      snapshot_id,provider_project_id,merge_request_iid,source_branch,target_branch,
      title,description,structured_story_ids,author_display_name,author_username,
      author_provider_id,provider_created_at,provider_updated_at,merged_at,
      merge_commit_sha,squash_commit_sha,metadata_hash,collected_at
    ) values(
      v_snapshot.id,v_expected_project,(v_mr->>'merge_request_iid')::bigint,
      v_mr->>'source_branch',v_mr->>'target_branch',v_mr->>'title',
      nullif(v_mr->>'description',''),
      array(select value from jsonb_array_elements_text(
        coalesce(v_mr->'structured_story_ids','[]'::jsonb)
      ) value),
      nullif(v_mr->>'author_display_name',''),v_mr->>'author_username',
      v_mr->>'author_provider_id',(v_mr->>'provider_created_at')::timestamptz,
      (v_mr->>'provider_updated_at')::timestamptz,
      nullif(v_mr->>'merged_at','')::timestamptz,
      nullif(lower(v_mr->>'merge_commit_sha'),''),
      nullif(lower(v_mr->>'squash_commit_sha'),''),
      v_mr->>'metadata_hash',(v_mr->>'collected_at')::timestamptz
    ) returning id into v_mr_id;
    v_mr_count := v_mr_count + 1;

    for v_membership in select * from jsonb_array_elements(
      coalesce(v_mr->'commits','[]'::jsonb)
    )
    loop
      if lower(coalesce(v_membership->>'sha','')) !~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
         or v_membership->>'membership_type' not in ('COMMIT','MERGE_COMMIT','SQUASH_COMMIT')
         or (v_membership->>'membership_type'='MERGE_COMMIT'
             and lower(v_membership->>'sha') is distinct from lower(v_mr->>'merge_commit_sha'))
         or (v_membership->>'membership_type'='SQUASH_COMMIT'
             and lower(v_membership->>'sha') is distinct from lower(v_mr->>'squash_commit_sha')) then
        raise exception 'MR_COMMIT_MEMBERSHIP_INVALID';
      end if;

      select repo_commit.id into v_commit_id
      from public.analysis_repository_commit repo_commit
      where repo_commit.snapshot_id=v_snapshot.id
        and repo_commit.sha=lower(v_membership->>'sha');
      if v_commit_id is not null then
        insert into public.analysis_merge_request_commit(
          merge_request_id,commit_id,membership_type
        ) values(v_mr_id,v_commit_id,v_membership->>'membership_type')
        on conflict do nothing;
        if found then v_relation_count := v_relation_count + 1; end if;
      end if;
    end loop;
  end loop;

  update public.analysis_repository_snapshot
  set mr_enrichment_status=p_status,
      mr_enrichment_error_code=nullif(btrim(coalesce(p_error_code,'')),'')
  where id=v_snapshot.id;

  return jsonb_build_object(
    'snapshot_id',v_snapshot.id,
    'status',p_status,
    'merge_request_count',v_mr_count,
    'relation_count',v_relation_count
  );
end;
$function$;

commit;
