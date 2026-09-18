-- 收紧在途 Agent 任务的接管判据（V1.9）。
--
-- 文件名说明：本机 `date -u +%Y%m%d%H%M%S` 当前返回 20260917130723，而目录里已有
-- 20260917143803_*.sql（历史迁移的时间戳偏前），若按真实 UTC 命名会插到已有迁移之前。
-- 按 `$supabase-migration-naming` 的"同批次冲突则秒数加 1"规则，取现有最大值 +2 秒，
-- 把先后关系写死在文件名里。
--
-- ## 为什么改
--
-- 旧判据（0026 引入、0027 沿用）只有一条证据：`analysis_worker_heartbeat` 在 20 秒内
-- 没有更新。它有两个真实后果：
--
--   1. **容错窗口太窄。** 可用性心跳每 5 秒一次，20 秒等于只容 4 次。任何一次
--      Supabase 抖动、宿主机 CPU 争抢或事件循环被同步文件遍历卡住，都会让一个**正在
--      正常跑模型请求**的副本被判定掉线，它手上的 attempt 被别的副本接管，然后
--      `agent_attempt+1` 从零重跑 —— 20~40 分钟的模型时间和对应 token 直接损失。
--   2. **忽略了更直接的证据。** attempt 自己每 `HEARTBEAT_INTERVAL_MS`（默认 30 秒）
--      调 `heartbeat_analysis_story_task` 续租，把 `analysis_story_task.heartbeat_at`
--      推到当前时刻。这条心跳走的是**另一条 RPC、另一个事务**，它还在动就说明这个
--      Worker 进程活着、这个 attempt 也活着。旧判据完全不看它。
--
-- 2026-09-17 的真实事故里，8 个在途 attempt 在新容器启动 22 秒后被同时判成
-- WORKER_LOST（`finished_at` 全部是 11:59:50），累计浪费 47.9 分钟模型时间。那一次的
-- 根因是容器被 `--force-recreate` 摧毁（进程真的没了，接管是对的），但同一条判据在
-- 抖动时会造成一模一样的损失，而那时接管是**错的**。
--
-- ## 新判据
--
-- 必须**两条心跳同时**陈旧才接管：
--
--   * `analysis_worker_heartbeat.last_seen_at` 超过 60 秒（12 次可用性心跳）；
--   * 且 `analysis_story_task.heartbeat_at` 超过 90 秒（3 次租约心跳）或为空。
--
-- 代价是真实掉线的恢复延迟从 ~20 秒变成 ~90 秒。在一个 attempt 动辄 20~40 分钟的
-- 系统里这点延迟没有意义，而误接管的代价是整个 attempt 重跑。
--
-- 这个函数的签名保持 0 参数不变：加一个带默认值的参数会留下一个同样能零参调用的旧
-- 重载，PostgREST 面对空 body 会因为两个候选函数而报错。

begin;

create or replace function public.reclaim_stale_story_task_leases()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_task record;
  -- 两个宽限期都以"心跳周期的整数倍 + 余量"为依据，不是拍脑袋的秒数。
  v_worker_grace constant interval := interval '60 seconds';
  v_task_grace constant interval := interval '90 seconds';
begin
  perform pg_advisory_xact_lock(hashtext('claim_next_story_task'));

  for v_task in
    select task.id,
           task.agent_attempt,
           task.worker_id,
           task.heartbeat_at,
           heartbeat.last_seen_at as worker_last_seen_at
    from public.analysis_story_task task
    join public.analysis_job job on job.id = task.job_id
    left join public.analysis_worker_heartbeat heartbeat
      on heartbeat.worker_id = task.worker_id
    where job.status = 'PROCESSING'
      and job.execution_engine = 'deepseek-harness-acp'
      and task.worker_id is not null
      and task.lease_expires_at >= now()
      and task.agent_status not in ('SUCCEEDED', 'FAILED')
      -- 证据一：Worker 副本级可用性心跳陈旧。
      and (
        heartbeat.last_seen_at is null
        or heartbeat.last_seen_at < now() - v_worker_grace
      )
      -- 证据二：这个 attempt 自己的租约心跳同样陈旧。两条心跳走不同 RPC、不同事务，
      -- 只有一条停了更可能是那条链路的问题，而不是 Worker 死了。
      and (
        task.heartbeat_at is null
        or task.heartbeat_at < now() - v_task_grace
      )
    for update of task skip locked
  loop
    -- fence 掉旧 attempt：revision 前进 + sealed，让它此后的任何写入都失败。
    update public.analysis_agent_run
    set status = 'FAILED',
        error_code = 'WORKER_LOST',
        -- 把观测到的两个陈旧时长写进 message：事后复盘要能区分"进程真的没了"
        -- 和"只是某一条心跳链路卡住"。
        error_message = format(
          'Worker heartbeat expired; task requeued for takeover (worker %s last seen %s ago, task heartbeat %s ago)',
          v_task.worker_id,
          coalesce((now() - v_task.worker_last_seen_at)::text, 'never'),
          coalesce((now() - v_task.heartbeat_at)::text, 'never')
        ),
        cancel_requested_at = coalesce(cancel_requested_at, now()),
        cancel_reason = coalesce(cancel_reason, 'WORKER_LOST'),
        sealed_at = coalesce(sealed_at, now()),
        session_revision = session_revision + 1,
        finished_at = now()
    where task_id = v_task.id
      and agent_attempt = v_task.agent_attempt
      and status = 'RUNNING';

    update public.analysis_agent_node node
    set status = 'CANCELLED',
        cancelled_at = coalesce(node.cancelled_at, now()),
        finished_at = coalesce(node.finished_at, now())
    where node.status = 'RUNNING'
      and node.agent_run_id in (
        select run.id from public.analysis_agent_run run
        where run.task_id = v_task.id and run.agent_attempt = v_task.agent_attempt
      );

    update public.analysis_story_task
    set agent_status = 'PENDING',
        worker_id = null,
        lease_expires_at = null,
        heartbeat_at = null,
        claim_token_digest = null,
        error_code = null,
        error_message = null,
        finished_at = null
    where id = v_task.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- 签名未变，但重新声明授权，保证这份迁移单独应用到任何环境都得到一致的权限面。
revoke execute on function public.reclaim_stale_story_task_leases()
  from public, anon, authenticated;
grant execute on function public.reclaim_stale_story_task_leases()
  to service_role;

commit;
