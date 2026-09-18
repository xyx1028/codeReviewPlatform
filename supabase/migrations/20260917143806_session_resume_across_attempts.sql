-- Session 续跑真正可用（V1.9）：mid-turn checkpoint 前缀 + 跨 attempt 恢复。
--
-- 文件名说明：与 20260917143805 同批次，秒数 +1，把先后依赖写死在文件名里
-- （本机 `date -u` 当前返回 2026091713xxxx，按真实 UTC 命名会排到已有迁移之前）。
--
-- ## 这份迁移要修的两件事
--
-- ### 1. checkpoint 只在 turn 正常结束时才写，所以被 kill 时永远没有 checkpoint
--
-- 引擎在 `await runTurn(...)` **返回之后**才写 checkpoint。一次 attempt 的 turn 要跑
-- 20~40 分钟，容器在这期间被重建 / 被 SIGKILL 的话，那一次 turn 永远不返回，
-- checkpoint 也就永远不写。云端库的实测证据：整张 `analysis_session_checkpoint`
-- 只有 1 行，而 Session 卷上已经有 414 个 attempt 目录、225MB JSONL。
--
-- Worker 侧改成"每分钟写一次"之后，同一个 (session_id, session_revision) 会被反复写。
-- 原来的 upsert 已经能处理冲突，但**内容哈希的语义必须改**：一个还在被追加的 JSONL，
-- 它的整文件哈希在下一毫秒就过期了，恢复时拿旧哈希比对整文件必然不等，于是
-- `inspectSessionLog` 会把每一次真实恢复都判成 `SESSION_FENCED`。
--
-- 所以新增 `prefix_bytes`：checkpoint 记录的是"**前 prefix_bytes 个字节**（到最后一个
-- 完整记录的换行为止）的哈希"。恢复时只要求磁盘上的文件以这段前缀开头 —— 文件更长是
-- 正常的（进程被杀之前又写了几条），文件前缀被改动才是真的有别的写者。
--
-- ### 2. 恢复候选只在"当前 attempt 自己的 run"里找，而每次 claim 都会 +1 attempt
--
-- `claim_next_story_task` 每次领取都 `agent_attempt = agent_attempt + 1` 并新建一行
-- `analysis_agent_run`。旧版 `load_resumable_analysis_attempt` 只查
-- `agent_attempt = task.agent_attempt` 那一行的 checkpoint，而那行 run 是刚建的、
-- 必然没有 checkpoint —— 于是恢复在结构上不可能发生。日志里 `resumed` 恒为 false、
-- `resume_count` 恒为 0，全部是这一条造成的。
--
-- 新版改成在**同一个 task 的全部 run**里找最新的可用 checkpoint，并把它所属的
-- `agent_attempt` 一起返回（`source_agent_attempt`）。Worker 用它派生 Session 目录、
-- Workspace 目录和 root agent id，从而让 profile hash 与 checkpoint 里记的那份一致 ——
-- 这三个路径此前都按 (task, attempt) 派生，attempt 一变就全变，恢复门禁必然不通过。
--
-- ## 安全边界（一条都不放宽）
--
--   * 任何一次 attempt 已经 COMMITTED，或 task 已 SUCCEEDED → 一律不恢复。
--     "已提交结果绝不重跑"是硬约束，ACP 响应丢失不是重跑的理由。
--   * 当前 run 已被封存（`sealed_at`）或已请求取消 → 不恢复。
--   * Job 冻结的 policy 关掉了 `session.resumeOnWorkerRestart` → 不恢复。
--   * 恢复链路长度有界：`resume_count` 沿着 attempt 链累加，Worker 侧
--     `MAX_SESSION_RESUMES = 3` 判定上限。
--   * fencing 不变：`session_revision` 按 task 全局单调，恢复时取
--     `greatest(当前 run, checkpoint + 1)`，任何迟到的旧 attempt 写入都必然落后。

begin;

-- ---------------------------------------------------------------------------
-- 1. prefix_bytes 列
--
-- `create table if not exists` 对已存在的表是 no-op，所以新列必须显式 alter。
-- 允许 NULL：迁移之前写的 checkpoint 没有这个值，恢复侧对 NULL 回退到"整文件哈希"
-- 的旧语义，而不是让一个在途 attempt 因为"我们后来加了一列"而不可恢复。
-- ---------------------------------------------------------------------------
alter table public.analysis_session_checkpoint
  add column if not exists prefix_bytes bigint;

alter table public.analysis_session_checkpoint
  drop constraint if exists analysis_session_checkpoint_prefix_bytes_check;
alter table public.analysis_session_checkpoint
  add constraint analysis_session_checkpoint_prefix_bytes_check
  check (prefix_bytes is null or prefix_bytes >= 0);

comment on column public.analysis_session_checkpoint.prefix_bytes is
  'Byte length of the verified log prefix that content_hash covers (through the '
  'last complete JSONL record). NULL means content_hash covers the whole file '
  '(pre-V1.9 checkpoints).';

-- ---------------------------------------------------------------------------
-- 2. save_analysis_session_checkpoint：多带 prefix_bytes
--
-- 签名变了，所以必须先 drop 精确的旧签名再建：`create or replace` 改不了签名，它会
-- 留下一个仍然可调用的 13 参旧重载，而那条路径写出来的 checkpoint 没有 prefix_bytes。
-- 少一个参数的调用（旧 Worker）会落到新函数的默认值上，行为等价于改造前。
-- ---------------------------------------------------------------------------
drop function if exists public.save_analysis_session_checkpoint(
  uuid, text, uuid, integer, text, integer, text, text, integer, text, text, text, text
);

create or replace function public.save_analysis_session_checkpoint(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_agent_attempt integer,
  p_session_id text,
  p_session_revision integer,
  p_storage_locator text,
  p_content_hash text,
  p_event_count integer,
  p_harness_version text,
  p_profile_hash text default null,
  p_status text default 'OPEN',
  p_skill_catalog_hash text default null,
  p_prefix_bytes bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.analysis_agent_run;
  v_retention integer;
  v_id uuid;
begin
  select run.* into v_run
  from public.analysis_agent_run run
  join public.analysis_story_task task on task.id = run.task_id
  where run.task_id = p_task_id
    and run.agent_attempt = p_agent_attempt
    and task.worker_id = p_worker_id
    and task.lease_expires_at is not null
    and task.lease_expires_at >= now()
    and p_claim_token is not null
    and task.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
  for update of run;

  if v_run.id is null then
    raise exception 'TASK_LEASE_LOST';
  end if;
  -- fencing：revision 只能前进。落后的写入来自被接管的旧 Worker。
  if p_session_revision < v_run.session_revision then
    raise exception 'SESSION_FENCED';
  end if;

  select coalesce((job.capability_policy_snapshot #>> '{session,retentionDays}')::integer, 7)
  into v_retention
  from public.analysis_job job where job.id = v_run.job_id;

  insert into public.analysis_session_checkpoint (
    agent_run_id, session_id, session_revision, storage_locator, content_hash,
    event_count, harness_version, profile_hash, status, retention_until,
    skill_catalog_hash, prefix_bytes
  ) values (
    v_run.id, p_session_id, p_session_revision, p_storage_locator, p_content_hash,
    greatest(coalesce(p_event_count, 0), 0), p_harness_version, p_profile_hash,
    coalesce(p_status, 'OPEN'), now() + make_interval(days => v_retention),
    p_skill_catalog_hash, p_prefix_bytes
  )
  on conflict (session_id, session_revision) do update
  set storage_locator = excluded.storage_locator,
      content_hash = excluded.content_hash,
      event_count = excluded.event_count,
      status = excluded.status,
      retention_until = excluded.retention_until,
      skill_catalog_hash = coalesce(excluded.skill_catalog_hash, public.analysis_session_checkpoint.skill_catalog_hash),
      -- 周期 checkpoint 会反复覆盖同一行：前缀只会变长，绝不回退。
      prefix_bytes = excluded.prefix_bytes
  returning id into v_id;

  update public.analysis_agent_run
  set session_revision = greatest(session_revision, p_session_revision),
      last_checkpoint_at = now()
  where id = v_run.id;

  return jsonb_build_object('checkpoint_id', v_id, 'session_revision', p_session_revision);
end;
$$;

revoke execute on function public.save_analysis_session_checkpoint(
  uuid, text, uuid, integer, text, integer, text, text, integer, text, text, text, text, bigint
) from public, anon, authenticated;
grant execute on function public.save_analysis_session_checkpoint(
  uuid, text, uuid, integer, text, integer, text, text, integer, text, text, text, text, bigint
) to service_role;

-- ---------------------------------------------------------------------------
-- 3. load_resumable_analysis_attempt：跨 attempt 找候选
--
-- 签名不变（uuid, text, uuid），只换函数体与返回的 JSON 字段，所以可以直接
-- `create or replace`，不需要 drop。
-- ---------------------------------------------------------------------------
create or replace function public.load_resumable_analysis_attempt(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.analysis_story_task;
  v_run public.analysis_agent_run;
  v_job public.analysis_job;
  v_candidate record;
  v_revision integer;
  v_resume_count integer;
begin
  select * into v_task from public.analysis_story_task where id = p_task_id;
  if v_task.id is null then
    return null;
  end if;
  -- claim 四要素校验：只有当前持有者能问"我能不能接着上一次跑"。
  if v_task.worker_id is distinct from p_worker_id
     or p_claim_token is null
     or v_task.claim_token_digest is distinct from public.agent_claim_token_digest(p_claim_token) then
    return null;
  end if;
  -- 已成功的 task 不存在"继续"，只存在"重复提交"。
  if v_task.agent_status = 'SUCCEEDED' then
    return null;
  end if;

  select * into v_run from public.analysis_agent_run
  where task_id = p_task_id and agent_attempt = v_task.agent_attempt
  for update;
  if v_run.id is null
     or v_run.status = 'COMMITTED'
     or v_run.sealed_at is not null
     or v_run.cancel_requested_at is not null then
    return null;
  end if;

  -- 这个 task 的任何一次 attempt 提交过结果 → 绝不恢复。
  if exists (
    select 1 from public.analysis_agent_run run
    where run.task_id = p_task_id and run.status = 'COMMITTED'
  ) then
    return null;
  end if;

  select * into v_job from public.analysis_job where id = v_run.job_id;
  if coalesce((v_job.capability_policy_snapshot #>> '{session,resumeOnWorkerRestart}')::boolean, true)
     is not true then
    return null;
  end if;

  /*
   * 候选 = 这个 task 的全部 run 里最新的一条可用 checkpoint。
   *
   * 关键的一行是 `source_run.task_id = p_task_id` 而不是 `agent_attempt = 当前 attempt`：
   * 每次 claim 都会 +1 attempt 并新建 run，所以"当前 attempt 的 checkpoint"永远是空的。
   *
   * 排序用 (session_revision desc, created_at desc)：revision 按 task 全局单调，所以它
   * 就是"最近一次成功落盘的写入"的正确序。
   */
  select cp.session_id,
         cp.session_revision,
         cp.storage_locator,
         cp.content_hash,
         cp.prefix_bytes,
         cp.harness_version,
         cp.profile_hash,
         cp.skill_catalog_hash,
         source_run.id as source_run_id,
         source_run.agent_attempt as source_agent_attempt,
         source_run.policy_hash as source_policy_hash,
         source_run.root_agent_id as source_root_agent_id,
         source_run.root_session_id as source_root_session_id,
         source_run.resume_count as source_resume_count
    into v_candidate
  from public.analysis_session_checkpoint cp
  join public.analysis_agent_run source_run on source_run.id = cp.agent_run_id
  where source_run.task_id = p_task_id
    and source_run.status <> 'COMMITTED'
    and cp.status in ('OPEN', 'SEALED')
  order by cp.session_revision desc, cp.created_at desc
  limit 1;

  if v_candidate.session_id is null then
    return null;
  end if;

  -- fencing revision：既要超过当前 run 的水位，也要超过 checkpoint 的水位。
  v_revision := greatest(v_run.session_revision, v_candidate.session_revision + 1);
  -- 恢复次数沿 attempt 链累加，Worker 侧据此判上限（MAX_SESSION_RESUMES）。
  v_resume_count := coalesce(v_candidate.source_resume_count, 0) + 1;

  update public.analysis_agent_run
  set resume_count = v_resume_count,
      session_revision = v_revision,
      -- 恢复的是同一个会话，所以 root 身份沿用被恢复 attempt 的那一份；缺失时留空，
      -- 由 record_analysis_attempt_profile 在物化 profile 后写入。
      root_agent_id = coalesce(root_agent_id, v_candidate.source_root_agent_id),
      root_session_id = coalesce(root_session_id, v_candidate.source_root_session_id)
  where id = v_run.id;

  return jsonb_build_object(
    'agent_run_id', v_run.id,
    'root_session_id', coalesce(v_run.root_session_id, v_candidate.source_root_session_id),
    'root_agent_id', coalesce(v_run.root_agent_id, v_candidate.source_root_agent_id),
    'session_id', v_candidate.session_id,
    'session_revision', v_revision,
    'storage_locator', v_candidate.storage_locator,
    'content_hash', v_candidate.content_hash,
    'prefix_bytes', v_candidate.prefix_bytes,
    'harness_version', v_candidate.harness_version,
    'profile_hash', v_candidate.profile_hash,
    -- policy hash 取被恢复 attempt 的那一份：门禁比的是"这段历史是在哪套 policy 下产生的"。
    'policy_hash', coalesce(v_candidate.source_policy_hash, v_run.policy_hash),
    'skill_catalog_hash', v_candidate.skill_catalog_hash,
    'job_skill_catalog_hash', v_job.skill_catalog_hash,
    'resume_count', v_resume_count,
    -- Worker 用它派生 Session 目录 / Workspace 目录 / root agent id，
    -- 从而让本次 attempt 的 profile hash 与 checkpoint 里记的那份一致。
    'source_agent_attempt', v_candidate.source_agent_attempt,
    'source_agent_run_id', v_candidate.source_run_id
  );
end;
$$;

revoke execute on function public.load_resumable_analysis_attempt(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.load_resumable_analysis_attempt(uuid, text, uuid)
  to service_role;

commit;
