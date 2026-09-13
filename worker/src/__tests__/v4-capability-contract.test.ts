/**
 * WP0 契约冻结测试。
 *
 * 这些测试的作用是：任何工具增加、删除或 schema 变化都必须显式改契约文件，否则失败。
 * 它们同时把"全能力默认开启"和"root-only submit"钉在契约层，而不是只钉在实现里。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  AGENT_ROLES,
  applyEmergencyBreakers,
  assertResolvedInventory,
  brokerCapabilitiesForRole,
  brokerRouteCapability,
  CapabilityContractError,
  contractHash,
  isMutatingTool,
  isParallelSafeTool,
  loadCapabilityContract,
  normalizeCapabilityPolicy,
  policyHash,
  resolveContractPath,
  resolveToolsForRole,
  stableStringify,
  SUBMIT_TOOL_NAME,
  V4_DEFAULT_POLICY,
  V4_POLICY_VERSION,
  type AgentRole,
} from '../ai/policy/v4-capability-policy.js'
import { V4_ERROR_CODES } from '../ai/policy/v4-errors.js'
import { resolveAttemptPolicy } from '../ai/runtime/factory.js'
import type { StoryTask } from '../db/jobs.js'

/** dsh-base bundle 里实际存在的行 id，用来证明契约没有引用不存在的 plugin。 */
function baseBundleRowIds(): Set<string> {
  const ids = new Set<string>()
  for (const bundle of ['dsh-base', 'dsh-acp-app']) {
    const raw = readFileSync(
      new URL(`../../../node_modules/@deepseek-ai/${bundle}/cordis.patch.yml`, import.meta.url),
      'utf8',
    )
    for (const match of raw.matchAll(/^\s*-?\s*id:\s*([A-Za-z0-9._-]+)\s*$/gm)) {
      ids.add(match[1]!)
    }
  }
  return ids
}

describe('v4 capability contract', () => {
  const contract = loadCapabilityContract()

  it('locates and parses the checked-in manifest', () => {
    expect(resolveContractPath()).toMatch(/v4-capability-contract\.json$/)
    expect(contract.manifestRevision).toBe(1)
    expect(contract.contractVersion).toBe(V4_POLICY_VERSION)
    expect(contract.harnessVersion).toBe('0.1.5-rc.1')
    expect(V4_DEFAULT_POLICY).toEqual(contract.defaultPolicy)
    expect(Object.isFrozen(V4_DEFAULT_POLICY)).toBe(true)
  })

  it('pins the Harness version to the installed dependency', () => {
    // 契约冻结 Harness 版本：升级依赖但不改契约必须失败。
    const pkg = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string> }
    expect(pkg.dependencies['@deepseek-ai/dsh']).toBe(contract.harnessVersion)
    // 精确版本，不是 range：^/~ 会让"同一个 profile hash"失去意义。
    expect(pkg.dependencies['@deepseek-ai/dsh']).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/)
  })

  it('references only plugin rows that exist in the shipped bundles', () => {
    const shipped = baseBundleRowIds()
    const missing = [...contract.enabledPlugins, ...contract.disabledPlugins].filter(
      (id) => !shipped.has(id),
    )
    expect(missing).toEqual([])
  })

  it('enables every V4 default capability group', () => {
    // 本方案第 3.1 节：这些行必须处于启用状态，否则"全能力"不成立。
    for (const id of [
      'agent-instructions',
      'skill',
      'tool-skill',
      'goal',
      'tool-goal',
      'plan-mode',
      'tool-todo',
      'tool-ralph',
      'subagent-spawn-in-process',
      'subagent-fork-in-process',
      'tool-subagent',
      'tool-subagent-fork',
      'tool-subagent-control',
      'tool-subagent-list-agents',
      'workflow-worker-thread',
      'tool-workflow',
      'tool-jobs',
      'tool-bash',
      'tool-fs',
      'tool-fs-search',
      'token-meter',
      'compaction-basic',
      'tool-result-pruner',
      'session-checkpoint-policy',
      'session-persistence-jsonl',
      'spill-local',
      'spill-policy',
      'repeat-tool-reminder',
    ]) {
      expect(contract.enabledPlugins, `${id} must be enabled in V4`).toContain(id)
    }
  })

  it('keeps the non-capability items disabled', () => {
    // 第 1.4 节：重复 adapter、外部 telemetry、OS 不兼容项、被平台替换掉的出口。
    for (const id of [
      'llm-deepseek',
      'session-telemetry-otel',
      'web-search-deepseek',
      'web-fetch-http',
      'tool-pwsh',
      'pwsh-sandbox',
    ]) {
      expect(contract.disabledPlugins, `${id} must stay disabled`).toContain(id)
    }
  })

  it('replaces the in-process web tools with the platform gateway', () => {
    // Web 能力仍然默认开启：模型看到的工具名不变，只是出口换成平台代发。
    expect(contract.disabledPlugins).toContain('tool-web')
    expect(contract.platformPlugins).toContain('platform-web')
    expect(Object.keys(contract.modelTools)).toContain('web_search')
    expect(Object.keys(contract.modelTools)).toContain('web_fetch')
    expect(contract.roleTools['root-reviewer']).toContain('web_fetch')
    expect(contract.brokerRoutes['/attempt/web-egress']?.capability).toBe('webEgress')
  })

  it('exposes the exact V4 error code set', () => {
    expect([...contract.errorCodes].sort()).toEqual(Object.keys(V4_ERROR_CODES).sort())
  })

  it('produces a stable contract hash', () => {
    expect(contractHash(contract)).toMatch(/^[0-9a-f]{64}$/)
    expect(contractHash(contract)).toBe(contractHash(contract))
    // hash 覆盖工具面：改一个工具名就必须变。
    const mutated = {
      ...contract,
      modelTools: { ...contract.modelTools, brand_new_tool: contract.modelTools.grep! },
    }
    expect(contractHash(mutated)).not.toBe(contractHash(contract))
  })

  it('classifies every tool for parallel and mutation safety', () => {
    for (const [tool, entry] of Object.entries(contract.modelTools)) {
      expect(typeof entry.mutating, tool).toBe('boolean')
      expect(typeof entry.parallelSafe, tool).toBe('boolean')
      // mutation 与 parallelSafe 不能同时为真：并行 mutation 无法保证预算原子性。
      if (entry.mutating) expect(entry.parallelSafe, tool).toBe(false)
    }
    expect(isParallelSafeTool('read_snapshot_code')).toBe(true)
    expect(isMutatingTool(SUBMIT_TOOL_NAME)).toBe(true)
    expect(isParallelSafeTool(SUBMIT_TOOL_NAME)).toBe(false)
  })

  it('maps every broker route to a capability', () => {
    expect(brokerRouteCapability('/attempt/submit-review')).toEqual({
      capability: 'submitReview',
      mutating: true,
    })
    // 未知路由必须返回 null，让 Broker fail closed 而不是猜。
    expect(brokerRouteCapability('/attempt/anything-else')).toBeNull()
  })
})

describe('v4 role tool projection', () => {
  const policy = V4_DEFAULT_POLICY

  it('gives the root agent the full orchestration surface', () => {
    const tools = resolveToolsForRole({ role: 'root-reviewer', policy, delegationDepth: 0 })
    for (const tool of [
      SUBMIT_TOOL_NAME,
      'skill',
      'create_goal',
      'todo_write',
      'ralph',
      'subagent',
      'subagent_fork',
      'send_message',
      'interrupt_agent',
      'list_agents',
      'workflow',
      'job_list',
      'bash',
      'read',
      'write',
      'grep',
      'glob',
      'web_search',
      'web_fetch',
      'read_snapshot_code',
    ]) {
      expect(tools, tool).toContain(tool)
    }
  })

  it('never exposes submit_review_result to a child role', () => {
    for (const role of AGENT_ROLES.filter((r) => r !== 'root-reviewer')) {
      const tools = resolveToolsForRole({ role, policy, delegationDepth: 1 })
      expect(tools, role).not.toContain(SUBMIT_TOOL_NAME)
      expect(brokerCapabilitiesForRole({ role, policy, delegationDepth: 1 })).not.toContain(
        'submitReview',
      )
    }
  })

  it('narrows each child role to its declared surface', () => {
    const research = resolveToolsForRole({ role: 'research-child', policy, delegationDepth: 1 })
    expect(research).not.toContain('write')
    expect(research).not.toContain('bash')
    expect(research).toContain('web_search')

    const implementation = resolveToolsForRole({
      role: 'implementation-child',
      policy,
      delegationDepth: 1,
    })
    expect(implementation).toContain('write')
    expect(implementation).toContain('bash')
    // 实现型子 Agent 默认无 Web。
    expect(implementation).not.toContain('web_search')
    expect(implementation).not.toContain('web_fetch')

    const critic = resolveToolsForRole({ role: 'critic-child', policy, delegationDepth: 1 })
    expect(critic).not.toContain('write')
    expect(critic).not.toContain('todo_write')
    expect(critic).toContain('read_snapshot_code')
  })

  it('removes delegation tools once the depth limit is reached', () => {
    const atLimit = resolveToolsForRole({
      role: 'root-reviewer',
      policy: { ...policy, agents: { ...policy.agents, maxDelegationDepth: 1 } },
      delegationDepth: 1,
    })
    for (const tool of ['subagent', 'subagent_fork', 'workflow', 'ralph']) {
      expect(atLimit, tool).not.toContain(tool)
    }
    // 提交权不受深度影响。
    expect(atLimit).toContain(SUBMIT_TOOL_NAME)
  })

  it('removes write tools in a read-only sandbox', () => {
    const readOnly = resolveToolsForRole({
      role: 'implementation-child',
      policy: { ...policy, sandbox: { ...policy.sandbox, defaultMode: 'read-only' } },
      delegationDepth: 1,
    })
    for (const tool of ['write', 'edit', 'bash', 'job_list']) {
      expect(readOnly, tool).not.toContain(tool)
    }
    expect(readOnly).toContain('read')
  })

  it('rejects an unknown role', () => {
    expect(() =>
      resolveToolsForRole({ role: 'nope' as AgentRole, policy, delegationDepth: 0 }),
    ).toThrow(CapabilityContractError)
  })
})

describe('resolved inventory verification', () => {
  const policy = V4_DEFAULT_POLICY

  it('accepts the inventory the policy prescribes', () => {
    const resolved = resolveToolsForRole({ role: 'root-reviewer', policy, delegationDepth: 0 })
    expect(() =>
      assertResolvedInventory({ role: 'root-reviewer', resolved, policy, delegationDepth: 0 }),
    ).not.toThrow()
  })

  it('fails closed on a tool that is not in the contract', () => {
    const resolved = [
      ...resolveToolsForRole({ role: 'root-reviewer', policy, delegationDepth: 0 }),
      'harness_new_experimental_tool',
    ]
    expect(() =>
      assertResolvedInventory({ role: 'root-reviewer', resolved, policy }),
    ).toThrowError(/outside the V4 contract/)
  })

  it('fails closed when a child resolves the submit tool', () => {
    const resolved = [
      ...resolveToolsForRole({ role: 'research-child', policy, delegationDepth: 1 }),
      SUBMIT_TOOL_NAME,
    ]
    expect(() =>
      assertResolvedInventory({
        role: 'research-child',
        resolved,
        policy,
        delegationDepth: 1,
      }),
    ).toThrowError(/must not see/)
  })

  it('fails closed when a default capability tool disappeared', () => {
    const resolved = resolveToolsForRole({
      role: 'root-reviewer',
      policy,
      delegationDepth: 0,
    }).filter((tool) => tool !== 'workflow')
    expect(() =>
      assertResolvedInventory({ role: 'root-reviewer', resolved, policy, delegationDepth: 0 }),
    ).toThrowError(/missing V4 default tools/)
  })
})

describe('policy normalization', () => {
  it('defaults every capability to enabled', () => {
    const policy = normalizeCapabilityPolicy(undefined)
    for (const [key, value] of Object.entries(policy.capabilities)) {
      expect(value, key).toBe(true)
    }
    expect(policy.version).toBe(V4_POLICY_VERSION)
  })

  it('refuses danger-full-access and out-of-process providers', () => {
    const policy = normalizeCapabilityPolicy({
      sandbox: { defaultMode: 'danger-full-access', dangerFullAccess: true },
      agents: { allowOutOfProcessProviders: true },
      parallelTools: { mutationToolsSerial: false },
    })
    expect(policy.sandbox.dangerFullAccess).toBe(false)
    expect(policy.sandbox.defaultMode).toBe('workspace-write')
    expect(policy.agents.allowOutOfProcessProviders).toBe(false)
    expect(policy.parallelTools.mutationToolsSerial).toBe(true)
  })

  it('clamps per-kind budgets to the total hard cap', () => {
    const policy = normalizeCapabilityPolicy({
      modelBudget: {
        maxTotalRequests: 10,
        maxRootRequests: 500,
        maxChildRequests: 500,
        maxRetryRequests: 500,
        maxCompactionRequests: 500,
      },
    })
    expect(policy.modelBudget.maxTotalRequests).toBe(10)
    expect(policy.modelBudget.maxRootRequests).toBe(10)
    expect(policy.modelBudget.maxChildRequests).toBe(10)
    expect(policy.modelBudget.maxRetryRequests).toBe(10)
  })

  it('normalizes the web allowlist', () => {
    const policy = normalizeCapabilityPolicy({
      web: {
        allowedDomains: ['  Docs.Example.COM ', 'evil.example/path', 'é.example', '', 'a b', 'docs.example.com'],
        allowedPorts: [443, 8443, 70000, 'x'],
      },
    })
    expect(policy.web.allowedDomains).toEqual(['docs.example.com'])
    expect(policy.web.allowedPorts).toEqual([443, 8443])
  })

  it('ignores out-of-range numbers instead of trusting them', () => {
    const policy = normalizeCapabilityPolicy({
      agents: { maxDelegationDepth: 99, maxAgentsPerAttempt: 0 },
      sandbox: { commandTimeoutMs: 1 },
    })
    expect(policy.agents.maxDelegationDepth).toBe(V4_DEFAULT_POLICY.agents.maxDelegationDepth)
    expect(policy.agents.maxAgentsPerAttempt).toBe(V4_DEFAULT_POLICY.agents.maxAgentsPerAttempt)
    expect(policy.sandbox.commandTimeoutMs).toBe(V4_DEFAULT_POLICY.sandbox.commandTimeoutMs)
  })

  it('hashes policies independently of key order', () => {
    const a = normalizeCapabilityPolicy({})
    const b = normalizeCapabilityPolicy({})
    expect(policyHash(a)).toBe(policyHash(b))
    expect(policyHash({ ...a, agents: { ...a.agents, maxAgentsPerAttempt: 3 } })).not.toBe(
      policyHash(a),
    )
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
  })
})

describe('emergency breakers', () => {
  it('leaves the policy untouched with no breaker set', () => {
    const { policy, breakers } = applyEmergencyBreakers(V4_DEFAULT_POLICY, {})
    expect(breakers).toEqual([])
    expect(policy.capabilities).toEqual(V4_DEFAULT_POLICY.capabilities)
  })

  it('closes web, shell-write, subagents and workflow on demand', () => {
    const { policy, breakers } = applyEmergencyBreakers(V4_DEFAULT_POLICY, {
      V4_BREAKER_DISABLE_WEB: '1',
      V4_BREAKER_DISABLE_SHELL_WRITE: 'yes',
      V4_BREAKER_DISABLE_SUBAGENTS: 'true',
      V4_BREAKER_DISABLE_WORKFLOW: 'on',
    })
    expect(breakers.sort()).toEqual(['shell-write', 'subagents', 'web', 'workflow'])
    expect(policy.capabilities.webSearch).toBe(false)
    expect(policy.capabilities.shell).toBe(false)
    expect(policy.sandbox.defaultMode).toBe('read-only')
    expect(policy.agents.maxDelegationDepth).toBe(0)
    expect(policy.capabilities.workflow).toBe(false)
    // 熔断后 root 仍然保留提交权：熔断不能让 attempt 变成无法收敛。
    expect(resolveToolsForRole({ role: 'root-reviewer', policy, delegationDepth: 0 })).toContain(
      SUBMIT_TOOL_NAME,
    )
  })

  it('treats 0 and false as "not set"', () => {
    const { breakers } = applyEmergencyBreakers(V4_DEFAULT_POLICY, {
      V4_BREAKER_DISABLE_WEB: '0',
      V4_BREAKER_DISABLE_WORKFLOW: 'false',
    })
    expect(breakers).toEqual([])
  })

  it('keeps the frozen policy hash stable when a breaker narrows the effective policy', () => {
    const task = {
      capability_policy: V4_DEFAULT_POLICY,
      model: {},
    } as unknown as StoryTask
    const resolved = resolveAttemptPolicy(task, { V4_BREAKER_DISABLE_WEB: '1' })

    expect(resolved.breakers).toEqual(['web'])
    expect(resolved.policy.capabilities.webSearch).toBe(false)
    expect(resolved.frozenPolicyHash).toBe(policyHash(V4_DEFAULT_POLICY))
    expect(policyHash(resolved.policy)).not.toBe(resolved.frozenPolicyHash)
  })
})
