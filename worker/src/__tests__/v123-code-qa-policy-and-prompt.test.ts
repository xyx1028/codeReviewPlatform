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

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

const context: CodeQaPromptContext = {
  repositories: [{ name: 'kdmanage-backend', commitSha: SHA }],
  branch: 'release',
  skillNames: ['kdmanage-backend-engineering'],
  multiRepoWorkspace: false,
}

/** 跨仓库会话的上下文（V1.23d）。 */
const multiContext: CodeQaPromptContext = {
  repositories: [
    { name: 'kdmanage-backend', commitSha: SHA },
    { name: 'kdmanage-frontend', commitSha: 'f'.repeat(40) },
  ],
  branch: 'release',
  skillNames: [],
  multiRepoWorkspace: true,
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
    expect(system).not.toContain(SHA)
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

  /*
   * 以下两组来自线上第一版的真实缺陷（2026-09-24）：
   * `prompt.system` 构造了却从未注入，模型没收到任何规则，于是用英文回答、
   * 罗列自己能做什么、不给文件路径。注入修好之后，这些要求必须真的出现在正文里。
   */
  it('把「用简体中文」写在最前面，而不是埋在末尾', () => {
    expect(system).toContain('简体中文')
    // 第一个小标题之内就必须出现，否则模型会顺着英文代码上下文回英文。
    const head = system.slice(0, 200)
    expect(head).toContain('简体中文')
  })

  it('中文要求出现不止一次（首尾各一次）', () => {
    const hits = system.split('简体中文').length - 1
    expect(hits).toBeGreaterThanOrEqual(2)
  })

  it('明确说明标识符保持原文，避免把类名也翻译了', () => {
    expect(system).toContain('标识符保持原文')
  })

  it('明确告知 bash 不可用（否则模型会先试一次再报错）', () => {
    expect(system).toContain('bash')
    expect(system).toMatch(/不可用/)
  })

  it('禁止罗列自己能做什么（线上第一版正是这种回答）', () => {
    expect(system).toContain('不要罗列你能做什么')
  })
})

describe('buildCodeQaSystemPrompt：跨仓库会话（V1.23d）', () => {
  const system = buildCodeQaSystemPrompt(multiContext)

  it('列出全部仓库及各自的代码版本', () => {
    expect(system).toContain('kdmanage-backend')
    expect(system).toContain('kdmanage-frontend')
    expect(system).toContain('共 2 个')
    expect(system).toContain('a1b2c3d4')
    expect(system).toContain('ffffffff')
  })

  it('说明路径要带仓库名前缀（否则模型会用 pom.xml 这种路径读不到）', () => {
    expect(system).toContain('kdmanage-backend/pom.xml')
    expect(system).toContain('仓库名前缀')
  })

  it('提示跨仓库检索优先用按仓库名定位的快照工具', () => {
    expect(system).toContain('search_snapshot_code')
    expect(system).toContain('不受目录布局影响')
  })

  it('要求说清每段结论属于哪个仓库（产品要分别找对应开发）', () => {
    expect(system).toContain('属于哪个仓库')
  })

  it('单仓库时不出现跨仓库的那些话', () => {
    const single = buildCodeQaSystemPrompt(context)
    expect(single).not.toContain('跨仓库的会话')
    expect(single).toContain('当前目录就是这个仓库的根目录')
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

  /*
   * 以下两条来自跨仓库会话的真实运行（V1.23d）：`read_snapshot_code` 的 `path` 是
   * **仓库内**相对路径（它另有 `repository` 参数），而 `read` 的路径相对 cwd、多仓库时
   * 自带仓库名前缀。不补前缀时证据里会同时出现
   * `kdmanage-frontend/src/pages/X.tsx` 与 `src/pages/X.tsx` —— 既重复又歧义。
   */
  it('快照工具的路径补上仓库名前缀', () => {
    const files = collectReadFiles([
      {
        toolName: 'read_snapshot_code',
        arguments: { repository: 'kdmanage-frontend', path: 'src/pages/X.tsx' },
      },
    ])
    expect(files).toEqual(['kdmanage-frontend/src/pages/X.tsx'])
  })

  it('路径已经带仓库名时不重复加前缀', () => {
    const files = collectReadFiles([
      {
        toolName: 'read_snapshot_code',
        arguments: {
          repository: 'kdmanage-frontend',
          path: 'kdmanage-frontend/src/pages/X.tsx',
        },
      },
    ])
    expect(files).toEqual(['kdmanage-frontend/src/pages/X.tsx'])
  })

  it('同一个文件经两种工具读到时只留一条（补前缀后可去重）', () => {
    const root = '/workspace/cache/ws'
    const files = collectReadFiles(
      [
        { toolName: 'read', arguments: { path: `${root}/kdmanage-frontend/src/a.tsx` } },
        {
          toolName: 'read_snapshot_code',
          arguments: { repository: 'kdmanage-frontend', path: 'src/a.tsx' },
        },
      ],
      { workspaceRoot: root },
    )
    expect(files).toEqual(['kdmanage-frontend/src/a.tsx'])
  })

  it('没有 repository 参数时不硬造前缀', () => {
    expect(
      collectReadFiles([{ toolName: 'read', arguments: { path: 'src/a.java' } }]),
    ).toEqual(['src/a.java'])
  })
})
