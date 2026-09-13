-- 0032_analysis_runtime_monitoring.sql
--
-- V1.5 真实运行监控台：expand-only 迁移。
--
--   * `analysis_runtime_event`：唯一的浏览器实时事实流，append-only，带 `xact_id`
--     提交水位，30 天保留期。
--   * `analysis_agent_node.current_activity_*`：高频当前活动投影（每 Agent 一行，
--     天然分片，无 `touch_updated_at` 触发器）。
--   * `analysis_agent_run.attempt_phase_*`：低频 ATTEMPT 阶段投影。
--   * `analysis_agent_run_rollup`：墙钟时间归因基线，长期保留、不随事件清理。
--   * 写入入口 `report_analysis_runtime_event_batch`（service_role）。
--   * 查询入口 `admin_list_active_analysis_batches` / `get_analysis_runtime_console`。
--   * AI 诊断入口三件套，只授予 service_role。
--
-- 终态事件的原子性实现方式（对方案 §6.6 的实现级说明）：
--   方案列出了 15 个必须"在事务内原子插入终态事件"的现有 RPC。本迁移不重新声明这
--   15 个函数体（那需要从 0016/0019/0024/0027 逐字复制约 1500 行业务逻辑，任何转录
--   偏差都会破坏已上线的提交/fencing 语义），而是在这些 RPC 唯一会写到的业务表上挂
--   `after insert/update` 行级触发器：
--     analysis_job        → JOB_PREPARATION_STARTED / JOB_SNAPSHOTS_FROZEN /
--                           JOB_FINALIZATION_STARTED / JOB_RETRIED /
--                           JOB_SUCCEEDED / JOB_FAILED
--     analysis_story_task → TASK_CLAIMED
--     analysis_agent_run  → ATTEMPT_STARTED / ATTEMPT_COMMITTED / ATTEMPT_FAILED /
--                           CANCEL_REQUESTED / LEASE_LOST /
--                           TASK_RELEASED_FOR_SHUTDOWN
--                           （+ 清投影 + 补未闭合 correlation + 汇总）
--     analysis_agent_node → ROOT_AGENT_REGISTERED / AGENT_REGISTERED /
--                           AGENT_FINISHED / AGENT_FAILED / AGENT_CANCELLED
--   行级触发器与触发它的 RPC 在同一个事务内执行，因此"业务终态与终态事件同时提交或
--   同时回滚"这一硬要求逐字成立，而且覆盖面严格更大（任何未来新增的写入路径都会被
--   自动覆盖，不会再出现"忘了在第 16 个 RPC 里补一行"）。
--   提交后 claim 被清空（§6.4.1）对触发器完全无影响：它不做 claim 校验。

begin;

------------------------------------------------------------------------------
-- 1. analysis_runtime_event：append-only 事实事件流
------------------------------------------------------------------------------

create table if not exists public.analysis_runtime_event (
  id bigint generated always as identity primary key,
  -- 提交水位。id 在 INSERT 时取号，可见性按提交顺序，两者不一致；查询侧必须用
  -- xact_id 与 pg_snapshot_xmin 裁剪，否则并发写入会让游标永久跳过事件。
  xact_id bigint not null default pg_current_xact_id()::text::bigint,
  event_uuid uuid not null,
  schema_version smallint not null default 1 check (schema_version = 1),

  batch_id uuid not null references public.review_batch(id) on delete cascade,
  job_id uuid not null references public.analysis_job(id) on delete cascade,
  task_id uuid references public.analysis_story_task(id) on delete cascade,
  agent_run_id uuid references public.analysis_agent_run(id) on delete cascade,
  agent_node_id uuid references public.analysis_agent_node(id) on delete set null,

  worker_id text,
  scope text not null check (scope in (
    'JOB', 'TASK', 'ATTEMPT', 'AGENT', 'MODEL', 'TOOL', 'WORKFLOW', 'HARNESS_JOB'
  )),
  event_type text not null,
  activity_code text,
  phase text check (phase is null or phase in ('STARTED', 'TERMINAL')),
  status text,
  correlation_id text,
  parent_correlation_id text,
  error_code text,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  payload jsonb not null default '{}'::jsonb,

  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  -- 预留的分区键。由 RPC 从钳制后的 occurred_at 确定性推导，重试时值不变。
  event_day date not null,
  clock_skewed boolean not null default false,
  retention_until timestamptz not null default (now() + interval '30 days'),

  constraint analysis_runtime_event_uuid_unique unique (event_uuid),
  constraint analysis_runtime_event_payload_size
    check (octet_length(payload::text) <= 2048),
  constraint analysis_runtime_event_task_required
    check (scope in ('JOB') or task_id is not null),
  constraint analysis_runtime_event_run_required
    check (scope not in ('ATTEMPT', 'AGENT', 'MODEL', 'TOOL', 'WORKFLOW', 'HARNESS_JOB')
           or agent_run_id is not null),
  constraint analysis_runtime_event_correlation_required
    check (scope not in ('MODEL', 'TOOL', 'WORKFLOW', 'HARNESS_JOB')
           or correlation_id is not null)
);

comment on table public.analysis_runtime_event is
  'Append-only runtime facts for the V1.5 monitoring console. Safe metadata only: '
  'no prompt, no source code, no tool payload, no command, no URL, no credentials. '
  'Cursor consumers MUST clamp by xact_id against pg_snapshot_xmin.';

comment on column public.analysis_runtime_event.xact_id is
  'Writing transaction id. id is assigned at INSERT time but rows become visible in '
  'commit order; a naive max(id) cursor would permanently skip late-committing rows.';

comment on column public.analysis_runtime_event.event_day is
  'Reserved partition key derived deterministically from the clamped occurred_at so '
  'a retry of the same event_uuid always lands on the same day.';

create index if not exists idx_analysis_runtime_event_batch_cursor
  on public.analysis_runtime_event(batch_id, id) include (xact_id);
create index if not exists idx_analysis_runtime_event_task_cursor
  on public.analysis_runtime_event(task_id, id) where task_id is not null;
create index if not exists idx_analysis_runtime_event_run_cursor
  on public.analysis_runtime_event(agent_run_id, id) where agent_run_id is not null;
create index if not exists idx_analysis_runtime_event_open_correlation
  on public.analysis_runtime_event(agent_run_id, correlation_id)
  where phase = 'STARTED';
create index if not exists idx_analysis_runtime_event_terminal_correlation
  on public.analysis_runtime_event(agent_run_id, correlation_id)
  where phase = 'TERMINAL';
create index if not exists idx_analysis_runtime_event_node
  on public.analysis_runtime_event(agent_node_id, id) where agent_node_id is not null;
create index if not exists idx_analysis_runtime_event_retention
  on public.analysis_runtime_event(retention_until);

alter table public.analysis_runtime_event enable row level security;
revoke all on public.analysis_runtime_event from anon, authenticated;

------------------------------------------------------------------------------
-- 2. 当前活动投影（分层，避免热行）
------------------------------------------------------------------------------

alter table public.analysis_agent_node
  add column if not exists current_activity_scope text,
  add column if not exists current_activity_code text,
  add column if not exists current_activity_status text,
  add column if not exists current_correlation_id text,
  add column if not exists current_tool_name text,
  add column if not exists current_activity_started_at timestamptz,
  add column if not exists current_activity_updated_at timestamptz,
  -- 裸 bigint，不加外键：它是游标语义不是关系语义。
  add column if not exists current_activity_event_id bigint;

alter table public.analysis_agent_run
  add column if not exists attempt_phase_code text,
  add column if not exists attempt_phase_started_at timestamptz,
  add column if not exists attempt_phase_event_id bigint;

comment on column public.analysis_agent_node.current_activity_event_id is
  'Monotonic runtime-event cursor for this projection row. Bare bigint on purpose: '
  'a foreign key would make every retention delete write back into the business table.';

------------------------------------------------------------------------------
-- 3. analysis_agent_run_rollup：归因基线，长期保留
------------------------------------------------------------------------------

create table if not exists public.analysis_agent_run_rollup (
  agent_run_id uuid primary key
    references public.analysis_agent_run(id) on delete cascade,
  task_id uuid not null,
  job_id uuid not null,
  batch_id uuid not null,
  agent_attempt integer not null,
  worker_id text,

  model_label text,
  harness_version text,
  capability_contract_hash text,
  profile_config_hash text,
  policy_hash text,
  prompt_version text,
  policy_version integer,

  terminal_status text not null,
  terminal_error_code text,
  end_reason text,
  resumed boolean not null default false,
  resume_count integer not null default 0,

  wall_ms integer not null,
  setup_ms integer not null default 0,
  model_ms_union integer not null default 0,
  tool_ms_union integer not null default 0,
  /*
   * 平台 origin 工具（经 Broker 读冻结快照 / 提交结论）的区间并集。
   *
   * §1.2 第 13 条要回答"慢是模型侧还是平台侧"，依据写的是
   * `model_ms_union` vs `tool_ms_union` vs `db_ms`。`db_ms` 这个名字在这里是**不诚实**的：
   * `read_snapshot_code` 读的是本地 git 对象，不是数据库。所以列名按它真正测的东西命名。
   *
   * Worker → Supabase 的 RPC 往返首版**没有插桩**，它落在 `unattributed_ms` 里 ——
   * 这正是那个桶存在的理由。`get_analysis_attempt_diagnostics.instrumentation_gaps`
   * 会把这条盲区显式告诉 AI，而不是让它以为三项都齐了。
   */
  platform_tool_ms_union integer not null default 0,
  busy_ms_union integer not null default 0,
  teardown_ms integer not null default 0,
  agent_idle_ms integer not null default 0,
  unattributed_ms integer not null default 0,
  model_ms_sum integer not null default 0,
  tool_ms_sum integer not null default 0,

  agent_count integer not null default 1,
  max_depth integer not null default 0,
  max_concurrent_agents integer not null default 1,
  max_concurrent_tools integer not null default 0,
  model_requests integer not null default 0,
  model_requests_by_kind jsonb not null default '{}'::jsonb,
  model_requests_denied integer not null default 0,
  tool_calls integer not null default 0,
  tool_calls_denied integer not null default 0,
  tool_calls_failed integer not null default 0,
  tool_ms_by_name jsonb not null default '{}'::jsonb,
  tool_calls_by_name jsonb not null default '{}'::jsonb,
  input_tokens bigint,
  output_tokens bigint,
  evidence_count integer not null default 0,
  artifact_count integer not null default 0,
  rejected_submissions integer not null default 0,

  per_agent jsonb not null default '[]'::jsonb,

  events_reported integer not null default 0,
  events_dropped integer not null default 0,

  started_at timestamptz not null,
  finished_at timestamptz not null,
  computed_at timestamptz not null default now(),
  rollup_version smallint not null default 1,

  constraint analysis_agent_run_rollup_terminal_status_check
    check (terminal_status in ('COMMITTED', 'FAILED')),
  constraint analysis_agent_run_rollup_nonnegative_check
    check (
      wall_ms >= 0 and setup_ms >= 0 and model_ms_union >= 0 and tool_ms_union >= 0
      and platform_tool_ms_union >= 0
      and busy_ms_union >= 0 and teardown_ms >= 0 and agent_idle_ms >= 0
      and unattributed_ms >= 0 and model_ms_sum >= 0 and tool_ms_sum >= 0
      and rollup_version >= 0
    )
);

comment on table public.analysis_agent_run_rollup is
  'Per-attempt wall-clock attribution baseline. Never purged: runtime events expire '
  'after 30 days but cross-month "did the optimisation help" comparisons must survive.';

create index if not exists idx_run_rollup_trend
  on public.analysis_agent_run_rollup(model_label, policy_hash, finished_at desc);
create index if not exists idx_run_rollup_batch
  on public.analysis_agent_run_rollup(batch_id, finished_at desc);
create index if not exists idx_run_rollup_error
  on public.analysis_agent_run_rollup(terminal_error_code, finished_at desc)
  where terminal_error_code is not null;
create index if not exists idx_run_rollup_pending
  on public.analysis_agent_run_rollup(agent_run_id)
  where rollup_version = 0;

alter table public.analysis_agent_run_rollup enable row level security;
revoke all on public.analysis_agent_run_rollup from anon, authenticated;

------------------------------------------------------------------------------
-- 4. 事件目录：唯一的 event_type → scope/phase/activity_code/payload keys 映射
--
--    未登记的 event_type 一律拒绝。Workflow / Harness Job 的事件类型故意不在这里，
--    因为 Phase 3 之前平台没有它们的真实生命周期边界（方案 §2.1 / §6.3）。
------------------------------------------------------------------------------

create or replace function public.analysis_runtime_event_catalog()
returns jsonb
language sql
immutable
as $$
select '{
  "JOB_PREPARATION_STARTED":      {"scope":"JOB","activity_code":"JOB_PREPARING_CODE","keys":[]},
  "REPOSITORY_PREPARE_STARTED":   {"scope":"JOB","activity_code":"REPOSITORY_PREPARING","keys":["repository_name"]},
  "REPOSITORY_PREPARE_COMPLETED": {"scope":"JOB","activity_code":"REPOSITORY_PREPARING","keys":["repository_name","duration_ms"]},
  "REPOSITORY_PREPARE_FAILED":    {"scope":"JOB","activity_code":"REPOSITORY_PREPARING","keys":["repository_name","duration_ms"]},
  "JOB_SNAPSHOTS_FROZEN":         {"scope":"JOB","activity_code":"JOB_PROCESSING","keys":[]},
  "JOB_FINALIZATION_STARTED":     {"scope":"JOB","activity_code":"JOB_FINALIZING","keys":[]},
  "JOB_RETRIED":                  {"scope":"JOB","activity_code":"JOB_QUEUED","keys":[]},
  "JOB_SUCCEEDED":                {"scope":"JOB","activity_code":"JOB_SUCCEEDED","keys":[]},
  "JOB_FAILED":                   {"scope":"JOB","activity_code":"JOB_FAILED","keys":["reason_code"]},

  "TASK_CLAIMED":                 {"scope":"TASK","activity_code":"TASK_RUNNING","keys":["attempt_number"]},
  "TASK_REPOSITORIES_STARTED":    {"scope":"TASK","activity_code":"TASK_REPOSITORIES_PREPARING","keys":[]},
  "TASK_REPOSITORIES_READY":      {"scope":"TASK","activity_code":"TASK_REPOSITORIES_READY","keys":["duration_ms"]},
  "TASK_RELEASED_FOR_SHUTDOWN":   {"scope":"TASK","activity_code":"TASK_RELEASED","keys":["attempt_number","reason_code"]},

  "ATTEMPT_STARTED":              {"scope":"ATTEMPT","activity_code":"ATTEMPT_STARTING","keys":["attempt_number","session_revision"]},
  "RUNTIME_CONTRACT_VERIFIED":    {"scope":"ATTEMPT","activity_code":"ATTEMPT_STARTING","keys":[]},
  "RUNTIME_CONTRACT_REJECTED":    {"scope":"ATTEMPT","activity_code":"ATTEMPT_STARTING","keys":["reason_code"]},
  "PINS_VERIFIED":                {"scope":"ATTEMPT","activity_code":"VERIFYING_PINS","keys":["duration_ms"]},
  "SESSION_SLOT_ACQUIRED":        {"scope":"ATTEMPT","activity_code":"SESSION_PREPARING","keys":[]},
  "WORKSPACE_READY":              {"scope":"ATTEMPT","activity_code":"WORKSPACE_PREPARING","keys":["duration_ms"]},
  "BROKER_READY":                 {"scope":"ATTEMPT","activity_code":"BROKER_STARTING","keys":[]},
  "PROFILE_FROZEN":               {"scope":"ATTEMPT","activity_code":"PROFILE_FREEZING","keys":[]},
  "HARNESS_PROCESS_STARTED":      {"scope":"ATTEMPT","activity_code":"HARNESS_STARTING","keys":[]},
  "SESSION_RESUMED":              {"scope":"ATTEMPT","activity_code":"SESSION_RESUMING","keys":["session_revision","resumed"]},
  "ACP_TURN_STARTED":             {"scope":"ATTEMPT","activity_code":"MODEL_ORCHESTRATION","keys":[]},
  "ATTEMPT_INSTRUMENTATION_REPORTED": {"scope":"ATTEMPT","activity_code":"ATTEMPT_CONVERGING","keys":["events_reported","events_dropped"]},
  "PROCESS_TREE_CLEANUP_FAILED":  {"scope":"ATTEMPT","activity_code":"ATTEMPT_CONVERGING","keys":["reason_code"]},
  "ATTEMPT_COMMITTED":            {"scope":"ATTEMPT","activity_code":"RESULT_COMMITTED","keys":["attempt_number","agent_count","duration_ms"]},
  "ATTEMPT_FAILED":               {"scope":"ATTEMPT","activity_code":"ATTEMPT_FAILED","keys":["attempt_number","agent_count","duration_ms","reason_code"]},
  "CANCEL_REQUESTED":             {"scope":"ATTEMPT","activity_code":"ATTEMPT_CANCELLING","keys":["reason_code"]},
  "LEASE_LOST":                   {"scope":"ATTEMPT","activity_code":"ATTEMPT_LEASE_LOST","keys":["attempt_number","reason_code"]},

  "ROOT_AGENT_REGISTERED":        {"scope":"AGENT","activity_code":"AGENT_RUNNING","status":"RUNNING","keys":["agent_role","provider","delegation_depth"]},
  "AGENT_REGISTERED":             {"scope":"AGENT","activity_code":"AGENT_RUNNING","status":"RUNNING","keys":["agent_role","provider","delegation_depth"]},
  "AGENT_FINISHED":               {"scope":"AGENT","activity_code":"AGENT_FINISHED","status":"FINISHED","keys":["agent_role","provider","delegation_depth","duration_ms"]},
  "AGENT_FAILED":                 {"scope":"AGENT","activity_code":"AGENT_FAILED","status":"FAILED","keys":["agent_role","provider","delegation_depth","duration_ms"]},
  "AGENT_CANCELLED":              {"scope":"AGENT","activity_code":"AGENT_CANCELLED","status":"CANCELLED","keys":["agent_role","provider","delegation_depth","duration_ms"]},

  "MODEL_REQUEST_STARTED":        {"scope":"MODEL","phase":"STARTED","activity_code":"MODEL_REQUESTING","status":"RUNNING","keys":["model_request_kind","agent_role","retry_index","request_bytes"]},
  "MODEL_REQUEST_COMPLETED":      {"scope":"MODEL","phase":"TERMINAL","activity_code":"MODEL_REQUESTING","status":"COMPLETED","keys":["model_request_kind","agent_role","retry_index","input_tokens","output_tokens","duration_ms","collapsed"]},
  "MODEL_REQUEST_FAILED":         {"scope":"MODEL","phase":"TERMINAL","activity_code":"MODEL_REQUESTING","status":"FAILED","keys":["model_request_kind","agent_role","retry_index","duration_ms","collapsed"]},
  "MODEL_REQUEST_DENIED":         {"scope":"MODEL","phase":"TERMINAL","activity_code":"MODEL_REQUESTING","status":"DENIED","keys":["model_request_kind","agent_role","reason_code","permission_verdict"]},

  "TOOL_CALL_STARTED":            {"scope":"TOOL","phase":"STARTED","activity_code":"TOOL_RUNNING","status":"RUNNING","keys":["tool_name","agent_role","provider","request_bytes"]},
  "TOOL_CALL_COMPLETED":          {"scope":"TOOL","phase":"TERMINAL","activity_code":"TOOL_RUNNING","status":"COMPLETED","keys":["tool_name","agent_role","duration_ms","collapsed","exit_code","output_bytes","response_bytes","truncated","hit_count","line_span"]},
  "TOOL_CALL_FAILED":             {"scope":"TOOL","phase":"TERMINAL","activity_code":"TOOL_RUNNING","status":"FAILED","keys":["tool_name","agent_role","duration_ms","collapsed","exit_code","output_bytes"]},
  "TOOL_CALL_DENIED":             {"scope":"TOOL","phase":"TERMINAL","activity_code":"TOOL_RUNNING","status":"DENIED","keys":["tool_name","agent_role","permission_verdict","reason_code"]},
  "TOOL_CALL_CANCELLED":          {"scope":"TOOL","phase":"TERMINAL","activity_code":"TOOL_RUNNING","status":"CANCELLED","keys":["tool_name","agent_role","duration_ms"]}
}'::jsonb;
$$;

comment on function public.analysis_runtime_event_catalog() is
  'The single source of truth for event_type -> scope/phase/activity_code/payload keys. '
  'Unknown event types are rejected; Workflow / Harness Job types are intentionally '
  'absent until Phase 3 provides real broker lifecycle routes.';

-- 允许出现在 payload.tool_name 里的工具名：契约的 30 个 modelTools，加上 Broker
-- 路由桶名（`/attempt/<bucket>`）。任意字符串一律丢弃。
create or replace function public.analysis_runtime_known_tool_names()
returns text[]
language sql
immutable
as $$
select array[
  'search_snapshot_code', 'find_snapshot_files', 'read_snapshot_code',
  'list_snapshot_commits', 'submit_review_result', 'skill', 'todo_write',
  'create_goal', 'update_goal', 'get_goal', 'ralph', 'subagent', 'subagent_fork',
  'send_message', 'interrupt_agent', 'list_agents', 'workflow', 'job_list',
  'job_output', 'job_kill', 'bash', 'read', 'read_image', 'write', 'edit',
  'grep', 'glob', 'web_search', 'web_fetch', 'exit_plan_mode',
  'search-code', 'find-files', 'read-code', 'list-commits', 'snapshot-pins',
  'register-agent', 'finish-agent', 'report-usage', 'reserve-model-request',
  'web-egress', 'save-artifact', 'tool-audit', 'submit-review'
]::text[];
$$;

-- 平台 origin 工具：这 5 个经 Broker 执行（读冻结快照 / 提交结论），其余 25 个是
-- harness origin，在 Harness 进程内执行。区分它们才能回答"慢是模型侧还是平台侧"。
create or replace function public.analysis_runtime_platform_tool_names()
returns text[]
language sql
immutable
as $$
select array[
  'search_snapshot_code', 'find_snapshot_files', 'read_snapshot_code',
  'list_snapshot_commits', 'submit_review_result'
]::text[];
$$;

------------------------------------------------------------------------------
-- 5. Payload allowlist：数据库重建 payload，绝不原样落库
------------------------------------------------------------------------------

create or replace function public.analysis_runtime_event_payload(
  p_event_type text,
  p_payload jsonb
)
returns jsonb
language plpgsql
immutable
as $$
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
        if v_raw in ('kdmanage-backend', 'kdmanage-frontend',
                     'tmanage-backend', 'tmanage-frontend') then
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
$$;

comment on function public.analysis_runtime_event_payload(text, jsonb) is
  'Rebuilds an event payload from the per-event-type allowlist. Unknown keys are '
  'dropped, enum values are validated, and free-form text can never reach the table.';

------------------------------------------------------------------------------
-- 6. insert_analysis_runtime_event：内部唯一写入点，同事务更新投影
------------------------------------------------------------------------------

create or replace function public.insert_analysis_runtime_event(
  p_event_uuid uuid,
  p_batch_id uuid,
  p_job_id uuid,
  p_task_id uuid,
  p_agent_run_id uuid,
  p_agent_node_id uuid,
  p_worker_id text,
  p_scope text,
  p_event_type text,
  p_phase text,
  p_activity_code text,
  p_status text,
  p_correlation_id text,
  p_parent_correlation_id text,
  p_error_code text,
  p_duration_ms integer,
  p_occurred_at timestamptz,
  p_payload jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_spec jsonb := public.analysis_runtime_event_catalog() -> p_event_type;
  v_scope text;
  v_phase text;
  v_activity text;
  v_status text;
  v_received timestamptz := now();
  v_occurred timestamptz;
  v_skewed boolean := false;
  v_payload jsonb;
  v_id bigint;
  v_error_code text;
begin
  if v_spec is null then
    raise exception 'RUNTIME_EVENT_TYPE_UNKNOWN: %', p_event_type;
  end if;

  v_scope := v_spec ->> 'scope';
  v_phase := v_spec ->> 'phase';
  v_activity := coalesce(v_spec ->> 'activity_code', p_activity_code);
  v_status := coalesce(v_spec ->> 'status', p_status);

  if p_scope is not null and p_scope <> v_scope then
    raise exception 'RUNTIME_EVENT_SCOPE_MISMATCH: % expects %', p_event_type, v_scope;
  end if;
  if p_phase is not null and p_phase is distinct from v_phase then
    raise exception 'RUNTIME_EVENT_PHASE_MISMATCH: % expects %', p_event_type, coalesce(v_phase, 'null');
  end if;
  if v_scope in ('MODEL', 'TOOL', 'WORKFLOW', 'HARNESS_JOB')
     and nullif(btrim(coalesce(p_correlation_id, '')), '') is null then
    raise exception 'RUNTIME_EVENT_CORRELATION_REQUIRED: %', p_event_type;
  end if;

  -- 时钟偏差：保留事件、钳到确定性目标，不丢弃。钳制目标必须对重试稳定，
  -- 所以取 date_trunc('second', received_at)。
  v_occurred := p_occurred_at;
  if v_occurred is null
     or v_occurred > v_received + interval '60 seconds'
     or v_occurred < v_received - interval '24 hours' then
    v_occurred := date_trunc('second', v_received);
    v_skewed := true;
  end if;

  v_payload := public.analysis_runtime_event_payload(p_event_type, p_payload);

  -- error_code 必须是稳定机器码；异常 message 一律丢弃。
  v_error_code := nullif(btrim(coalesce(p_error_code, '')), '');
  if v_error_code is not null and v_error_code !~ '^[A-Za-z][A-Za-z0-9_.-]{0,63}$' then
    v_error_code := 'UNKNOWN_ERROR';
  end if;

  insert into public.analysis_runtime_event (
    event_uuid, batch_id, job_id, task_id, agent_run_id, agent_node_id, worker_id,
    scope, event_type, activity_code, phase, status, correlation_id,
    parent_correlation_id, error_code, duration_ms, payload,
    occurred_at, received_at, event_day, clock_skewed
  ) values (
    p_event_uuid, p_batch_id, p_job_id,
    case when v_scope = 'JOB' then null else p_task_id end,
    p_agent_run_id,
    p_agent_node_id,
    nullif(btrim(coalesce(p_worker_id, '')), ''),
    v_scope, p_event_type, v_activity, v_phase, v_status,
    nullif(btrim(coalesce(p_correlation_id, '')), ''),
    nullif(btrim(coalesce(p_parent_correlation_id, '')), ''),
    v_error_code,
    case when p_duration_ms is null or p_duration_ms < 0 then null else p_duration_ms end,
    v_payload, v_occurred, v_received, v_occurred::date, v_skewed
  )
  on conflict (event_uuid) do nothing
  returning id into v_id;

  if v_id is null then
    -- 幂等：同一个 event_uuid 重试只产生一行，返回原 id，且不重复更新投影。
    select id into v_id from public.analysis_runtime_event where event_uuid = p_event_uuid;
    return v_id;
  end if;

  perform public.apply_analysis_runtime_projection(
    v_id, v_scope, p_event_type, v_phase, v_activity, v_status,
    p_agent_run_id, p_agent_node_id, p_correlation_id, v_payload, v_occurred
  );

  return v_id;
end;
$$;

revoke execute on function public.insert_analysis_runtime_event(
  uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, text, text,
  text, text, integer, timestamptz, jsonb
) from public, anon, authenticated, service_role;

------------------------------------------------------------------------------
-- 7. 投影应用：同事务、单调、correlation 配对
------------------------------------------------------------------------------

create or replace function public.apply_analysis_runtime_projection(
  p_event_id bigint,
  p_scope text,
  p_event_type text,
  p_phase text,
  p_activity_code text,
  p_status text,
  p_agent_run_id uuid,
  p_agent_node_id uuid,
  p_correlation_id text,
  p_payload jsonb,
  p_occurred_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- ATTEMPT scope：低频，只写 run 上的阶段列（约 10~15 条/attempt，不构成热行）。
  if p_scope = 'ATTEMPT' and p_agent_run_id is not null then
    update public.analysis_agent_run
    set attempt_phase_code = p_activity_code,
        attempt_phase_started_at = p_occurred_at,
        attempt_phase_event_id = p_event_id
    where id = p_agent_run_id
      and coalesce(attempt_phase_event_id, 0) < p_event_id;
    return;
  end if;

  if p_agent_node_id is null then
    return;
  end if;

  -- Agent 终态：清空运行态，保留最后 event id 与更新时间。
  if p_scope = 'AGENT' then
    if p_event_type in ('AGENT_FINISHED', 'AGENT_FAILED', 'AGENT_CANCELLED') then
      update public.analysis_agent_node
      set current_activity_scope = null,
          current_activity_code = null,
          current_activity_status = null,
          current_correlation_id = null,
          current_tool_name = null,
          current_activity_started_at = null,
          current_activity_updated_at = p_occurred_at,
          current_activity_event_id = p_event_id
      where id = p_agent_node_id
        and coalesce(current_activity_event_id, 0) < p_event_id;
    end if;
    return;
  end if;

  if p_scope not in ('MODEL', 'TOOL', 'WORKFLOW', 'HARNESS_JOB') then
    return;
  end if;

  if p_phase = 'STARTED' then
    update public.analysis_agent_node
    set current_activity_scope = p_scope,
        current_activity_code = p_activity_code,
        current_activity_status = 'RUNNING',
        current_correlation_id = p_correlation_id,
        current_tool_name = p_payload ->> 'tool_name',
        current_activity_started_at = p_occurred_at,
        current_activity_updated_at = p_occurred_at,
        current_activity_event_id = p_event_id
    where id = p_agent_node_id
      and coalesce(current_activity_event_id, 0) < p_event_id;
  elsif p_phase = 'TERMINAL' then
    -- correlation 不同说明已有更新的活动占据了投影：不覆盖。
    update public.analysis_agent_node
    set current_activity_status = coalesce(p_status, 'COMPLETED'),
        current_activity_updated_at = p_occurred_at,
        current_activity_event_id = p_event_id
    where id = p_agent_node_id
      and coalesce(current_activity_event_id, 0) < p_event_id
      and current_correlation_id = p_correlation_id;
  end if;
end;
$$;

revoke execute on function public.apply_analysis_runtime_projection(
  bigint, text, text, text, text, text, uuid, uuid, text, jsonb, timestamptz
) from public, anon, authenticated, service_role;

------------------------------------------------------------------------------
-- 8. 终态收敛：清投影 + 补写未闭合 correlation
--
--    Harness 进程被 SIGKILL 时会留下永远"正在调用"的孤儿；Attempt 终态与租约回收
--    必须在同一事务里把它们闭合掉。补写事件的 event_uuid 由 (run, correlation) 确定
--    性推导，重复调用幂等。
------------------------------------------------------------------------------

create or replace function public.seal_analysis_runtime_projection(
  p_agent_run_id uuid,
  p_reason_code text default 'ATTEMPT_SEALED'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.analysis_agent_run;
  v_job public.analysis_job;
  v_open record;
  v_closed integer := 0;
  v_reason text := coalesce(nullif(btrim(p_reason_code), ''), 'ATTEMPT_SEALED');
begin
  select * into v_run from public.analysis_agent_run where id = p_agent_run_id;
  if v_run.id is null then
    return 0;
  end if;
  select * into v_job from public.analysis_job where id = v_run.job_id;
  if v_job.id is null then
    return 0;
  end if;

  for v_open in
    select started.correlation_id,
           started.scope,
           started.agent_node_id,
           started.payload ->> 'tool_name' as tool_name,
           started.payload ->> 'agent_role' as agent_role,
           started.payload ->> 'model_request_kind' as model_request_kind,
           started.occurred_at
    from public.analysis_runtime_event started
    where started.agent_run_id = p_agent_run_id
      and started.phase = 'STARTED'
      and not exists (
        select 1 from public.analysis_runtime_event terminal
        where terminal.agent_run_id = p_agent_run_id
          and terminal.correlation_id = started.correlation_id
          and terminal.phase = 'TERMINAL'
      )
  loop
    perform public.insert_analysis_runtime_event(
      md5('runtime-seal:' || p_agent_run_id::text || ':' || v_open.correlation_id)::uuid,
      v_job.batch_id, v_run.job_id, v_run.task_id, p_agent_run_id, v_open.agent_node_id,
      v_run.worker_id,
      null,
      case when v_open.scope = 'MODEL' then 'MODEL_REQUEST_FAILED' else 'TOOL_CALL_CANCELLED' end,
      null, null, null,
      v_open.correlation_id, null, v_reason,
      greatest(0, (extract(epoch from (now() - v_open.occurred_at)) * 1000)::integer),
      now(),
      jsonb_strip_nulls(jsonb_build_object(
        'tool_name', v_open.tool_name,
        'agent_role', v_open.agent_role,
        'model_request_kind', v_open.model_request_kind
      ))
    );
    v_closed := v_closed + 1;
  end loop;

  -- 无条件清空该 run 下所有 node 的运行态：漏掉这一步会让监控台永久显示一个已死
  -- Worker 的"正在调用工具"。
  update public.analysis_agent_node
  set current_activity_scope = null,
      current_activity_code = null,
      current_activity_status = null,
      current_correlation_id = null,
      current_tool_name = null,
      current_activity_started_at = null,
      current_activity_updated_at = now()
  where agent_run_id = p_agent_run_id
    and (
      current_activity_scope is not null
      or current_activity_status is not null
      or current_correlation_id is not null
    );

  return v_closed;
end;
$$;

revoke execute on function public.seal_analysis_runtime_projection(uuid, text)
  from public, anon, authenticated;
grant execute on function public.seal_analysis_runtime_projection(uuid, text) to service_role;

------------------------------------------------------------------------------
-- 9. report_analysis_runtime_event_batch：Worker 唯一写入入口
--
--    fencing 按方案 §6.4 分层：
--      * 无 task 的 JOB 阶段用 analysis_job.worker_id / finalizer_worker_id + lease；
--      * task 及以下用四要素（worker + lease + claim token digest + attempt）；
--      * 收敛路径（claim 已被清空）用 agent_run_id + session_revision（§6.4.1）。
------------------------------------------------------------------------------

create or replace function public.report_analysis_runtime_event_batch(
  p_worker_id text,
  p_job_id uuid,
  p_task_id uuid default null,
  p_claim_token uuid default null,
  p_agent_attempt integer default null,
  p_events jsonb default '[]'::jsonb,
  p_session_revision integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.analysis_job;
  v_task public.analysis_story_task;
  v_run public.analysis_agent_run;
  v_event jsonb;
  v_event_uuid uuid;
  v_event_type text;
  v_agent_id text;
  v_node_id uuid;
  v_scope text;
  v_id bigint;
  v_accepted integer := 0;
  v_duplicated integer := 0;
  v_dropped_agent integer := 0;
  v_dropped_invalid integer := 0;
  v_max_id bigint := 0;
  v_claim_ok boolean := false;
  v_uuids uuid[] := array[]::uuid[];
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;
  if p_job_id is null then
    raise exception 'job_id is required';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception 'events must be an array';
  end if;

  select * into v_job from public.analysis_job where id = p_job_id;
  if v_job.id is null then
    raise exception 'job not found';
  end if;

  if p_task_id is null then
    -- Job 层：准备阶段看 worker_id，汇总阶段看 finalizer_worker_id + lease。
    if not (
      (v_job.status = 'PREPARING_CODE' and v_job.worker_id = p_worker_id)
      or (
        v_job.status = 'FINALIZING'
        and v_job.finalizer_worker_id = p_worker_id
        and v_job.finalize_lease_expires_at is not null
        and v_job.finalize_lease_expires_at >= now()
      )
    ) then
      raise exception 'RUNTIME_EVENT_FENCE_REJECTED';
    end if;
  else
    select * into v_task from public.analysis_story_task where id = p_task_id;
    if v_task.id is null or v_task.job_id <> p_job_id then
      raise exception 'RUNTIME_EVENT_FENCE_REJECTED';
    end if;

    v_claim_ok := (
      p_claim_token is not null
      and v_task.worker_id = p_worker_id
      and v_task.lease_expires_at is not null
      and v_task.lease_expires_at >= now()
      and v_task.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
      and p_agent_attempt is not null
      and p_agent_attempt = v_task.agent_attempt
    );

    if p_agent_attempt is not null then
      select * into v_run from public.analysis_agent_run
      where task_id = p_task_id and agent_attempt = p_agent_attempt;
    end if;

    if not v_claim_ok then
      -- 收敛路径：提交/失败后 claim 已被清空，只能用 session_revision fencing。
      if v_run.id is null
         or p_session_revision is null
         or v_run.session_revision <> p_session_revision
         or v_run.worker_id is distinct from p_worker_id then
        raise exception 'RUNTIME_EVENT_FENCE_REJECTED';
      end if;
    end if;
  end if;

  -- 幂等统计：批内 event_uuid 已存在的条数即 duplicated。
  select coalesce(array_agg(nullif(item ->> 'event_uuid', '')::uuid), array[]::uuid[])
    into v_uuids
  from jsonb_array_elements(p_events) as t(item)
  where nullif(item ->> 'event_uuid', '') is not null;

  select count(*) into v_duplicated
  from public.analysis_runtime_event
  where event_uuid = any (v_uuids);

  for v_event in select value from jsonb_array_elements(p_events) loop
    begin
      v_event_uuid := nullif(v_event ->> 'event_uuid', '')::uuid;
      v_event_type := nullif(btrim(coalesce(v_event ->> 'event_type', '')), '');
      if v_event_uuid is null or v_event_type is null then
        v_dropped_invalid := v_dropped_invalid + 1;
        continue;
      end if;

      v_scope := public.analysis_runtime_event_catalog() #>> array[v_event_type, 'scope'];
      if v_scope is null then
        v_dropped_invalid := v_dropped_invalid + 1;
        continue;
      end if;
      if v_scope <> 'JOB' and p_task_id is null then
        v_dropped_invalid := v_dropped_invalid + 1;
        continue;
      end if;
      if v_scope in ('ATTEMPT', 'AGENT', 'MODEL', 'TOOL', 'WORKFLOW', 'HARNESS_JOB')
         and v_run.id is null then
        v_dropped_invalid := v_dropped_invalid + 1;
        continue;
      end if;

      -- 子 Agent 注册与首次工具调用之间存在窗口：解析不到 node 的事件丢弃并计数，
      -- 不让整批失败。
      v_node_id := null;
      v_agent_id := nullif(btrim(coalesce(v_event ->> 'agent_id', '')), '');
      if v_agent_id is not null then
        select id into v_node_id from public.analysis_agent_node
        where agent_run_id = v_run.id and agent_id = v_agent_id;
        if v_node_id is null then
          v_dropped_agent := v_dropped_agent + 1;
          continue;
        end if;
      end if;

      v_id := public.insert_analysis_runtime_event(
        v_event_uuid,
        v_job.batch_id,
        v_job.id,
        p_task_id,
        v_run.id,
        v_node_id,
        p_worker_id,
        null,
        v_event_type,
        null,
        null,
        null,
        nullif(btrim(coalesce(v_event ->> 'correlation_id', '')), ''),
        nullif(btrim(coalesce(v_event ->> 'parent_correlation_id', '')), ''),
        nullif(btrim(coalesce(v_event ->> 'error_code', '')), ''),
        nullif(v_event ->> 'duration_ms', '')::integer,
        nullif(v_event ->> 'occurred_at', '')::timestamptz,
        case when jsonb_typeof(v_event -> 'payload') = 'object'
             then v_event -> 'payload' else '{}'::jsonb end
      );

      v_accepted := v_accepted + 1;
      v_max_id := greatest(v_max_id, coalesce(v_id, 0));
    exception when others then
      v_dropped_invalid := v_dropped_invalid + 1;
    end;
  end loop;

  return jsonb_build_object(
    'accepted', v_accepted,
    'duplicated', v_duplicated,
    'dropped_unresolved_agent', v_dropped_agent,
    'dropped_invalid', v_dropped_invalid,
    'max_event_id', nullif(v_max_id, 0)
  );
end;
$$;

revoke execute on function public.report_analysis_runtime_event_batch(
  text, uuid, uuid, uuid, integer, jsonb, integer
) from public, anon, authenticated;
grant execute on function public.report_analysis_runtime_event_batch(
  text, uuid, uuid, uuid, integer, jsonb, integer
) to service_role;

------------------------------------------------------------------------------
-- 10. 终态事件触发器（方案 §6.6 的原子性实现）
------------------------------------------------------------------------------

create or replace function public.emit_analysis_job_runtime_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type text;
  v_worker text := new.worker_id;
  v_error text;
begin
  if new.execution_engine <> 'deepseek-harness-acp' then
    return null;
  end if;
  if new.status is not distinct from old.status then
    return null;
  end if;

  if new.status = 'PREPARING_CODE' then
    v_type := 'JOB_PREPARATION_STARTED';
  elsif new.status = 'PROCESSING' then
    if old.status = 'PREPARING_CODE' then
      v_type := 'JOB_SNAPSHOTS_FROZEN';
    elsif old.status = 'FAILED' then
      v_type := 'JOB_RETRIED';
    end if;
  elsif new.status = 'QUEUED' then
    if old.status = 'FAILED' then
      v_type := 'JOB_RETRIED';
    end if;
  elsif new.status = 'FINALIZING' then
    v_type := 'JOB_FINALIZATION_STARTED';
    v_worker := new.finalizer_worker_id;
  elsif new.status = 'SUCCEEDED' then
    v_type := 'JOB_SUCCEEDED';
    v_worker := coalesce(new.finalizer_worker_id, new.worker_id);
  elsif new.status = 'FAILED' then
    v_type := 'JOB_FAILED';
    v_error := new.error_code;
  end if;

  if v_type is null then
    return null;
  end if;

  perform public.insert_analysis_runtime_event(
    gen_random_uuid(), new.batch_id, new.id, null, null, null, v_worker,
    null, v_type, null, null, null, null, null, v_error, null, now(),
    jsonb_strip_nulls(jsonb_build_object('reason_code', v_error))
  );
  return null;
end;
$$;

drop trigger if exists emit_analysis_job_runtime_event on public.analysis_job;
create trigger emit_analysis_job_runtime_event
after update on public.analysis_job
for each row execute function public.emit_analysis_job_runtime_event();

create or replace function public.emit_analysis_story_task_runtime_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.analysis_job;
begin
  if new.agent_status <> 'RUNNING' then
    return null;
  end if;
  if old.agent_status = 'RUNNING' and new.agent_attempt is not distinct from old.agent_attempt then
    return null;
  end if;

  select * into v_job from public.analysis_job where id = new.job_id;
  if v_job.id is null or v_job.execution_engine <> 'deepseek-harness-acp' then
    return null;
  end if;

  perform public.insert_analysis_runtime_event(
    gen_random_uuid(), v_job.batch_id, v_job.id, new.id, null, null, new.worker_id,
    null, 'TASK_CLAIMED', null, null, null, null, null, null, null, now(),
    jsonb_build_object('attempt_number', new.agent_attempt)
  );
  return null;
end;
$$;

drop trigger if exists emit_analysis_story_task_runtime_event on public.analysis_story_task;
create trigger emit_analysis_story_task_runtime_event
after update on public.analysis_story_task
for each row execute function public.emit_analysis_story_task_runtime_event();

create or replace function public.emit_analysis_agent_run_started_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.analysis_job;
begin
  if new.status <> 'RUNNING' then
    return null;
  end if;
  select * into v_job from public.analysis_job where id = new.job_id;
  if v_job.id is null then
    return null;
  end if;

  perform public.insert_analysis_runtime_event(
    gen_random_uuid(), v_job.batch_id, v_job.id, new.task_id, new.id, null, new.worker_id,
    null, 'ATTEMPT_STARTED', null, null, null, null, null, null, null, now(),
    jsonb_build_object(
      'attempt_number', new.agent_attempt,
      'session_revision', new.session_revision
    )
  );
  return null;
end;
$$;

drop trigger if exists emit_analysis_agent_run_started_event on public.analysis_agent_run;
create trigger emit_analysis_agent_run_started_event
after insert on public.analysis_agent_run
for each row execute function public.emit_analysis_agent_run_started_event();

create or replace function public.emit_analysis_agent_run_terminal_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.analysis_job;
  v_type text;
  v_duration integer;
begin
  select * into v_job from public.analysis_job where id = new.job_id;
  if v_job.id is null then
    return null;
  end if;

  -- 纯取消请求：状态还是 RUNNING，只是 cancel_requested_at 被置上。
  if old.cancel_requested_at is null
     and new.cancel_requested_at is not null
     and new.status = old.status then
    perform public.insert_analysis_runtime_event(
      gen_random_uuid(), v_job.batch_id, v_job.id, new.task_id, new.id, null,
      new.worker_id, null, 'CANCEL_REQUESTED', null, null, null, null, null,
      new.cancel_reason, null, now(),
      jsonb_strip_nulls(jsonb_build_object('reason_code', new.cancel_reason))
    );
  end if;

  if old.status <> 'RUNNING' or new.status not in ('COMMITTED', 'FAILED') then
    return null;
  end if;

  v_duration := greatest(
    0,
    (extract(epoch from (coalesce(new.finished_at, now()) - new.started_at)) * 1000)::bigint
  )::integer;

  if new.status = 'COMMITTED' then
    v_type := 'ATTEMPT_COMMITTED';
  elsif new.error_code = 'WORKER_LOST' then
    v_type := 'LEASE_LOST';
  elsif new.error_code = 'WORKER_SHUTDOWN' then
    v_type := 'TASK_RELEASED_FOR_SHUTDOWN';
  else
    v_type := 'ATTEMPT_FAILED';
  end if;

  perform public.insert_analysis_runtime_event(
    gen_random_uuid(), v_job.batch_id, v_job.id, new.task_id,
    case when v_type = 'TASK_RELEASED_FOR_SHUTDOWN' then null else new.id end,
    null, new.worker_id, null, v_type, null, null, null, null, null,
    new.error_code, v_duration, now(),
    jsonb_strip_nulls(jsonb_build_object(
      'attempt_number', new.agent_attempt,
      'agent_count', new.agent_count,
      'duration_ms', v_duration,
      'reason_code', coalesce(new.cancel_reason, new.error_code)
    ))
  );

  -- TASK_RELEASED_FOR_SHUTDOWN 是 TASK scope，attempt 本身仍需要一条终态。
  if v_type = 'TASK_RELEASED_FOR_SHUTDOWN' then
    perform public.insert_analysis_runtime_event(
      gen_random_uuid(), v_job.batch_id, v_job.id, new.task_id, new.id, null,
      new.worker_id, null, 'ATTEMPT_FAILED', null, null, null, null, null,
      new.error_code, v_duration, now(),
      jsonb_strip_nulls(jsonb_build_object(
        'attempt_number', new.agent_attempt,
        'agent_count', new.agent_count,
        'duration_ms', v_duration,
        'reason_code', 'WORKER_SHUTDOWN'
      ))
    );
  end if;

  -- 清投影 + 补写未闭合 correlation，永远与业务终态同事务。
  perform public.seal_analysis_runtime_projection(
    new.id,
    case
      when new.status = 'COMMITTED' then 'ATTEMPT_COMMITTED'
      else coalesce(new.error_code, 'ATTEMPT_SEALED')
    end
  );

  -- 汇总失败不得回滚业务终态：异常时只留 rollup_version = 0 的待办标记。
  begin
    perform public.compute_analysis_run_rollup(new.id);
  exception when others then
    begin
      insert into public.analysis_agent_run_rollup (
        agent_run_id, task_id, job_id, batch_id, agent_attempt, worker_id,
        terminal_status, terminal_error_code, wall_ms, started_at, finished_at,
        rollup_version
      ) values (
        new.id, new.task_id, new.job_id, v_job.batch_id, new.agent_attempt,
        new.worker_id, new.status, new.error_code, v_duration,
        new.started_at, coalesce(new.finished_at, now()), 0
      )
      on conflict (agent_run_id) do update
      set rollup_version = 0, computed_at = now();
    exception when others then
      null;
    end;
  end;

  return null;
end;
$$;

drop trigger if exists emit_analysis_agent_run_terminal_event on public.analysis_agent_run;
create trigger emit_analysis_agent_run_terminal_event
after update on public.analysis_agent_run
for each row execute function public.emit_analysis_agent_run_terminal_event();

create or replace function public.emit_analysis_agent_node_registered_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.analysis_agent_run;
  v_job public.analysis_job;
begin
  select * into v_run from public.analysis_agent_run where id = new.agent_run_id;
  if v_run.id is null then
    return null;
  end if;
  select * into v_job from public.analysis_job where id = v_run.job_id;
  if v_job.id is null then
    return null;
  end if;

  perform public.insert_analysis_runtime_event(
    gen_random_uuid(), v_job.batch_id, v_job.id, v_run.task_id, v_run.id, new.id,
    v_run.worker_id, null,
    case when new.provider = 'root' then 'ROOT_AGENT_REGISTERED' else 'AGENT_REGISTERED' end,
    null, null, null, null, null, null, null, now(),
    jsonb_build_object(
      'agent_role', new.agent_role,
      'provider', new.provider,
      'delegation_depth', new.delegation_depth
    )
  );
  return null;
end;
$$;

drop trigger if exists emit_analysis_agent_node_registered_event on public.analysis_agent_node;
create trigger emit_analysis_agent_node_registered_event
after insert on public.analysis_agent_node
for each row execute function public.emit_analysis_agent_node_registered_event();

create or replace function public.emit_analysis_agent_node_terminal_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.analysis_agent_run;
  v_job public.analysis_job;
  v_type text;
  v_duration integer;
begin
  if old.status <> 'RUNNING' or new.status = 'RUNNING' then
    return null;
  end if;

  select * into v_run from public.analysis_agent_run where id = new.agent_run_id;
  if v_run.id is null then
    return null;
  end if;
  select * into v_job from public.analysis_job where id = v_run.job_id;
  if v_job.id is null then
    return null;
  end if;

  v_type := 'AGENT_' || new.status;
  v_duration := greatest(
    0,
    (extract(epoch from (coalesce(new.finished_at, now()) - new.started_at)) * 1000)::bigint
  )::integer;

  perform public.insert_analysis_runtime_event(
    gen_random_uuid(), v_job.batch_id, v_job.id, v_run.task_id, v_run.id, new.id,
    v_run.worker_id, null, v_type, null, null, null, null, null,
    new.error_code, v_duration, now(),
    jsonb_build_object(
      'agent_role', new.agent_role,
      'provider', new.provider,
      'delegation_depth', new.delegation_depth,
      'duration_ms', v_duration
    )
  );
  return null;
end;
$$;

drop trigger if exists emit_analysis_agent_node_terminal_event on public.analysis_agent_node;
create trigger emit_analysis_agent_node_terminal_event
after update on public.analysis_agent_node
for each row execute function public.emit_analysis_agent_node_terminal_event();

------------------------------------------------------------------------------
-- 11. 保留期清理：按批限量，绝不触及汇总表
------------------------------------------------------------------------------

create or replace function public.purge_analysis_runtime_events(p_limit integer default 50000)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 50000), 500000));
  v_deleted integer := 0;
begin
  with doomed as (
    select event.id
    from public.analysis_runtime_event event
    join public.analysis_job job on job.id = event.job_id
    where event.retention_until < now()
      and job.status in ('SUCCEEDED', 'FAILED')
    order by event.id
    limit v_limit
  )
  delete from public.analysis_runtime_event target
  using doomed
  where target.id = doomed.id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function public.purge_analysis_runtime_events(integer) is
  'Batch-limited retention delete. Active jobs are never purged, and '
  'analysis_agent_run_rollup is never touched: events are the disposable detail, '
  'the rollup is the baseline that must survive.';

revoke execute on function public.purge_analysis_runtime_events(integer)
  from public, anon, authenticated;
grant execute on function public.purge_analysis_runtime_events(integer) to service_role;

------------------------------------------------------------------------------
-- 12. 归因原语：correlation 区间、区间并集、最大并发
--
--     区间并集必须在 SQL 里算（方案 §6.9.2 规则 3）：事件量大，且 AI 会直接查 SQL。
------------------------------------------------------------------------------

create or replace function public.analysis_runtime_intervals(
  p_agent_run_id uuid,
  p_scopes text[]
)
returns table (
  correlation_id text,
  scope text,
  tool_name text,
  agent_node_id uuid,
  agent_role text,
  model_request_kind text,
  start_at timestamptz,
  end_at timestamptz,
  duration_ms bigint,
  closed boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with ev as (
    select *
    from public.analysis_runtime_event
    where agent_run_id = p_agent_run_id
      and scope = any (p_scopes)
      and correlation_id is not null
  ),
  agg as (
    select
      e.correlation_id,
      min(e.scope) as scope,
      (array_agg(e.payload ->> 'tool_name') filter (where e.payload ? 'tool_name'))[1] as tool_name,
      (array_agg(e.agent_node_id) filter (where e.agent_node_id is not null))[1] as agent_node_id,
      (array_agg(e.payload ->> 'agent_role') filter (where e.payload ? 'agent_role'))[1] as agent_role,
      (array_agg(e.payload ->> 'model_request_kind')
        filter (where e.payload ? 'model_request_kind'))[1] as model_request_kind,
      coalesce(
        min(e.occurred_at) filter (where e.phase = 'STARTED'),
        min(e.occurred_at) filter (where e.phase = 'TERMINAL')
      ) as start_at,
      max(e.occurred_at) filter (where e.phase = 'TERMINAL') as terminal_at,
      max(coalesce(e.duration_ms, 0)) as duration_ms
    from ev e
    group by e.correlation_id
  )
  select
    a.correlation_id,
    a.scope,
    a.tool_name,
    a.agent_node_id,
    a.agent_role,
    a.model_request_kind,
    a.start_at,
    greatest(
      coalesce(a.terminal_at, a.start_at),
      a.start_at + make_interval(secs => a.duration_ms / 1000.0)
    ) as end_at,
    a.duration_ms,
    a.terminal_at is not null as closed
  from agg a
  where a.start_at is not null;
$$;

revoke execute on function public.analysis_runtime_intervals(uuid, text[])
  from public, anon, authenticated;
grant execute on function public.analysis_runtime_intervals(uuid, text[]) to service_role;

create or replace function public.analysis_runtime_union_ms(
  p_agent_run_id uuid,
  p_scopes text[],
  p_agent_node_id uuid default null
)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  with iv as (
    select interval_row.start_at, interval_row.end_at
    from public.analysis_runtime_intervals(p_agent_run_id, p_scopes) as interval_row
    where p_agent_node_id is null or interval_row.agent_node_id = p_agent_node_id
  ),
  ordered as (
    select
      iv.start_at,
      iv.end_at,
      max(iv.end_at) over (
        order by iv.start_at, iv.end_at
        rows between unbounded preceding and 1 preceding
      ) as prev_max
    from iv
  ),
  grouped as (
    select
      ordered.start_at,
      ordered.end_at,
      sum(case when ordered.prev_max is null or ordered.start_at > ordered.prev_max then 1 else 0 end)
        over (order by ordered.start_at, ordered.end_at
              rows between unbounded preceding and current row) as grp
    from ordered
  ),
  merged as (
    select min(grouped.start_at) as merged_start, max(grouped.end_at) as merged_end
    from grouped
    group by grouped.grp
  )
  select coalesce(
    sum((extract(epoch from (merged.merged_end - merged.merged_start)) * 1000)::bigint), 0
  )
  from merged;
$$;

comment on function public.analysis_runtime_union_ms(uuid, text[], uuid) is
  'Merged wall-clock length of all correlation intervals in the given scopes. '
  'sum/union together expose the effective parallelism factor.';

revoke execute on function public.analysis_runtime_union_ms(uuid, text[], uuid)
  from public, anon, authenticated;
grant execute on function public.analysis_runtime_union_ms(uuid, text[], uuid) to service_role;

/*
 * 按工具名过滤的区间并集。
 *
 * 用来把"平台侧"（5 个 platform origin 工具，经 Broker 读快照 / 提交）从
 * "Harness 侧"（bash / edit / read …，进程内执行）里分出来 —— §1.2 第 13 条的
 * "慢是模型侧还是平台侧"靠这个数才能回答。单独一个函数而不是给
 * analysis_runtime_union_ms 加默认参数：加默认参数会造出一个重载，
 * 而重载在 PostgreSQL 里是"多一条可以绕过预期实现的调用路径"。
 */
create or replace function public.analysis_runtime_tool_union_ms(
  p_agent_run_id uuid,
  p_tool_names text[]
)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  with iv as (
    select interval_row.start_at, interval_row.end_at
    from public.analysis_runtime_intervals(p_agent_run_id, array['TOOL']) as interval_row
    where interval_row.tool_name = any (p_tool_names)
  ),
  ordered as (
    select
      iv.start_at,
      iv.end_at,
      max(iv.end_at) over (
        order by iv.start_at, iv.end_at
        rows between unbounded preceding and 1 preceding
      ) as prev_max
    from iv
  ),
  grouped as (
    select
      ordered.start_at,
      ordered.end_at,
      sum(case when ordered.prev_max is null or ordered.start_at > ordered.prev_max then 1 else 0 end)
        over (order by ordered.start_at, ordered.end_at
              rows between unbounded preceding and current row) as grp
    from ordered
  ),
  merged as (
    select min(grouped.start_at) as merged_start, max(grouped.end_at) as merged_end
    from grouped
    group by grouped.grp
  )
  select coalesce(
    sum((extract(epoch from (merged.merged_end - merged.merged_start)) * 1000)::bigint), 0
  )
  from merged;
$$;

revoke execute on function public.analysis_runtime_tool_union_ms(uuid, text[])
  from public, anon, authenticated;
grant execute on function public.analysis_runtime_tool_union_ms(uuid, text[]) to service_role;

create or replace function public.analysis_runtime_max_overlap(
  p_agent_run_id uuid,
  p_scopes text[]
)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  with pts as (
    select interval_row.start_at as at, 1 as delta
    from public.analysis_runtime_intervals(p_agent_run_id, p_scopes) as interval_row
    union all
    select interval_row.end_at as at, -1 as delta
    from public.analysis_runtime_intervals(p_agent_run_id, p_scopes) as interval_row
  ),
  running as (
    select sum(pts.delta) over (
      order by pts.at, pts.delta
      rows between unbounded preceding and current row
    ) as concurrent
    from pts
  )
  select coalesce(max(running.concurrent), 0)::integer from running;
$$;

revoke execute on function public.analysis_runtime_max_overlap(uuid, text[])
  from public, anon, authenticated;
grant execute on function public.analysis_runtime_max_overlap(uuid, text[]) to service_role;

create or replace function public.analysis_runtime_max_concurrent_agents(p_agent_run_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  with pts as (
    select node.started_at as at, 1 as delta
    from public.analysis_agent_node node
    where node.agent_run_id = p_agent_run_id
    union all
    select coalesce(node.finished_at, node.cancelled_at, now()) as at, -1 as delta
    from public.analysis_agent_node node
    where node.agent_run_id = p_agent_run_id
  ),
  running as (
    select sum(pts.delta) over (
      order by pts.at, pts.delta
      rows between unbounded preceding and current row
    ) as concurrent
    from pts
  )
  select greatest(coalesce(max(running.concurrent), 0), 0)::integer from running;
$$;

revoke execute on function public.analysis_runtime_max_concurrent_agents(uuid)
  from public, anon, authenticated;
grant execute on function public.analysis_runtime_max_concurrent_agents(uuid) to service_role;

------------------------------------------------------------------------------
-- 13. compute_analysis_run_rollup：墙钟时间归因（方案 §6.9.2）
--
--     归因等式恒成立：setup + busy_union + teardown + unattributed = wall。
--     实现方式是先从事件算 setup/teardown/busy，再把 busy 钳到剩余预算，最后把
--     unattributed 作为余量。unattributed 允许为大值，但绝不摊到其它桶里。
------------------------------------------------------------------------------

create or replace function public.compute_analysis_run_rollup(p_agent_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.analysis_agent_run;
  v_job public.analysis_job;
  v_started timestamptz;
  v_finished timestamptz;
  v_wall bigint;
  v_setup bigint := 0;
  v_teardown bigint := 0;
  v_busy bigint := 0;
  v_model_union bigint := 0;
  v_tool_union bigint := 0;
  v_platform_union bigint := 0;
  v_model_sum bigint := 0;
  v_tool_sum bigint := 0;
  v_idle bigint := 0;
  v_unattributed bigint;
  v_attempt_started timestamptz;
  v_process_started timestamptz;
  v_last_terminal timestamptz;
  v_kinds jsonb := '{}'::jsonb;
  v_tool_ms jsonb := '{}'::jsonb;
  v_tool_calls_by_name jsonb := '{}'::jsonb;
  v_per_agent jsonb := '[]'::jsonb;
  v_model_requests integer := 0;
  v_model_denied integer := 0;
  v_tool_calls integer := 0;
  v_tool_denied integer := 0;
  v_tool_failed integer := 0;
  v_events_reported integer := 0;
  v_events_dropped integer := 0;
  v_end_reason text;
  v_cap integer := 2147483647;
begin
  select * into v_run from public.analysis_agent_run where id = p_agent_run_id;
  if v_run.id is null then
    raise exception 'agent run not found';
  end if;
  if v_run.status not in ('COMMITTED', 'FAILED') then
    raise exception 'ROLLUP_RUN_NOT_TERMINAL';
  end if;
  select * into v_job from public.analysis_job where id = v_run.job_id;

  v_started := v_run.started_at;
  v_finished := coalesce(v_run.finished_at, v_run.committed_at, now());
  if v_finished < v_started then
    v_finished := v_started;
  end if;
  v_wall := least((extract(epoch from (v_finished - v_started)) * 1000)::bigint, v_cap);

  select min(occurred_at) into v_attempt_started
  from public.analysis_runtime_event
  where agent_run_id = p_agent_run_id and event_type = 'ATTEMPT_STARTED';

  select min(occurred_at) into v_process_started
  from public.analysis_runtime_event
  where agent_run_id = p_agent_run_id and event_type = 'HARNESS_PROCESS_STARTED';

  select max(occurred_at) into v_last_terminal
  from public.analysis_runtime_event
  where agent_run_id = p_agent_run_id and phase = 'TERMINAL';

  if v_attempt_started is not null and v_process_started is not null then
    v_setup := greatest(
      0, (extract(epoch from (v_process_started - v_attempt_started)) * 1000)::bigint
    );
  end if;
  if v_last_terminal is not null then
    v_teardown := greatest(
      0, (extract(epoch from (v_finished - v_last_terminal)) * 1000)::bigint
    );
  end if;

  v_setup := least(v_setup, v_wall);
  v_teardown := least(v_teardown, greatest(v_wall - v_setup, 0));

  v_model_union := public.analysis_runtime_union_ms(p_agent_run_id, array['MODEL']);
  v_tool_union := public.analysis_runtime_union_ms(p_agent_run_id, array['TOOL']);
  -- 平台侧（Broker → 冻结快照 / 提交）与 Harness 侧的分界。
  v_platform_union := public.analysis_runtime_tool_union_ms(
    p_agent_run_id, public.analysis_runtime_platform_tool_names()
  );
  v_busy := public.analysis_runtime_union_ms(p_agent_run_id, array['MODEL', 'TOOL']);
  v_busy := least(v_busy, greatest(v_wall - v_setup - v_teardown, 0));
  v_model_union := least(v_model_union, v_wall);
  v_tool_union := least(v_tool_union, v_wall);
  v_platform_union := least(v_platform_union, v_wall);
  v_unattributed := greatest(v_wall - v_setup - v_busy - v_teardown, 0);

  select
    least(coalesce(sum(case when interval_row.scope = 'MODEL'
      then (extract(epoch from (interval_row.end_at - interval_row.start_at)) * 1000)::bigint
      else 0 end), 0), v_cap),
    least(coalesce(sum(case when interval_row.scope = 'TOOL'
      then (extract(epoch from (interval_row.end_at - interval_row.start_at)) * 1000)::bigint
      else 0 end), 0), v_cap)
    into v_model_sum, v_tool_sum
  from public.analysis_runtime_intervals(p_agent_run_id, array['MODEL', 'TOOL']) as interval_row;

  -- per-Agent 段 + agent_idle_ms：已注册未终态但没有任何未闭合 correlation 的时长。
  select
    coalesce(jsonb_agg(agent_row.entry order by agent_row.depth, agent_row.started_at), '[]'::jsonb),
    coalesce(sum(agent_row.idle_ms), 0)
    into v_per_agent, v_idle
  from (
    select
      node.delegation_depth as depth,
      node.started_at,
      greatest(
        0,
        (extract(epoch from (
          coalesce(node.finished_at, node.cancelled_at, v_finished) - node.started_at
        )) * 1000)::bigint
        - public.analysis_runtime_union_ms(p_agent_run_id, array['MODEL', 'TOOL'], node.id)
      ) as idle_ms,
      jsonb_build_object(
        'agent_id', node.agent_id,
        'agent_node_id', node.id,
        'role', node.agent_role,
        'provider', node.provider,
        'depth', node.delegation_depth,
        'status', node.status,
        'model_requests', node.model_requests,
        'tool_calls', node.tool_calls,
        'tool_ms', public.analysis_runtime_union_ms(p_agent_run_id, array['TOOL'], node.id),
        'model_ms', public.analysis_runtime_union_ms(p_agent_run_id, array['MODEL'], node.id),
        'evidence_produced', node.evidence_produced,
        'idle_ms', greatest(
          0,
          (extract(epoch from (
            coalesce(node.finished_at, node.cancelled_at, v_finished) - node.started_at
          )) * 1000)::bigint
          - public.analysis_runtime_union_ms(p_agent_run_id, array['MODEL', 'TOOL'], node.id)
        )
      ) as entry
    from public.analysis_agent_node node
    where node.agent_run_id = p_agent_run_id
  ) agent_row;

  select coalesce(jsonb_object_agg(kind_row.kind, kind_row.total), '{}'::jsonb)
    into v_kinds
  from (
    select coalesce(interval_row.model_request_kind, 'other') as kind, count(*) as total
    from public.analysis_runtime_intervals(p_agent_run_id, array['MODEL']) as interval_row
    group by 1
  ) kind_row;

  select
    coalesce(jsonb_object_agg(tool_row.name, tool_row.total_ms), '{}'::jsonb),
    coalesce(jsonb_object_agg(tool_row.name, tool_row.calls), '{}'::jsonb)
    into v_tool_ms, v_tool_calls_by_name
  from (
    select
      coalesce(interval_row.tool_name, 'unknown') as name,
      sum((extract(epoch from (interval_row.end_at - interval_row.start_at)) * 1000)::bigint) as total_ms,
      count(*) as calls
    from public.analysis_runtime_intervals(p_agent_run_id, array['TOOL']) as interval_row
    group by 1
  ) tool_row;

  select
    count(*) filter (where event_type in ('MODEL_REQUEST_COMPLETED', 'MODEL_REQUEST_FAILED')),
    count(*) filter (where event_type = 'MODEL_REQUEST_DENIED'),
    count(*) filter (where event_type in (
      'TOOL_CALL_COMPLETED', 'TOOL_CALL_FAILED', 'TOOL_CALL_CANCELLED'
    )),
    count(*) filter (where event_type = 'TOOL_CALL_DENIED'),
    count(*) filter (where event_type = 'TOOL_CALL_FAILED')
    into v_model_requests, v_model_denied, v_tool_calls, v_tool_denied, v_tool_failed
  from public.analysis_runtime_event
  where agent_run_id = p_agent_run_id;

  select
    coalesce((payload ->> 'events_reported')::integer, 0),
    coalesce((payload ->> 'events_dropped')::integer, 0)
    into v_events_reported, v_events_dropped
  from public.analysis_runtime_event
  where agent_run_id = p_agent_run_id
    and event_type = 'ATTEMPT_INSTRUMENTATION_REPORTED'
  order by id desc
  limit 1;

  if v_events_reported = 0 then
    select count(*) into v_events_reported
    from public.analysis_runtime_event where agent_run_id = p_agent_run_id;
  end if;

  v_end_reason := case
    when v_run.cancel_reason = 'WORKER_LOST' then 'LEASE_LOST'
    when v_run.cancel_reason = 'WORKER_SHUTDOWN' then 'WORKER_SHUTDOWN'
    when v_run.cancel_reason = 'USER_CANCELLED' then 'USER_CANCELLED'
    when v_run.error_code = 'WORKER_LOST' then 'LEASE_LOST'
    when v_run.error_code = 'WORKER_SHUTDOWN' then 'WORKER_SHUTDOWN'
    else null
  end;

  insert into public.analysis_agent_run_rollup (
    agent_run_id, task_id, job_id, batch_id, agent_attempt, worker_id,
    model_label, harness_version, capability_contract_hash, profile_config_hash,
    policy_hash, prompt_version, policy_version,
    terminal_status, terminal_error_code, end_reason, resumed, resume_count,
    wall_ms, setup_ms, model_ms_union, tool_ms_union, platform_tool_ms_union,
    busy_ms_union, teardown_ms,
    agent_idle_ms, unattributed_ms, model_ms_sum, tool_ms_sum,
    agent_count, max_depth, max_concurrent_agents, max_concurrent_tools,
    model_requests, model_requests_by_kind, model_requests_denied,
    tool_calls, tool_calls_denied, tool_calls_failed,
    tool_ms_by_name, tool_calls_by_name,
    input_tokens, output_tokens, evidence_count, artifact_count, rejected_submissions,
    per_agent, events_reported, events_dropped,
    started_at, finished_at, computed_at, rollup_version
  ) values (
    v_run.id, v_run.task_id, v_run.job_id, v_job.batch_id, v_run.agent_attempt,
    v_run.worker_id,
    v_run.model_label, v_job.harness_version, v_job.capability_contract_hash,
    v_run.profile_config_hash, v_run.policy_hash, v_run.prompt_version,
    v_job.policy_version,
    v_run.status, v_run.error_code, v_end_reason,
    v_run.resume_count > 0, v_run.resume_count,
    v_wall::integer, v_setup::integer, v_model_union::integer, v_tool_union::integer,
    v_platform_union::integer,
    v_busy::integer, v_teardown::integer, least(v_idle, v_cap)::integer,
    v_unattributed::integer, v_model_sum::integer, v_tool_sum::integer,
    v_run.agent_count, v_run.max_depth_reached,
    greatest(public.analysis_runtime_max_concurrent_agents(v_run.id), 1),
    public.analysis_runtime_max_overlap(v_run.id, array['TOOL']),
    v_model_requests, v_kinds, v_model_denied,
    v_tool_calls, v_tool_denied, v_tool_failed,
    v_tool_ms, v_tool_calls_by_name,
    v_run.input_tokens, v_run.output_tokens,
    (select count(*) from public.analysis_agent_evidence where agent_run_id = v_run.id),
    (select count(*) from public.analysis_artifact where agent_run_id = v_run.id),
    (select count(*) from public.analysis_permission_decision
      where agent_run_id = v_run.id and decision = 'DENY' and reason_code like 'SUBMIT%'),
    v_per_agent, v_events_reported, v_events_dropped,
    v_started, v_finished, now(), 1
  )
  on conflict (agent_run_id) do update
  set task_id = excluded.task_id,
      job_id = excluded.job_id,
      batch_id = excluded.batch_id,
      agent_attempt = excluded.agent_attempt,
      worker_id = excluded.worker_id,
      model_label = excluded.model_label,
      harness_version = excluded.harness_version,
      capability_contract_hash = excluded.capability_contract_hash,
      profile_config_hash = excluded.profile_config_hash,
      policy_hash = excluded.policy_hash,
      prompt_version = excluded.prompt_version,
      policy_version = excluded.policy_version,
      terminal_status = excluded.terminal_status,
      terminal_error_code = excluded.terminal_error_code,
      end_reason = excluded.end_reason,
      resumed = excluded.resumed,
      resume_count = excluded.resume_count,
      wall_ms = excluded.wall_ms,
      setup_ms = excluded.setup_ms,
      model_ms_union = excluded.model_ms_union,
      tool_ms_union = excluded.tool_ms_union,
      platform_tool_ms_union = excluded.platform_tool_ms_union,
      busy_ms_union = excluded.busy_ms_union,
      teardown_ms = excluded.teardown_ms,
      agent_idle_ms = excluded.agent_idle_ms,
      unattributed_ms = excluded.unattributed_ms,
      model_ms_sum = excluded.model_ms_sum,
      tool_ms_sum = excluded.tool_ms_sum,
      agent_count = excluded.agent_count,
      max_depth = excluded.max_depth,
      max_concurrent_agents = excluded.max_concurrent_agents,
      max_concurrent_tools = excluded.max_concurrent_tools,
      model_requests = excluded.model_requests,
      model_requests_by_kind = excluded.model_requests_by_kind,
      model_requests_denied = excluded.model_requests_denied,
      tool_calls = excluded.tool_calls,
      tool_calls_denied = excluded.tool_calls_denied,
      tool_calls_failed = excluded.tool_calls_failed,
      tool_ms_by_name = excluded.tool_ms_by_name,
      tool_calls_by_name = excluded.tool_calls_by_name,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      evidence_count = excluded.evidence_count,
      artifact_count = excluded.artifact_count,
      rejected_submissions = excluded.rejected_submissions,
      per_agent = excluded.per_agent,
      events_reported = excluded.events_reported,
      events_dropped = excluded.events_dropped,
      started_at = excluded.started_at,
      finished_at = excluded.finished_at,
      computed_at = now(),
      rollup_version = 1;

  return jsonb_build_object(
    'agent_run_id', v_run.id,
    'wall_ms', v_wall,
    'setup_ms', v_setup,
    'busy_ms_union', v_busy,
    'teardown_ms', v_teardown,
    'unattributed_ms', v_unattributed,
    'rollup_version', 1
  );
end;
$$;

revoke execute on function public.compute_analysis_run_rollup(uuid)
  from public, anon, authenticated;
grant execute on function public.compute_analysis_run_rollup(uuid) to service_role;

create or replace function public.backfill_analysis_run_rollups(p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 200), 5000));
  v_run_id uuid;
  v_ok integer := 0;
  v_failed integer := 0;
begin
  for v_run_id in
    select run.id
    from public.analysis_agent_run run
    left join public.analysis_agent_run_rollup rollup on rollup.agent_run_id = run.id
    where run.status in ('COMMITTED', 'FAILED')
      and (rollup.agent_run_id is null or rollup.rollup_version = 0)
    order by run.finished_at nulls last, run.id
    limit v_limit
  loop
    begin
      perform public.compute_analysis_run_rollup(v_run_id);
      v_ok := v_ok + 1;
    exception when others then
      v_failed := v_failed + 1;
    end;
  end loop;

  return jsonb_build_object('computed', v_ok, 'failed', v_failed);
end;
$$;

revoke execute on function public.backfill_analysis_run_rollups(integer)
  from public, anon, authenticated;
grant execute on function public.backfill_analysis_run_rollups(integer) to service_role;

------------------------------------------------------------------------------
-- 14. 查询 RPC（人的实时监控通道）
------------------------------------------------------------------------------

create or replace function public.admin_list_active_analysis_batches()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_watermark bigint := pg_snapshot_xmin(pg_current_snapshot())::text::bigint;
  v_result jsonb;
begin
  perform public.ensure_admin();

  select coalesce(jsonb_agg(entry order by created_at desc), '[]'::jsonb)
    into v_result
  from (
    select
      job.created_at,
      jsonb_build_object(
        'batch_id', batch.id,
        'batch_name', batch.name,
        'week_code', batch.week_code,
        'job_id', job.id,
        'job_status', job.status,
        'requested_branch', job.requested_branch,
        'worker_id', job.worker_id,
        'finalizer_worker_id', job.finalizer_worker_id,
        'job_started_at', job.started_at,
        'total_stories', job.total_stories,
        'pending_stories', (
          select count(*) from public.analysis_story_task task
          where task.job_id = job.id and task.agent_status = 'PENDING'
        ),
        'running_stories', (
          select count(*) from public.analysis_story_task task
          where task.job_id = job.id and task.agent_status = 'RUNNING'
        ),
        'succeeded_stories', (
          select count(*) from public.analysis_story_task task
          where task.job_id = job.id and task.agent_status = 'SUCCEEDED'
        ),
        'failed_stories', (
          select count(*) from public.analysis_story_task task
          where task.job_id = job.id and task.agent_status = 'FAILED'
        ),
        'last_event_id', (
          select max(event.id) from public.analysis_runtime_event event
          where event.batch_id = batch.id
            and (event.xact_id < v_watermark
                 or event.received_at < now() - interval '30 seconds')
        ),
        'last_event_at', (
          select max(event.occurred_at) from public.analysis_runtime_event event
          where event.batch_id = batch.id
            and (event.xact_id < v_watermark
                 or event.received_at < now() - interval '30 seconds')
        ),
        'watermark_lag_ms', coalesce((
          select (extract(epoch from (now() - min(event.received_at))) * 1000)::bigint
          from public.analysis_runtime_event event
          where event.batch_id = batch.id and event.xact_id >= v_watermark
        ), 0)
      ) as entry
    from public.analysis_job job
    join public.review_batch batch on batch.id = job.batch_id
    where job.status in ('QUEUED', 'PREPARING_CODE', 'PROCESSING', 'FINALIZING')
      and job.execution_engine = 'deepseek-harness-acp'
  ) rows;

  return jsonb_build_object('server_time', now(), 'batches', v_result);
end;
$$;

revoke execute on function public.admin_list_active_analysis_batches() from public, anon;
grant execute on function public.admin_list_active_analysis_batches()
  to authenticated, service_role;

create or replace function public.get_analysis_runtime_console(
  p_batch_id uuid,
  p_since_event_id bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_watermark bigint;
  v_batch public.review_batch;
  v_job public.analysis_job;
  v_events jsonb := '[]'::jsonb;
  v_task_ids uuid[] := array[]::uuid[];
  v_next bigint;
  v_count integer := 0;
  v_limit integer;
  v_tasks jsonb := '[]'::jsonb;
  v_lag bigint := 0;
  v_min_id bigint;
  v_requires_full boolean := false;
begin
  -- 监控台一律用 manage 语义：can_view_review_batch 只校验角色不校验归属（§6.7）。
  if coalesce(auth.role(), '') = 'service_role' then
    null;
  else
    perform public.ensure_manage_review_batch(p_batch_id);
  end if;

  select * into v_batch from public.review_batch where id = p_batch_id;
  if v_batch.id is null then
    raise exception 'batch not found';
  end if;

  select * into v_job
  from public.analysis_job
  where batch_id = p_batch_id
  order by
    case when status in ('QUEUED', 'PREPARING_CODE', 'PROCESSING', 'FINALIZING')
         then 0 else 1 end,
    created_at desc
  limit 1;

  v_watermark := pg_snapshot_xmin(pg_current_snapshot())::text::bigint;
  v_limit := case when p_since_event_id is null then 200 else 500 end;

  select coalesce(min(id), 0) into v_min_id from public.analysis_runtime_event;
  v_requires_full := p_since_event_id is not null
    and v_min_id > 0
    and p_since_event_id < v_min_id - 1;

  select
    coalesce(jsonb_agg(picked.dto order by picked.id), '[]'::jsonb),
    max(picked.id),
    count(*),
    coalesce(array_agg(distinct picked.task_id) filter (where picked.task_id is not null),
             array[]::uuid[])
    into v_events, v_next, v_count, v_task_ids
  from (
    select
      event.id,
      event.task_id,
      jsonb_build_object(
        'event_id', event.id,
        'event_uuid', event.event_uuid,
        'batch_id', event.batch_id,
        'job_id', event.job_id,
        'task_id', event.task_id,
        'agent_run_id', event.agent_run_id,
        'agent_node_id', event.agent_node_id,
        'worker_id', event.worker_id,
        'scope', event.scope,
        'event_type', event.event_type,
        'activity_code', event.activity_code,
        'phase', event.phase,
        'status', event.status,
        'correlation_id', event.correlation_id,
        'parent_correlation_id', event.parent_correlation_id,
        'error_code', event.error_code,
        'duration_ms', event.duration_ms,
        'payload', event.payload,
        'occurred_at', event.occurred_at,
        'received_at', event.received_at,
        'clock_skewed', event.clock_skewed
      ) as dto
    from public.analysis_runtime_event event
    where event.batch_id = p_batch_id
      and (p_since_event_id is null or event.id > p_since_event_id)
      and (
        event.xact_id < v_watermark
        -- 逃生阀：一个长事务不能把整条监控链路卡住。Reporter 单次 flush 有 10 秒硬超时。
        or event.received_at < now() - interval '30 seconds'
      )
    order by
      case when p_since_event_id is null then event.id end desc nulls last,
      case when p_since_event_id is not null then event.id end asc nulls last
    limit v_limit
  ) picked;

  if v_job.id is not null then
    select coalesce(jsonb_agg(rows.task_dto order by rows.story_code), '[]'::jsonb)
      into v_tasks
    from (
      select
        story.story_code,
        jsonb_build_object(
          'task_id', task.id,
          'story_id', story.id,
          'story_code', story.story_code,
          'story_name', story.story_name,
          'project_name', story.project_name,
          'application_name', story.application_name,
          'agent_status', task.agent_status,
          'agent_attempt', task.agent_attempt,
          'worker_id', task.worker_id,
          'lease_expires_at', task.lease_expires_at,
          'heartbeat_at', task.heartbeat_at,
          'error_code', task.error_code,
          'started_at', task.started_at,
          'finished_at', task.finished_at,
          'last_event_at', (
            select max(event.occurred_at) from public.analysis_runtime_event event
            where event.task_id = task.id
          ),
          'attempts', coalesce((
            select jsonb_agg(attempts.attempt_dto order by attempts.agent_attempt)
            from (
              select
                run.agent_attempt,
                jsonb_build_object(
                  'agent_run_id', run.id,
                  'agent_attempt', run.agent_attempt,
                  'status', run.status,
                  'worker_id', run.worker_id,
                  'model_label', run.model_label,
                  'error_code', run.error_code,
                  'started_at', run.started_at,
                  'committed_at', run.committed_at,
                  'finished_at', run.finished_at,
                  'cancel_requested_at', run.cancel_requested_at,
                  'cancel_reason', run.cancel_reason,
                  'sealed_at', run.sealed_at,
                  'session_revision', run.session_revision,
                  'attempt_phase_code', run.attempt_phase_code,
                  'attempt_phase_started_at', run.attempt_phase_started_at,
                  'agent_count', run.agent_count,
                  'max_depth_reached', run.max_depth_reached,
                  'model_requests', run.model_requests,
                  'tool_calls', run.tool_calls,
                  'input_tokens', run.input_tokens,
                  'output_tokens', run.output_tokens,
                  'resume_count', run.resume_count,
                  'agents', coalesce((
                    select jsonb_agg(agents.agent_dto
                      order by agents.delegation_depth, agents.started_at)
                    from (
                      select
                        node.delegation_depth,
                        node.started_at,
                        jsonb_build_object(
                          'agent_node_id', node.id,
                          'agent_id', node.agent_id,
                          'agent_role', node.agent_role,
                          'provider', node.provider,
                          'delegation_depth', node.delegation_depth,
                          'status', node.status,
                          'model_requests', node.model_requests,
                          'tool_calls', node.tool_calls,
                          'evidence_produced', node.evidence_produced,
                          'input_tokens', node.input_tokens,
                          'output_tokens', node.output_tokens,
                          'error_code', node.error_code,
                          'started_at', node.started_at,
                          'finished_at', node.finished_at,
                          'current_activity_scope', node.current_activity_scope,
                          'current_activity_code', node.current_activity_code,
                          'current_activity_status', node.current_activity_status,
                          'current_correlation_id', node.current_correlation_id,
                          'current_tool_name', node.current_tool_name,
                          'current_activity_started_at', node.current_activity_started_at,
                          'current_activity_updated_at', node.current_activity_updated_at,
                          'open_correlations', coalesce((
                            select jsonb_agg(jsonb_build_object(
                              'correlation_id', started.correlation_id,
                              'scope', started.scope,
                              'event_type', started.event_type,
                              'activity_code', started.activity_code,
                              'tool_name', started.payload ->> 'tool_name',
                              'model_request_kind', started.payload ->> 'model_request_kind',
                              'started_at', started.occurred_at
                            ) order by started.occurred_at)
                            from public.analysis_runtime_event started
                            where started.agent_node_id = node.id
                              and started.phase = 'STARTED'
                              and not exists (
                                select 1 from public.analysis_runtime_event terminal
                                where terminal.agent_run_id = started.agent_run_id
                                  and terminal.correlation_id = started.correlation_id
                                  and terminal.phase = 'TERMINAL'
                              )
                          ), '[]'::jsonb)
                        ) as agent_dto
                      from public.analysis_agent_node node
                      where node.agent_run_id = run.id
                    ) agents
                  ), '[]'::jsonb)
                ) as attempt_dto
              from public.analysis_agent_run run
              where run.task_id = task.id
            ) attempts
          ), '[]'::jsonb)
        ) as task_dto
      from public.analysis_story_task task
      join public.review_story story on story.id = task.story_id
      where task.job_id = v_job.id
        and (p_since_event_id is null or task.id = any (v_task_ids))
    ) rows;
  end if;

  select coalesce((extract(epoch from (now() - min(event.received_at))) * 1000)::bigint, 0)
    into v_lag
  from public.analysis_runtime_event event
  where event.batch_id = p_batch_id and event.xact_id >= v_watermark;

  return jsonb_build_object(
    'batch', jsonb_build_object(
      'batch_id', v_batch.id,
      'batch_name', v_batch.name,
      'job_id', v_job.id,
      'job_status', v_job.status,
      'total_stories', coalesce(v_job.total_stories, 0),
      'pending_stories', coalesce((
        select count(*) from public.analysis_story_task task
        where task.job_id = v_job.id and task.agent_status = 'PENDING'
      ), 0),
      'running_stories', coalesce((
        select count(*) from public.analysis_story_task task
        where task.job_id = v_job.id and task.agent_status = 'RUNNING'
      ), 0),
      'succeeded_stories', coalesce((
        select count(*) from public.analysis_story_task task
        where task.job_id = v_job.id and task.agent_status = 'SUCCEEDED'
      ), 0),
      'failed_stories', coalesce((
        select count(*) from public.analysis_story_task task
        where task.job_id = v_job.id and task.agent_status = 'FAILED'
      ), 0),
      'last_event_id', (
        select max(event.id) from public.analysis_runtime_event event
        where event.batch_id = p_batch_id
          and (event.xact_id < v_watermark
               or event.received_at < now() - interval '30 seconds')
      ),
      'last_event_at', (
        select max(event.occurred_at) from public.analysis_runtime_event event
        where event.batch_id = p_batch_id
          and (event.xact_id < v_watermark
               or event.received_at < now() - interval '30 seconds')
      )
    ),
    'tasks', v_tasks,
    'events', v_events,
    'cursor', jsonb_build_object(
      'requested_after', p_since_event_id,
      -- 只推进到本次返回中已过提交水位的最大 id，不是表内 max(id)。
      'next_event_id', coalesce(v_next, p_since_event_id),
      'has_more', p_since_event_id is not null and v_count >= v_limit,
      'requires_full_snapshot', v_requires_full,
      'server_time', now(),
      'watermark_lag_ms', v_lag
    )
  );
end;
$$;

revoke execute on function public.get_analysis_runtime_console(uuid, bigint) from public, anon;
grant execute on function public.get_analysis_runtime_console(uuid, bigint)
  to authenticated, service_role;

------------------------------------------------------------------------------
-- 15. AI 诊断 RPC（§6.10）
--
--     只 grant 给 service_role；浏览器（authenticated）根本拿不到。函数内部对带 JWT
--     的直连会话额外要求 ADMIN。
------------------------------------------------------------------------------

create or replace function public.get_analysis_attempt_diagnostics(
  p_task_id uuid,
  p_agent_attempt integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.analysis_agent_run;
  v_rollup public.analysis_agent_run_rollup;
  v_job public.analysis_job;
  v_timeline jsonb;
  v_event_count integer;
  v_truncated boolean := false;
  v_sampled text[] := array[]::text[];
  v_wall bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    perform public.ensure_admin();
  end if;

  select * into v_run from public.analysis_agent_run
  where task_id = p_task_id
    and (p_agent_attempt is null or agent_attempt = p_agent_attempt)
  order by agent_attempt desc
  limit 1;
  if v_run.id is null then
    raise exception 'attempt not found';
  end if;
  select * into v_job from public.analysis_job where id = v_run.job_id;
  select * into v_rollup from public.analysis_agent_run_rollup where agent_run_id = v_run.id;

  select count(*) into v_event_count
  from public.analysis_runtime_event where agent_run_id = v_run.id;

  if v_event_count > 5000 then
    v_truncated := true;
    v_sampled := array['TOOL', 'MODEL'];
  end if;

  select coalesce(jsonb_agg(rows.dto order by rows.id), '[]'::jsonb)
    into v_timeline
  from (
    select
      event.id,
      jsonb_build_object(
        'event_id', event.id,
        'scope', event.scope,
        'event_type', event.event_type,
        'activity_code', event.activity_code,
        'phase', event.phase,
        'status', event.status,
        'correlation_id', event.correlation_id,
        'agent_node_id', event.agent_node_id,
        'error_code', event.error_code,
        'duration_ms', event.duration_ms,
        'payload', event.payload,
        'occurred_at', event.occurred_at,
        'received_at', event.received_at
      ) as dto
    from public.analysis_runtime_event event
    where event.agent_run_id = v_run.id
      -- 降采样时保留全部非高频 scope，只对 TOOL/MODEL 抽样，并显式声明，不静默截断。
      and (not v_truncated or event.scope <> all (v_sampled) or (event.id % 10) = 0)
    order by event.id
    limit 20000
  ) rows;

  v_wall := coalesce(v_rollup.wall_ms, greatest(
    0,
    (extract(epoch from (coalesce(v_run.finished_at, now()) - v_run.started_at)) * 1000)::bigint
  ));

  return jsonb_build_object(
    'agent_run_id', v_run.id,
    'task_id', v_run.task_id,
    'job_id', v_run.job_id,
    'batch_id', v_job.batch_id,
    'agent_attempt', v_run.agent_attempt,
    'terminal_status', v_run.status,
    'terminal_error_code', v_run.error_code,
    'started_at', v_run.started_at,
    'finished_at', v_run.finished_at,
    'fingerprint', jsonb_build_object(
      'model_label', v_run.model_label,
      'harness_version', v_job.harness_version,
      'capability_contract_hash', v_job.capability_contract_hash,
      'profile_config_hash', v_run.profile_config_hash,
      'policy_hash', v_run.policy_hash,
      'policy_version', v_job.policy_version,
      'prompt_version', v_run.prompt_version
    ),
    'attribution', case when v_rollup.agent_run_id is null then null else jsonb_build_object(
      'wall_ms', v_rollup.wall_ms,
      'setup_ms', v_rollup.setup_ms,
      'model_ms_union', v_rollup.model_ms_union,
      'tool_ms_union', v_rollup.tool_ms_union,
      -- 平台侧（Broker → 快照/提交）与 Harness 侧的分界。
      'platform_tool_ms_union', v_rollup.platform_tool_ms_union,
      'harness_tool_ms_union',
        greatest(v_rollup.tool_ms_union - v_rollup.platform_tool_ms_union, 0),
      'busy_ms_union', v_rollup.busy_ms_union,
      'teardown_ms', v_rollup.teardown_ms,
      'agent_idle_ms', v_rollup.agent_idle_ms,
      'unattributed_ms', v_rollup.unattributed_ms,
      'model_ms_sum', v_rollup.model_ms_sum,
      'tool_ms_sum', v_rollup.tool_ms_sum,
      'unattributed_pct', case when v_rollup.wall_ms > 0
        then round((v_rollup.unattributed_ms::numeric * 100) / v_rollup.wall_ms, 2) else 0 end,
      'model_parallelism', case when v_rollup.model_ms_union > 0
        then round(v_rollup.model_ms_sum::numeric / v_rollup.model_ms_union, 2) else null end,
      'max_concurrent_agents', v_rollup.max_concurrent_agents,
      'max_concurrent_tools', v_rollup.max_concurrent_tools,
      'model_requests_by_kind', v_rollup.model_requests_by_kind,
      'tool_ms_by_name', v_rollup.tool_ms_by_name,
      'tool_calls_by_name', v_rollup.tool_calls_by_name
    ) end,
    'phases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'event_type', event.event_type,
        'activity_code', event.activity_code,
        'occurred_at', event.occurred_at,
        'duration_ms', event.duration_ms,
        'error_code', event.error_code
      ) order by event.id)
      from public.analysis_runtime_event event
      where event.agent_run_id = v_run.id and event.scope = 'ATTEMPT'
    ), '[]'::jsonb),
    'agents', coalesce(v_rollup.per_agent, '[]'::jsonb),
    'slowest_tools', coalesce((
      select jsonb_agg(jsonb_build_object(
        'correlation_id', slow.correlation_id,
        'tool_name', slow.tool_name,
        'agent_role', slow.agent_role,
        'duration_ms', (extract(epoch from (slow.end_at - slow.start_at)) * 1000)::bigint,
        'closed', slow.closed
      ) order by (slow.end_at - slow.start_at) desc)
      from (
        select * from public.analysis_runtime_intervals(v_run.id, array['TOOL'])
        order by (end_at - start_at) desc
        limit 20
      ) slow
    ), '[]'::jsonb),
    'slowest_model_requests', coalesce((
      select jsonb_agg(jsonb_build_object(
        'correlation_id', slow.correlation_id,
        'model_request_kind', slow.model_request_kind,
        'agent_role', slow.agent_role,
        'duration_ms', (extract(epoch from (slow.end_at - slow.start_at)) * 1000)::bigint,
        'closed', slow.closed
      ) order by (slow.end_at - slow.start_at) desc)
      from (
        select * from public.analysis_runtime_intervals(v_run.id, array['MODEL'])
        order by (end_at - start_at) desc
        limit 20
      ) slow
    ), '[]'::jsonb),
    'failures', coalesce((
      select jsonb_agg(jsonb_build_object(
        'event_type', failure.event_type,
        'error_code', failure.error_code,
        'reason_code', failure.reason_code,
        'occurrences', failure.occurrences,
        'first_seen_at', failure.first_seen_at
      ) order by failure.occurrences desc)
      from (
        select
          event.event_type,
          event.error_code,
          event.payload ->> 'reason_code' as reason_code,
          count(*) as occurrences,
          min(event.occurred_at) as first_seen_at
        from public.analysis_runtime_event event
        where event.agent_run_id = v_run.id
          and (event.event_type like '%\_FAILED' or event.event_type like '%\_DENIED')
        group by 1, 2, 3
      ) failure
    ), '[]'::jsonb),
    'open_at_end', coalesce((
      select jsonb_agg(jsonb_build_object(
        'correlation_id', open_row.correlation_id,
        'scope', open_row.scope,
        'tool_name', open_row.tool_name,
        'started_at', open_row.start_at
      ) order by open_row.start_at)
      from public.analysis_runtime_intervals(v_run.id, array['MODEL', 'TOOL']) as open_row
      where not open_row.closed
    ), '[]'::jsonb),
    'timeline', v_timeline,
    'timeline_truncated', v_truncated,
    'timeline_sampled_scopes', to_jsonb(v_sampled),
    /*
     * 已知插桩盲区，机器可读。
     *
     * 方案 §1.2 要求"必须承认盲区"，§15 要求"§1.2 表里每个问题逐条走一遍，不是纸面声明"。
     * 逐条走完发现第 13 条（慢是模型侧 / 平台侧 / 数据库往返）里的第三项在首版没有插桩：
     * `db_ms` 这个字段在 §6.9.1 的表结构里根本不存在。与其造一个名字像、语义不对的数
     * （`read_snapshot_code` 读的是本地 git 对象，不是数据库），不如把缺口显式告诉 AI ——
     * 它们全部落在 `unattributed_ms` 里，而 `unattributed_pct` 会因此偏高。
     *
     * 这个数组就是"下一步该插哪里"的待办清单。补上插桩后从这里删掉对应条目。
     */
    'instrumentation_gaps', jsonb_build_array(
      jsonb_build_object(
        'code', 'DB_ROUNDTRIP_NOT_INSTRUMENTED',
        'question', '慢是数据库往返吗',
        'reason', 'Worker 到 Supabase 的 RPC 往返没有 correlation 生命周期',
        'falls_into', 'unattributed_ms'
      ),
      jsonb_build_object(
        'code', 'HARNESS_ORCHESTRATION_NOT_INSTRUMENTED',
        'question', 'Harness 内部编排与上下文组装花了多久',
        'reason', 'agent-loop 的编排、上下文组装与 ACP 往返不在 tools/pre-execute 与 llm/stream 边界上',
        'falls_into', 'unattributed_ms'
      ),
      jsonb_build_object(
        'code', 'FAST_TOOL_STARTED_COLLAPSED',
        'question', '不足一个 flush 周期的工具何时开始',
        'reason', '§7.3 的折叠让快工具只落一条 TERMINAL，区间由 occurred_at + duration 重建',
        'falls_into', 'tool_ms_union'
      ),
      jsonb_build_object(
        'code', 'WORKFLOW_AND_JOB_TREE_ABSENT',
        'question', 'Workflow 步骤与 Harness Job 实例各花了多久',
        'reason', 'Phase 3 之前平台没有它们的生命周期路由；只有 workflow / job_* 的工具调用可见',
        'falls_into', 'tool_ms_union'
      )
    ),
    'instrumentation_health', jsonb_build_object(
      'events_total', v_event_count,
      'events_reported', coalesce(v_rollup.events_reported, v_event_count),
      'events_dropped', coalesce(v_rollup.events_dropped, 0),
      'unattributed_pct', case when v_wall > 0
        then round((coalesce(v_rollup.unattributed_ms, 0)::numeric * 100) / v_wall, 2)
        else 0 end,
      'rollup_version', coalesce(v_rollup.rollup_version, 0),
      'timeline_truncated', v_truncated
    )
  );
end;
$$;

revoke execute on function public.get_analysis_attempt_diagnostics(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.get_analysis_attempt_diagnostics(uuid, integer) to service_role;

create or replace function public.get_analysis_run_trend(
  p_group_by text[] default array['model_label', 'policy_hash'],
  p_since timestamptz default now() - interval '90 days',
  p_batch_id uuid default null,
  p_terminal_status text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allowed text[] := array[
    'model_label', 'policy_hash', 'profile_config_hash', 'harness_version',
    'capability_contract_hash', 'worker_id', 'batch_id', 'finished_day'
  ];
  v_dim text;
  v_exprs text[] := array[]::text[];
  v_keys text[] := array[]::text[];
  v_sql text;
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    perform public.ensure_admin();
  end if;
  if p_group_by is null or array_length(p_group_by, 1) is null then
    raise exception 'TREND_GROUP_BY_REQUIRED';
  end if;
  if p_terminal_status is not null and p_terminal_status not in ('COMMITTED', 'FAILED') then
    raise exception 'TREND_TERMINAL_STATUS_INVALID';
  end if;

  foreach v_dim in array p_group_by loop
    if not (v_dim = any (v_allowed)) then
      -- 白名单外的列名一律报错，绝不拼进 SQL。
      raise exception 'TREND_GROUP_BY_INVALID: %', v_dim;
    end if;
    v_keys := v_keys || v_dim;
    if v_dim = 'finished_day' then
      v_exprs := v_exprs || 'to_jsonb(rollup.finished_at::date)';
    else
      v_exprs := v_exprs || format('to_jsonb(rollup.%I)', v_dim);
    end if;
  end loop;

  v_sql := format($fmt$
    select coalesce(jsonb_agg(grouped.entry order by grouped.total desc), '[]'::jsonb)
    from (
      select
        count(*) as total,
        jsonb_build_object(
          'group', jsonb_build_object(%s),
          'count', count(*),
          'failed', count(*) filter (where rollup.terminal_status = 'FAILED'),
          'failure_rate', round(
            (count(*) filter (where rollup.terminal_status = 'FAILED'))::numeric
            / greatest(count(*), 1), 4),
          'wall_ms_p50', percentile_cont(0.5) within group (order by rollup.wall_ms),
          'wall_ms_p95', percentile_cont(0.95) within group (order by rollup.wall_ms),
          'wall_ms_max', max(rollup.wall_ms),
          'setup_ms_p50', percentile_cont(0.5) within group (order by rollup.setup_ms),
          'model_ms_union_p50', percentile_cont(0.5) within group (order by rollup.model_ms_union),
          'tool_ms_union_p50', percentile_cont(0.5) within group (order by rollup.tool_ms_union),
          'platform_tool_ms_union_p50', percentile_cont(0.5)
            within group (order by rollup.platform_tool_ms_union),
          'busy_ms_union_p50', percentile_cont(0.5) within group (order by rollup.busy_ms_union),
          'teardown_ms_p50', percentile_cont(0.5) within group (order by rollup.teardown_ms),
          'agent_idle_ms_p50', percentile_cont(0.5) within group (order by rollup.agent_idle_ms),
          'unattributed_ms_p50', percentile_cont(0.5)
            within group (order by rollup.unattributed_ms),
          'unattributed_pct', round(
            (sum(rollup.unattributed_ms)::numeric * 100) / greatest(sum(rollup.wall_ms), 1), 2),
          'terminal_error_codes', coalesce(jsonb_object_agg(
            rollup.terminal_error_code, 1) filter (where rollup.terminal_error_code is not null),
            '{}'::jsonb),
          'events_dropped', sum(rollup.events_dropped)
        ) as entry
      from public.analysis_agent_run_rollup rollup
      where rollup.finished_at >= $1
        and rollup.rollup_version > 0
        and ($2::uuid is null or rollup.batch_id = $2)
        and ($3::text is null or rollup.terminal_status = $3)
      group by %s
    ) grouped
  $fmt$,
    (
      select string_agg(format('%L, %s', v_keys[idx], v_exprs[idx]), ', ')
      from generate_subscripts(v_keys, 1) as idx
    ),
    array_to_string(v_exprs, ', ')
  );

  execute v_sql into v_result using p_since, p_batch_id, p_terminal_status;

  return jsonb_build_object(
    'server_time', now(),
    'since', p_since,
    'group_by', to_jsonb(v_keys),
    'groups', coalesce(v_result, '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.get_analysis_run_trend(text[], timestamptz, uuid, text)
  from public, anon, authenticated;
grant execute on function public.get_analysis_run_trend(text[], timestamptz, uuid, text)
  to service_role;

create or replace function public.get_analysis_runtime_findings(
  p_batch_id uuid default null,
  p_since timestamptz default now() - interval '7 days'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_findings jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    perform public.ensure_admin();
  end if;

  with scoped as (
    select * from public.analysis_agent_run_rollup rollup
    where rollup.finished_at >= p_since
      and rollup.rollup_version > 0
      and (p_batch_id is null or rollup.batch_id = p_batch_id)
  ),
  regression as (
    select
      recent.model_label,
      recent.policy_hash,
      recent.p95 as recent_p95,
      earlier.p95 as earlier_p95
    from (
      select model_label, policy_hash,
             percentile_cont(0.95) within group (order by wall_ms) as p95,
             count(*) as total
      from scoped
      where finished_at >= p_since + (now() - p_since) / 2
      group by 1, 2
    ) recent
    join (
      select model_label, policy_hash,
             percentile_cont(0.95) within group (order by wall_ms) as p95,
             count(*) as total
      from scoped
      where finished_at < p_since + (now() - p_since) / 2
      group by 1, 2
    ) earlier
      on earlier.model_label is not distinct from recent.model_label
     and earlier.policy_hash is not distinct from recent.policy_hash
    where recent.total >= 3 and earlier.total >= 3
      and earlier.p95 > 0
      and recent.p95 > earlier.p95 * 1.3
  ),
  raw as (
    select 'HIGH_UNATTRIBUTED_TIME' as code, 'WARN' as severity, scoped.agent_run_id,
           jsonb_build_object('unattributed_ms', scoped.unattributed_ms,
                              'wall_ms', scoped.wall_ms) as evidence
    from scoped where scoped.wall_ms > 0
      and scoped.unattributed_ms::numeric / scoped.wall_ms > 0.4

    union all
    select 'LOW_PARALLELISM', 'INFO', scoped.agent_run_id,
           jsonb_build_object('agent_count', scoped.agent_count,
                              'model_ms_sum', scoped.model_ms_sum,
                              'model_ms_union', scoped.model_ms_union)
    from scoped where scoped.agent_count > 1 and scoped.model_ms_union > 0
      and scoped.model_ms_sum::numeric / scoped.model_ms_union < 1.2

    union all
    select 'AGENT_IDLE_DOMINANT', 'WARN', scoped.agent_run_id,
           jsonb_build_object('agent_idle_ms', scoped.agent_idle_ms, 'wall_ms', scoped.wall_ms)
    from scoped where scoped.wall_ms > 0
      and scoped.agent_idle_ms::numeric / scoped.wall_ms > 0.3

    union all
    select 'RETRY_STORM', 'WARN', scoped.agent_run_id,
           jsonb_build_object('retry', coalesce((scoped.model_requests_by_kind->>'retry')::numeric, 0),
                              'model_requests', scoped.model_requests)
    from scoped where scoped.model_requests > 0
      and coalesce((scoped.model_requests_by_kind->>'retry')::numeric, 0)
          / scoped.model_requests > 0.2

    union all
    select 'COMPACTION_HEAVY', 'INFO', scoped.agent_run_id,
           jsonb_build_object(
             'compaction', coalesce((scoped.model_requests_by_kind->>'compaction')::numeric, 0),
             'model_requests', scoped.model_requests)
    from scoped where scoped.model_requests > 0
      and coalesce((scoped.model_requests_by_kind->>'compaction')::numeric, 0)
          / scoped.model_requests > 0.15

    union all
    select 'TOOL_DOMINATED_BY_ONE', 'INFO', scoped.agent_run_id,
           jsonb_build_object('tool_ms_by_name', scoped.tool_ms_by_name,
                              'tool_ms_sum', scoped.tool_ms_sum)
    from scoped where scoped.tool_ms_sum > 0
      and (
        select max(value::numeric) from jsonb_each_text(scoped.tool_ms_by_name)
      ) / scoped.tool_ms_sum > 0.5

    union all
    select 'AGENT_NO_EVIDENCE', 'INFO', scoped.agent_run_id,
           jsonb_build_object('agents', (
             select jsonb_agg(agent)
             from jsonb_array_elements(scoped.per_agent) as agent
             where (agent->>'model_requests')::integer > 5
               and coalesce((agent->>'evidence_produced')::integer, 0) = 0
           ))
    from scoped where exists (
      select 1 from jsonb_array_elements(scoped.per_agent) as agent
      where (agent->>'model_requests')::integer > 5
        and coalesce((agent->>'evidence_produced')::integer, 0) = 0
    )

    union all
    select 'SUBMIT_CONTENTION', 'WARN', scoped.agent_run_id,
           jsonb_build_object('rejected_submissions', scoped.rejected_submissions)
    from scoped where scoped.rejected_submissions > 0

    union all
    select 'UNCLOSED_AT_END', 'WARN', scoped.agent_run_id,
           jsonb_build_object('open_correlations', (
             select count(*) from public.analysis_runtime_intervals(
               scoped.agent_run_id, array['MODEL', 'TOOL']) as open_row
             where not open_row.closed
           ))
    from scoped where exists (
      select 1 from public.analysis_runtime_intervals(
        scoped.agent_run_id, array['MODEL', 'TOOL']) as open_row
      where not open_row.closed
    )

    union all
    select 'EVENTS_DROPPED', 'CRITICAL', scoped.agent_run_id,
           jsonb_build_object('events_dropped', scoped.events_dropped,
                              'events_reported', scoped.events_reported)
    from scoped where scoped.events_dropped > 0

    union all
    select 'SLOW_REGRESSION', 'WARN', null::uuid,
           jsonb_build_object('model_label', regression.model_label,
                              'policy_hash', regression.policy_hash,
                              'recent_p95_ms', regression.recent_p95,
                              'earlier_p95_ms', regression.earlier_p95)
    from regression
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'code', raw.code,
    'severity', raw.severity,
    'agent_run_id', raw.agent_run_id,
    'evidence', raw.evidence
  ) order by raw.code, raw.agent_run_id), '[]'::jsonb)
    into v_findings
  from raw;

  return jsonb_build_object(
    'server_time', now(),
    'since', p_since,
    'batch_id', p_batch_id,
    'findings', v_findings
  );
end;
$$;

revoke execute on function public.get_analysis_runtime_findings(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_analysis_runtime_findings(uuid, timestamptz)
  to service_role;

------------------------------------------------------------------------------
-- 16. get_analysis_agent_run_detail：只加当前活动投影字段
--
--     Agent 详情页继续用这个快照 RPC，不接游标（方案 §8.1：不在同一屏渲染 cursor 数据
--     和快照数据，避免出现两个不同的"最后更新时间"）。这里只把 0032 新增的
--     `current_activity_*` 与 `attempt_phase_*` 投影列带出去 —— 它们是快照的一部分。
--
--     授权与语义完全不变：仍然是 `ensure_view_review_batch`。`can_view_review_batch`
--     只校验角色不校验归属，这个越权问题单独记为待修项，本迁移不扩大它的使用面，也不在
--     这里顺手收紧（那会改变现有 VIEWER 能力，属于产品行为变更）。
------------------------------------------------------------------------------

create or replace function public.get_analysis_agent_run_detail(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_job_id uuid;
  v_batch_id uuid;
  v_run public.analysis_agent_run;
begin
  select task.job_id, job.batch_id into v_job_id, v_batch_id
  from public.analysis_story_task task
  join public.analysis_job job on job.id = task.job_id
  where task.id = p_task_id;

  if v_job_id is null then
    return null;
  end if;
  perform public.ensure_view_review_batch(v_batch_id);

  select * into v_run from public.analysis_agent_run
  where task_id = p_task_id
  order by agent_attempt desc
  limit 1;

  if v_run.id is null then
    return null;
  end if;

  return jsonb_build_object(
    'run_id', v_run.id,
    'task_id', v_run.task_id,
    'job_id', v_run.job_id,
    'agent_attempt', v_run.agent_attempt,
    'status', v_run.status,
    'policy_hash', v_run.policy_hash,
    'tree_digest', v_run.tree_digest,
    'session_revision', v_run.session_revision,
    'resume_count', v_run.resume_count,
    'cancel_requested_at', v_run.cancel_requested_at,
    'cancel_reason', v_run.cancel_reason,
    'sealed_at', v_run.sealed_at,
    'error_code', v_run.error_code,
    'started_at', v_run.started_at,
    'committed_at', v_run.committed_at,
    'finished_at', v_run.finished_at,
    -- V1.5：ATTEMPT 阶段投影。低频（约 10~15 条/attempt），不构成热行。
    'attempt_phase_code', v_run.attempt_phase_code,
    'attempt_phase_started_at', v_run.attempt_phase_started_at,
    'usage', jsonb_build_object(
      'model_requests', v_run.model_requests,
      'root_model_requests', v_run.root_model_requests,
      'child_model_requests', v_run.child_model_requests,
      'retry_requests', v_run.retry_requests,
      'compaction_requests', v_run.compaction_requests,
      'ralph_rounds', v_run.ralph_rounds,
      'tool_calls', v_run.tool_calls,
      'evidence_shown', v_run.evidence_shown,
      'searches_run', v_run.searches_run,
      'web_requests', v_run.web_requests,
      'web_bytes', v_run.web_bytes,
      'input_tokens', v_run.input_tokens,
      'output_tokens', v_run.output_tokens,
      'agent_count', v_run.agent_count,
      'max_depth_reached', v_run.max_depth_reached
    ),
    'agents', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'node_id', node.id,
        'agent_id', node.agent_id,
        'parent_node_id', node.parent_agent_node_id,
        'agent_role', node.agent_role,
        'provider', node.provider,
        'delegation_depth', node.delegation_depth,
        'status', node.status,
        'model_requests', node.model_requests,
        'tool_calls', node.tool_calls,
        'evidence_produced', node.evidence_produced,
        'input_tokens', node.input_tokens,
        'output_tokens', node.output_tokens,
        'error_code', node.error_code,
        'started_at', node.started_at,
        'finished_at', node.finished_at,
        -- V1.5：每个 Agent 各自的当前活动。并发时不互相覆盖。
        'current_activity_scope', node.current_activity_scope,
        'current_activity_code', node.current_activity_code,
        'current_activity_status', node.current_activity_status,
        'current_tool_name', node.current_tool_name,
        'current_activity_started_at', node.current_activity_started_at,
        'current_activity_updated_at', node.current_activity_updated_at
      ) order by node.delegation_depth, node.started_at), '[]'::jsonb)
      from public.analysis_agent_node node
      where node.agent_run_id = v_run.id
    ),
    'tool_summary', (
      select coalesce(jsonb_agg(row_to_json(summary)::jsonb), '[]'::jsonb)
      from (
        select audit.tool_name,
               audit.permission_verdict,
               count(*)::integer as call_count,
               coalesce(sum(audit.duration_ms), 0)::integer as total_duration_ms
        from public.analysis_tool_audit audit
        where audit.agent_run_id = v_run.id
        group by audit.tool_name, audit.permission_verdict
        order by audit.tool_name
      ) summary
    ),
    'artifacts', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'artifact_id', artifact.id,
        'artifact_type', artifact.artifact_type,
        'workspace_path', artifact.workspace_path,
        'content_hash', artifact.content_hash,
        'size_bytes', artifact.size_bytes,
        'verification_status', artifact.verification_status,
        'created_at', artifact.created_at
      ) order by artifact.created_at), '[]'::jsonb)
      from public.analysis_artifact artifact
      where artifact.agent_run_id = v_run.id
    ),
    'evidence', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'evidence_id', evidence.evidence_id,
        'repository_name', evidence.repository_name,
        'file_path', evidence.file_path,
        'start_line', evidence.start_line,
        'end_line', evidence.end_line,
        'evidence_type', evidence.evidence_type,
        'evidence_origin', evidence.evidence_origin,
        'description', evidence.description,
        'producer_agent_node_id', evidence.producer_agent_node_id
      ) order by evidence.repository_name, evidence.file_path), '[]'::jsonb)
      from public.analysis_agent_evidence evidence
      where evidence.agent_run_id = v_run.id
    )
  );
end;
$$;

revoke execute on function public.get_analysis_agent_run_detail(uuid) from public, anon;
grant execute on function public.get_analysis_agent_run_detail(uuid)
  to authenticated, service_role;

commit;




