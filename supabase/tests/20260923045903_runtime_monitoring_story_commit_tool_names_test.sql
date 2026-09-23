\set ON_ERROR_STOP on
\timing off

-- V1.11 四个 Story 提交工具进入运行监控词表后的行为断言。
-- 缺口来自本地全链路实测：词表缺名 → `analysis_runtime_event_payload()` 静默丢掉
-- `tool_name` → 监控台与诊断 CLI 显示「—」。

begin;
set local client_min_messages=warning;

create or replace function pg_temp.assert(p_condition boolean,p_message text)
returns void language plpgsql as $$
begin
  if p_condition is distinct from true then raise exception 'ASSERT FAILED: %',p_message; end if;
end;
$$;

do $test$
declare
  v_story_tools text[] := array['list_story_commits','read_story_commit_diff',
                                'submit_commit_relevance_verdict','expand_analysis_scope'];
  v_routes text[] := array['list-story-commits','read-story-commit-diff',
                           'submit-commit-relevance','expand-analysis-scope'];
  v_tool text;
begin
  ----------------------------------------------------------------------------
  -- 1. 四个模型工具与它们的 Broker 路由名都在已知词表里
  ----------------------------------------------------------------------------
  foreach v_tool in array v_story_tools loop
    perform pg_temp.assert(v_tool = any(public.analysis_runtime_known_tool_names()),
      format('known_tool_names 包含模型工具 %s', v_tool));
    perform pg_temp.assert(v_tool = any(public.analysis_runtime_platform_tool_names()),
      format('platform_tool_names 包含 %s（它经 Broker 执行）', v_tool));
  end loop;
  foreach v_tool in array v_routes loop
    perform pg_temp.assert(v_tool = any(public.analysis_runtime_known_tool_names()),
      format('known_tool_names 包含 Broker 路由名 %s', v_tool));
  end loop;

  ----------------------------------------------------------------------------
  -- 2. payload 重建后 tool_name 必须留下（这正是丢名的那一步）
  ----------------------------------------------------------------------------
  foreach v_tool in array v_story_tools loop
    perform pg_temp.assert(
      public.analysis_runtime_event_payload('TOOL_CALL_COMPLETED',
        jsonb_build_object('tool_name', v_tool, 'agent_role','root-reviewer','duration_ms',7))
        ->> 'tool_name' = v_tool,
      format('TOOL_CALL_COMPLETED 保留 tool_name=%s', v_tool));
    perform pg_temp.assert(
      public.analysis_runtime_event_payload('TOOL_CALL_STARTED',
        jsonb_build_object('tool_name', v_tool, 'agent_role','root-reviewer'))
        ->> 'tool_name' = v_tool,
      format('TOOL_CALL_STARTED 保留 tool_name=%s', v_tool));
  end loop;

  ----------------------------------------------------------------------------
  -- 3. 词表校验本身不能被放宽：任意文案仍必须被丢弃
  ----------------------------------------------------------------------------
  perform pg_temp.assert(
    public.analysis_runtime_event_payload('TOOL_CALL_COMPLETED',
      jsonb_build_object('tool_name','rm -rf /','agent_role','root-reviewer')) ? 'tool_name' = false,
    '不在词表里的任意文案仍被丢弃');
  perform pg_temp.assert(
    public.analysis_runtime_event_payload('TOOL_CALL_COMPLETED',
      jsonb_build_object('tool_name','unknown','agent_role','root-reviewer')) ? 'tool_name' = false,
    'unknown 不是工具名，仍被丢弃');

  ----------------------------------------------------------------------------
  -- 4. 旧的 30 个模型工具与 5 个平台工具一个都不能掉
  ----------------------------------------------------------------------------
  foreach v_tool in array array['search_snapshot_code','find_snapshot_files','read_snapshot_code',
                               'list_snapshot_commits','submit_review_result','skill','bash','grep',
                               'web_fetch','exit_plan_mode','tool-audit','submit-review'] loop
    perform pg_temp.assert(v_tool = any(public.analysis_runtime_known_tool_names()),
      format('既有词条 %s 未被新定义丢掉', v_tool));
  end loop;
  perform pg_temp.assert(
    cardinality(public.analysis_runtime_platform_tool_names()) = 9,
    'platform_tool_names 是 9 个（原 5 个 + V1.11 的 4 个）');

  raise notice 'V1.11 story commit tool name catalog test passed';
end;
$test$;

rollback;
