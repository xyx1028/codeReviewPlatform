/**
 * V1.23 产品代码问答：只读能力策略与提示词。
 *
 * 这份测试盯住的是那些"漏了不会报错、只会静静变危险或变没用"的点：
 *   - 工具面里混进任何写工具（漏了之后问答照样工作，只是模型多了一把能改代码的工具）；
 *   - `permittedTools` 忘记显式传（默认值是评审提交工具）；
 *   - 提示词丢掉"没读到就说没读到"那条规则（模型会用常识补全，产品照此写验收标准）；
 *   - 证据里的文件路径写成绝对路径（暴露容器布局，且产品拿着它找不到文件）。
 */

import { describe, expect, it } from 'vitest'

import {
  assertCodeQaToolsReadOnly,
  buildCodeQaPolicy,
  CODE_QA_AGENT_ROLE,
  CODE_QA_ALLOWED_AGENT_LOCAL_MUTATIONS,
  CODE_QA_DENIED_TOOLS,
  CODE_QA_PERMITTED_TOOLS,
  resolveCodeQaTools,
} from '../ai/code-qa/qa-policy.js'
import {
  buildCodeQaPrompt,
  buildCodeQaSystemPrompt,
  buildCodeQaUserPrompt,
  collectReadFiles,
  normalizeSnapshotPath,
  type CodeQaPromptContext,
} from '../ai/code-qa/qa-prompt.js'
import { isMutatingTool, V4_DEFAULT_POLICY } from '../ai/policy/v4-capability-policy.js'

const context: CodeQaPromptContext = {
  repository: 'kdmanage-backend',
  branch: 'release',
  commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  skillNames: ['kdmanage-backend-engineering'],
  workspaceHint: 'code/kdmanage-backend',
}

describe('buildCodeQaPolicy', () => {
  const policy = buildCodeQaPolicy()

  it('沙箱是只读的，且不允许 full access', () => {
    expect(policy.sandbox.defaultMode).toBe('read-only')
    expect(policy.sandbox.dangerFullAccess).toBe(false)
  })

  it('关掉会开枝散叶的能力：子 Agent / workflow / jobs / ralph', () => {
    expect(policy.capabilities.subagentSpawn).toBe(false)
    expect(policy.capabilities.subagentFork).toBe(false)
    expect(policy.capabilities.subagentControl).toBe(false)
    expect(policy.capabilities.workflow).toBe(false)
    expect(policy.capabilities.jobs).toBe(false)
    expect(policy.capabilities.ralph).toBe(false)
    expect(policy.agents.maxAgentsPerAttempt).toBe(1)
    expect(policy.agents.maxDelegationDepth).toBe(0)
  })

  it('关掉出网，并且把出网预算一起归零（不留自相矛盾的策略）', () => {
    expect(policy.capabilities.webSearch).toBe(false)
    expect(policy.capabilities.webFetch).toBe(false)
    expect(policy.web.maxRequestsPerAttempt).toBe(0)
    expect(policy.web.maxTotalBytes).toBe(0)
    expect(policy.web.allowedDomains).toEqual([])
  })

  it('保留问答真正要用的能力：技能、文件读、会话续跑、自动压缩', () => {
    expect(policy.capabilities.skills).toBe(true)
    expect(policy.capabilities.filesystem).toBe(true)
    expect(policy.capabilities.sessionPersistence).toBe(true)
    expect(policy.capabilities.sessionResume).toBe(true)
    expect(policy.capabilities.autoCompaction).toBe(true)
  })

  it('不修改传入的基础策略（纯函数）', () => {
    const before = JSON.stringify(V4_DEFAULT_POLICY)
    buildCodeQaPolicy(V4_DEFAULT_POLICY)
    expect(JSON.stringify(V4_DEFAULT_POLICY)).toBe(before)
  })

  it('从只读角色出发，而不是从全能力角色收窄', () => {
    // root-reviewer 带 bash/write/edit/submit_review_result；从它出发漏一个就是一个写口子。
    expect(CODE_QA_AGENT_ROLE).toBe('research-child')
  })
})

describe('resolveCodeQaTools', () => {
  const tools = resolveCodeQaTools()

  it('给出代码检索所需的只读工具', () => {
    // 这四个是绑定在冻结 commit 上的只读快照工具，问答的主力。
    expect(tools).toContain('search_snapshot_code')
    expect(tools).toContain('read_snapshot_code')
    expect(tools).toContain('find_snapshot_files')
    // 通用只读文件工具。
    expect(tools).toContain('read')
    expect(tools).toContain('grep')
    expect(tools).toContain('glob')
    // 模块知识。
    expect(tools).toContain('skill')
  })

  it('不包含任何写工具或评审提交工具', () => {
    for (const forbidden of ['write', 'edit', 'bash', 'submit_review_result']) {
      expect(tools).not.toContain(forbidden)
    }
  })

  it('不包含委派工具（单个提问的成本必须可预期）', () => {
    for (const forbidden of ['subagent', 'subagent_fork', 'workflow', 'ralph']) {
      expect(tools).not.toContain(forbidden)
    }
  })

  it('不包含需要 review_story 的工具（问答没有故事，调用必然失败）', () => {
    expect(tools).not.toContain('list_story_commits')
    expect(tools).not.toContain('read_story_commit_diff')
    for (const denied of CODE_QA_DENIED_TOOLS) {
      expect(tools).not.toContain(denied)
    }
  })

  it('除了 Agent 自己的待办清单，没有任何 mutating 工具', () => {
    // todo_write 被契约标成 mutating，但它改的是 Agent 自己的内存状态 ——
    // 碰不到快照、数据库或任何平台记录。例外必须逐项列举，见 qa-policy.ts 的说明。
    const mutating = tools.filter((tool) => isMutatingTool(tool))
    expect(mutating).toEqual(['todo_write'])
    expect(CODE_QA_ALLOWED_AGENT_LOCAL_MUTATIONS).toEqual(['todo_write'])
  })

  it('没有任何能改代码、改仓库或改平台记录的工具', () => {
    const agentLocal = new Set(CODE_QA_ALLOWED_AGENT_LOCAL_MUTATIONS)
    expect(tools.filter((tool) => isMutatingTool(tool) && !agentLocal.has(tool))).toEqual([])
  })

  it('工具面非空（收窄不能收成什么都不剩）', () => {
    expect(tools.length).toBeGreaterThan(3)
  })
})

describe('assertCodeQaToolsReadOnly', () => {
  it('真实工具面通过', () => {
    expect(() => assertCodeQaToolsReadOnly(resolveCodeQaTools())).not.toThrow()
  })

  it('混进写工具时 fail closed', () => {
    expect(() => assertCodeQaToolsReadOnly(['read', 'write'])).toThrow(
      /read-only|CODE_QA_TOOL_SURFACE_NOT_READ_ONLY/,
    )
  })

  it('混进评审提交工具时 fail closed', () => {
    expect(() => assertCodeQaToolsReadOnly(['read', 'submit_review_result'])).toThrow()
  })
})

describe('CODE_QA_PERMITTED_TOOLS', () => {
  it('是空数组 —— 必须显式传，否则 acp-client 默认会批准评审提交工具', () => {
    expect(CODE_QA_PERMITTED_TOOLS).toEqual([])
    expect(CODE_QA_PERMITTED_TOOLS).not.toContain('submit_review_result')
  })
})

describe('buildCodeQaSystemPrompt', () => {
  const system = buildCodeQaSystemPrompt(context)

  it('写清仓库、分支与代码版本', () => {
    expect(system).toContain('kdmanage-backend')
    expect(system).toContain('release')
    expect(system).toContain('a1b2c3d4')
  })

  it('只显示短 SHA，不把全长 SHA 灌进提示词', () => {
    expect(system).not.toContain(context.commitSha)
  })

  it('明确禁止用通用常识补全没读到的逻辑', () => {
    expect(system).toMatch(/没找到|没读到/)
    expect(system).toContain('通用工程常识')
  })

  it('要求给出文件路径供核对', () => {
    expect(system).toContain('文件路径')
  })

  it('说明提问者是产品经理而不是开发', () => {
    expect(system).toContain('产品经理')
    expect(system).toContain('不是开发')
  })

  it('披露挂载的技能名并说明要自己调 skill() 读正文', () => {
    expect(system).toContain('kdmanage-backend-engineering')
    expect(system).toContain('skill(')
  })

  it('没有技能时不写技能那一段', () => {
    const without = buildCodeQaSystemPrompt({ ...context, skillNames: [] })
    expect(without).not.toContain('可用的模块知识')
  })

  it('不要求 JSON 输出（回答是给人看的）', () => {
    expect(system).toContain('不要用 JSON')
  })
})

describe('buildCodeQaUserPrompt', () => {
  it('新会话只带问题本身', () => {
    const user = buildCodeQaUserPrompt({ question: '  转派怎么做的  ', context, resumed: false })
    expect(user).toBe('转派怎么做的')
  })

  it('续跑时重申代码版本，防止模型对"在看哪一版"的记忆漂移', () => {
    const user = buildCodeQaUserPrompt({ question: '那退回呢', context, resumed: true })
    expect(user).toContain('a1b2c3d4')
    expect(user).toContain('release')
    expect(user.trimEnd().endsWith('那退回呢')).toBe(true)
  })
})

describe('buildCodeQaPrompt', () => {
  it('同时给出 system 与 user', () => {
    const prompt = buildCodeQaPrompt({ question: '问题', context, resumed: false })
    expect(prompt.system.length).toBeGreaterThan(100)
    expect(prompt.user).toBe('问题')
  })
})

describe('normalizeSnapshotPath', () => {
  /*
   * 这一组用例来自一次真实的本地端到端运行（2026-09-24）。
   *
   * 真实快照根是 `/workspace/cache/<repo>/<sha>/`，而旧实现靠在路径里找
   * `workspace|snapshot|code` 标记猜根，于是 `pom.xml` 被记成
   * `cache/kdmanage-backend/e63ae4f…/pom.xml` —— 产品拿着那条路径在 GitLab 上找不到文件。
   * 精确前缀不需要猜。
   */
  const REAL_ROOT = '/workspace/cache/kdmanage-backend/' + 'e'.repeat(40)

  it('给了快照根就用精确前缀（真实布局）', () => {
    expect(normalizeSnapshotPath(`${REAL_ROOT}/pom.xml`, REAL_ROOT)).toBe('pom.xml')
    expect(
      normalizeSnapshotPath(
        `${REAL_ROOT}/kdmanage-backend/src/main/java/App.java`,
        REAL_ROOT,
      ),
    ).toBe('kdmanage-backend/src/main/java/App.java')
  })

  it('根带尾斜杠也能正确剥掉', () => {
    expect(normalizeSnapshotPath(`${REAL_ROOT}/pom.xml`, `${REAL_ROOT}/`)).toBe('pom.xml')
  })

  it('绝对路径不在快照里时丢弃（模型在探测容器，不该记成读过代码）', () => {
    expect(normalizeSnapshotPath('/etc/passwd', REAL_ROOT)).toBeNull()
    expect(normalizeSnapshotPath('/workspace/agent-sessions/x.jsonl', REAL_ROOT)).toBeNull()
  })

  it('刚好等于快照根本身时丢弃（那不是一个文件）', () => {
    expect(normalizeSnapshotPath(`${REAL_ROOT}/`, REAL_ROOT)).toBeNull()
  })

  it('相对路径原样保留', () => {
    expect(normalizeSnapshotPath('src/task/Transfer.java')).toBe('src/task/Transfer.java')
    expect(normalizeSnapshotPath('src/task/Transfer.java', REAL_ROOT)).toBe(
      'src/task/Transfer.java',
    )
  })

  it('去掉 ./ 前缀', () => {
    expect(normalizeSnapshotPath('./src/a.java')).toBe('src/a.java')
  })

  it('没传快照根时退化到标记匹配（取最后一个根标记）', () => {
    expect(normalizeSnapshotPath('/workspace/code/src/a.java')).toBe('src/a.java')
    expect(normalizeSnapshotPath('/data/attempts/x/snapshot/src/b.java')).toBe('src/b.java')
  })

  it('没传根且认不出标记的绝对路径一律丢弃，不猜', () => {
    // 猜错的代价是产品拿着一条不存在的路径去问开发。
    expect(normalizeSnapshotPath('/etc/passwd')).toBeNull()
    expect(normalizeSnapshotPath('/home/kingdee/secret.txt')).toBeNull()
  })

  it('逃出快照的相对路径丢弃', () => {
    expect(normalizeSnapshotPath('../../etc/passwd')).toBeNull()
  })

  it('空白丢弃', () => {
    expect(normalizeSnapshotPath('   ')).toBeNull()
  })
})

describe('collectReadFiles', () => {
  it('只收读类工具的路径参数，去重并排序', () => {
    const files = collectReadFiles([
      { toolName: 'read', arguments: { path: 'src/b.java' } },
      { toolName: 'read_snapshot_code', arguments: { file_path: 'src/a.java' } },
      { toolName: 'read', arguments: { path: 'src/b.java' } },
      // 检索类工具不算"读过文件"：它只告诉模型哪里有匹配。
      { toolName: 'search_snapshot_code', arguments: { path: 'src/never-read.java' } },
    ])
    expect(files).toEqual(['src/a.java', 'src/b.java'])
  })

  it('没有参数时不炸', () => {
    expect(collectReadFiles([{ toolName: 'read' }])).toEqual([])
  })

  it('按真实快照根归一（端到端实测形态）', () => {
    const root = '/workspace/cache/kdmanage-backend/' + 'e'.repeat(40)
    const files = collectReadFiles(
      [
        { toolName: 'read', arguments: { path: `${root}/pom.xml` } },
        { toolName: 'read', arguments: { path: '/etc/shadow' } },
      ],
      { workspaceRoot: root },
    )
    expect(files).toEqual(['pom.xml'])
  })

  it('没传根时退化匹配仍然丢掉认不出的绝对路径', () => {
    const files = collectReadFiles([
      { toolName: 'read', arguments: { path: '/workspace/code/src/ok.java' } },
      { toolName: 'read', arguments: { path: '/etc/shadow' } },
    ])
    expect(files).toEqual(['src/ok.java'])
  })

  it('空输入返回空数组', () => {
    expect(collectReadFiles([])).toEqual([])
  })
})
