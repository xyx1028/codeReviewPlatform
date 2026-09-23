-- V1.11 的四个 Story 提交工具补进运行监控的工具名词表。
--
-- 缺口是本地全链路实测发现的（2026-09-23，本地 Job `e55681b7`）：723 条
-- `TOOL_CALL_COMPLETED` 里有 33 条**没有 `tool_name`**，监控台与诊断 CLI 显示成「—」。
--
-- 根因不在 Worker：`analysis_runtime_event_payload()` 重建 payload 时对 `tool_name` 做
-- 词表校验，不在 `analysis_runtime_known_tool_names()` 里的值**静默丢弃**（这是对的，
-- 防止任意文案透传）。而 V1.11 往 capability contract 里加了四个模型工具
--
--   list_story_commits / read_story_commit_diff /
--   submit_commit_relevance_verdict / expand_analysis_scope
--
-- 词表没跟着加，于是 V1.11 精准分析**最核心**的四个工具在监控里全部无名，
-- `tool_calls_by_name` 也把它们计成 `unknown`。
--
-- 同时 `analysis_runtime_platform_tool_names()` 还停在 5 个平台工具，而这四个新工具同样
-- 经 Broker 执行（`platformToolByRoute` 里有它们）。不补的话「慢是平台侧还是 Harness 侧」
-- 这个判断会把它们算到 Harness 侧。
--
-- 两个函数都是 immutable 纯函数，只增不改语义，重复应用安全。

create or replace function public.analysis_runtime_known_tool_names()
returns text[]
language sql
immutable
as $$
select array[
  -- 模型工具（与 worker/harness/code-review-acp/v4-capability-contract.json 的
  -- modelTools 键集合逐字一致，共 34 个）
  'search_snapshot_code', 'find_snapshot_files', 'read_snapshot_code',
  'list_snapshot_commits',
  'list_story_commits', 'read_story_commit_diff',
  'submit_commit_relevance_verdict', 'expand_analysis_scope',
  'submit_review_result', 'skill', 'todo_write',
  'create_goal', 'update_goal', 'get_goal', 'ralph', 'subagent', 'subagent_fork',
  'send_message', 'interrupt_agent', 'list_agents', 'workflow', 'job_list',
  'job_output', 'job_kill', 'bash', 'read', 'read_image', 'write', 'edit',
  'grep', 'glob', 'web_search', 'web_fetch', 'exit_plan_mode',
  -- Broker 路由名（`/attempt/<name>`）：审计与被拒路径按路由名上报
  'search-code', 'find-files', 'read-code', 'list-commits', 'snapshot-pins',
  'list-story-commits', 'read-story-commit-diff', 'submit-commit-relevance',
  'expand-analysis-scope', 'story-scope',
  'register-agent', 'finish-agent', 'report-usage', 'reserve-model-request',
  'web-egress', 'save-artifact', 'tool-audit', 'submit-review'
]::text[];
$$;

-- 平台 origin 工具：经 Broker 执行（读冻结快照 / 读冻结提交 / 写裁定 / 提交结论）。
-- 与 Broker 的 `platformToolByRoute` 值集合、以及 worker 侧 `PLATFORM_TOOL_NAMES` 逐字一致。
create or replace function public.analysis_runtime_platform_tool_names()
returns text[]
language sql
immutable
as $$
select array[
  'search_snapshot_code', 'find_snapshot_files', 'read_snapshot_code',
  'list_snapshot_commits',
  'list_story_commits', 'read_story_commit_diff',
  'submit_commit_relevance_verdict', 'expand_analysis_scope',
  'submit_review_result'
]::text[];
$$;
