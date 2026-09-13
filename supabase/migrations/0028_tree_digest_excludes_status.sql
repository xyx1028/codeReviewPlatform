-- 0028: tree_digest 不再包含节点状态
--
-- 问题
-- ====
-- `analysis_agent_tree_digest` 与 Worker 侧的 `AgentAuthorityLedger.treeDigest()` 都把
-- `status` 计入摘要。摘要的用途是证明"Worker 提交时看到的 Agent Tree 就是数据库里注册过的
-- 那棵树"——即没有未注册的 Agent 参与过。`status` 对这个结论没有贡献，却引入了一个真实的
-- 误拒面：
--
--   1. 子 Agent 结束时 Worker 会调 `/attempt/finish-agent`。这次上报失败（数据库抖动、
--      连接超时）时，本地账本已把节点标成 FINISHED，而数据库里仍是 RUNNING；
--   2. 随后根 Agent 提交，Worker 用 FINISHED 算摘要、数据库用 RUNNING 算摘要；
--   3. 两者必然不等 → `save_agent_review_result` 抛 AGENT_IDENTITY_INVALID。
--
-- 于是一次**完全合法**的提交被拒，而且是在模型费用已经全部花完之后被拒。同一个窗口在
-- "子 Agent 恰好与提交并发结束"时也会命中，与上报是否失败无关。
--
-- 实测证据：同一棵树（root + 一个子 Agent），子 Agent 由 RUNNING 变为 FINISHED 时
-- Worker 侧摘要从 8a7381d4… 变为 8af71c68…。
--
-- 修复
-- ====
-- 摘要只覆盖**身份与血缘**：agent_id、父 agent_id、role、provider、delegation_depth、
-- tool_policy_hash。未注册的 Agent、被改过父节点的 Agent、角色或工具策略不符的 Agent 仍然
-- 会让摘要不匹配，安全性质不变；可变的运行状态不再参与。
--
-- 节点状态本身仍然逐节点持久化在 `analysis_agent_node.status`，可追溯性没有损失。
--
-- 这是一次 expand-only 的函数替换：不改表、不改列、不动数据。

create or replace function public.analysis_agent_tree_digest(p_agent_run_id uuid)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select encode(
    sha256(convert_to(coalesce(string_agg(row_value, E'\n' order by row_value collate "C"), ''), 'UTF8')),
    'hex'
  )
  from (
    -- 字段顺序必须与 AgentAuthorityLedger.treeDigest() 完全一致，包括分隔符与排序规则：
    -- 两侧算出不同的字符串就等于把合法提交全部拒掉。
    select concat_ws(
      '|', node.agent_id, coalesce(parent.agent_id, '-'), node.agent_role, node.provider,
      node.delegation_depth::text, node.tool_policy_hash
    ) as row_value
    from public.analysis_agent_node node
    left join public.analysis_agent_node parent on parent.id = node.parent_agent_node_id
    where node.agent_run_id = p_agent_run_id
  ) rows;
$$;

comment on function public.analysis_agent_tree_digest(uuid) is
  '身份与血缘的摘要，刻意不含节点状态：状态是可变的，把它计入会让 finish-agent 上报失败或'
  '子 Agent 与提交并发结束时，合法提交被 AGENT_IDENTITY_INVALID 误拒。';

-- 与 0027 一致：只有 service_role 可以调用。
revoke all on function public.analysis_agent_tree_digest(uuid) from public, anon, authenticated;
grant execute on function public.analysis_agent_tree_digest(uuid) to service_role;
