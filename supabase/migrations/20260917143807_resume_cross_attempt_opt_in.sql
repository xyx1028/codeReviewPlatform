-- 跨 attempt 恢复必须由调用方显式开启（V1.9 混跑保护）。
--
-- 文件名说明：与 20260917143805 / 143806 同批次，秒数继续 +1，把先后依赖写死在文件名里。
--
-- ## 为什么需要这一层开关
--
-- `20260917143806` 让 `load_resumable_analysis_attempt` 可以返回**上一次 attempt** 的
-- checkpoint。这对新 Worker 是必须的，但对旧 Worker 是有害的：
--
--   * 旧 Worker 不认识 `source_agent_attempt`，它会按**自己**的 attempt 号派生 Session
--     目录、Workspace cwd 和 root 身份，于是算出来的 profile hash 与 checkpoint 里那份
--     必然不同；
--   * 旧 Worker 的拒绝路径是 **fail closed**（抛 `SESSION_FORMAT_UNSUPPORTED` 终止 attempt），
--     而不是"退回新会话"。于是同一份历史 checkpoint 会把这个 task 的每一次新 attempt
--     都毒死 —— 任务永远做不完。
--
-- 这个窗口是真实存在的：发布顺序是"先 `supabase db push`，再重建 Worker"，两步之间
-- 旧 Worker 仍在跑，而且它们手上可能正有带 checkpoint 的任务。
--
-- 所以把跨 attempt 判定改成**显式 opt-in**：
--
--   * 不传 `p_allow_cross_attempt`（旧 Worker，PostgREST 只发 3 个键）→ 默认 false，
--     行为与迁移前完全一致（只看当前 attempt 的 run）；
--   * 新 Worker 显式传 true → 才会拿到上一次 attempt 的候选。
--
-- 必须 `drop` 旧的 3 参签名再建 4 参版本：`create or replace` 改不了签名，会留下一个
-- 3 参重载，而 PostgREST 面对 3 个键的请求会在两个候选之间报"无法选择"。

begin;

drop function if exists public.load_resumable_analysis_attempt(uuid, text, uuid);

create or replace function public.load_resumable_analysis_attempt(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_allow_cross_attempt boolean default false
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
  v_cross boolean := coalesce(p_allow_cross_attempt, false);
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
   * 候选 = 这个 task 里最新的一条可用 checkpoint。
   *
   * `v_cross` 为假时退回迁移前的语义：只看当前 attempt 自己的 run。那条路径专门留给
   * 尚未升级的 Worker —— 它们的拒绝是 fail closed，不能让它们看到历史候选。
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
    and (v_cross or source_run.agent_attempt = v_task.agent_attempt)
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

revoke execute on function public.load_resumable_analysis_attempt(uuid, text, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.load_resumable_analysis_attempt(uuid, text, uuid, boolean)
  to service_role;

commit;
