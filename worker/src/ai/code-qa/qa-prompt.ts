/**
 * 产品代码问答的提示词（V1.23）。
 *
 * 纯函数、无 I/O，因此可以单测。它要解决的不是"让模型说话好听"，而是三个会直接
 * 让答案变得没用（甚至有害）的具体问题：
 *
 *   1. **模型会用通用工程常识补全它没读到的代码。** 产品拿着这种答案去写需求，
 *      验收标准就会和真实实现脱节 —— 而那正是这个平台事后才发现的那类不一致。
 *      所以提示词要求：结论必须落到它真正读过的文件上，读不到就说读不到。
 *   2. **模型默认会用开发的语言回答。** 提问的人不熟悉工程细节，一段满是类名和
 *      设计模式的回答等于没回答。
 *   3. **多轮对话里模型会忘记自己在看哪一版代码。** 每一轮都把仓库、分支、commit
 *      重新写进提示词，而不是指望它记住第一轮说过的话。
 */

/** 首轮会话的系统提示词里声明的身份与硬规则。 */
export interface CodeQaPromptContext {
  /** 会话选中的仓库及各自冻结的 commit。至少一个。 */
  repositories: ReadonlyArray<{ name: string; commitSha: string }>
  branch: string
  /** 挂载的技能名（首轮只披露名字与描述，正文要模型自己调 skill()）。 */
  skillNames: readonly string[]
  /**
   * 多仓库时为 true：各仓库在 cwd 下按仓库名并列成子目录。
   *
   * 这件事必须告诉模型：否则它会以为 cwd 就是某个仓库的根，然后用
   * `read('pom.xml')` 这种路径去读，而真实路径是 `kdmanage-backend/pom.xml`。
   */
  multiRepoWorkspace: boolean
}

export interface CodeQaPrompt {
  /** `session/new` 时作为系统提示词注入。 */
  system: string
  /** `session/prompt` 的正文。 */
  user: string
}

/**
 * 系统提示词。
 *
 * 只在**新建**会话时用；续跑的会话已经有它了，重复注入会让同一段规则在上下文里堆叠。
 */
export function buildCodeQaSystemPrompt(context: CodeQaPromptContext): string {
  const lines: string[] = []

  /*
   * 语言要求放在**第一行**，而不是埋在"回答格式"那一节里。
   *
   * 实测（2026-09-24 线上）：被评审的代码、文件名、类名全是英文，模型会顺着上下文
   * 用英文回答，即使提示词末尾写了"用中文"。提问的人是中文产品经理，一段英文回答
   * 对他等于没有回答。所以这条要写在最前面，并且重复一次（§回答格式）。
   */
  lines.push('# 最重要的一条')
  lines.push('')
  lines.push(
    '**必须用简体中文回答。** 无论代码、文件名、注释是什么语言，你的回答正文一律用中文。'
      + '类名、方法名、文件路径这类标识符保持原文，但解释、结论、段落标题都用中文。',
  )
  lines.push('')

  lines.push('# 你在做什么')
  lines.push('')
  lines.push('你在回答产品经理关于真实代码库的问题。')
  lines.push('')
  lines.push('## 你正在看的代码')
  lines.push('')
  lines.push(`- 分支：${context.branch}`)
  if (context.repositories.length === 1) {
    const only = context.repositories[0]!
    lines.push(`- 仓库：${only.name}`)
    lines.push(`- 代码版本（commit）：${only.commitSha.slice(0, 8)}`)
    lines.push('')
    lines.push('当前目录就是这个仓库的根目录，`read` / `grep` / `glob` 的路径都相对它。')
  } else {
    lines.push(`- 仓库（共 ${context.repositories.length} 个）：`)
    for (const repo of context.repositories) {
      lines.push(`  - \`${repo.name}\`（代码版本 ${repo.commitSha.slice(0, 8)}）`)
    }
    lines.push('')
    lines.push(
      '**这是一个跨仓库的会话。** 当前目录下每个仓库各是一个子目录，名字就是上面的仓库名，'
        + '所以文件路径要带仓库名前缀，例如 `' + context.repositories[0]!.name + '/pom.xml`。',
    )
    lines.push(
      '`search_snapshot_code` / `find_snapshot_files` / `read_snapshot_code` 这些工具按'
        + '**仓库名**定位，不受目录布局影响，跨仓库检索优先用它们。',
    )
    lines.push(
      '回答涉及多个仓库时，**说清每一段结论属于哪个仓库** —— 产品要据此分别找对应的开发。',
    )
  }
  lines.push('')
  lines.push(
    '这些代码是**只读快照**，固定在上面那些 commit。你不能修改任何文件，也不需要修改。',
  )
  lines.push('`bash` 在这个环境里不可用，用文件与检索工具探索代码。')
  lines.push('')

  lines.push('## 提问的人是谁')
  lines.push('')
  lines.push(
    '是产品经理，不是开发。他熟悉业务流程和用户场景，但不熟悉代码结构、类名、框架和设计模式。',
  )
  lines.push('他问这些问题是为了把需求写得和现有实现对得上。')
  lines.push('')

  lines.push('## 硬规则')
  lines.push('')
  lines.push('1. **用简体中文回答。**（见开头）')
  lines.push(
    '2. **先查代码，再回答。** 用 `search_snapshot_code` / `find_snapshot_files` / `grep` / '
      + '`read` 等工具实际读过代码之后再下结论。不要凭函数名或文件名猜实现。',
  )
  lines.push(
    '3. **只讲你读到的东西。** 如果查完仍然找不到支撑某个结论的代码，就直接说'
      + '「这一点我在代码里没找到」，并说明你查了哪些地方。'
      + '**绝对不要**用通用工程常识、行业惯例或"一般来说"去补全你没读到的逻辑 —— '
      + '产品会拿这个答案去写验收标准，编出来的逻辑比不回答有害得多。',
  )
  lines.push(
    '4. **给出文件路径。** 每个关键结论后面附上支撑它的文件路径（必要时加行号），'
      + '让产品能拿着路径去找开发确认。',
  )
  lines.push(
    '5. **用业务语言解释。** 先说业务上发生了什么，再在需要时提到技术细节。'
      + '不要罗列类名和方法名当作回答，也不要解释设计模式。',
  )
  lines.push(
    '6. **区分"代码这么写"和"你的推测"。** 两者都可以说，但必须让读者一眼看出哪句是哪种。',
  )
  lines.push(
    '7. **不确定就说不确定。** 代码里有多条分支、有开关、有看起来是历史遗留的路径时，'
      + '如实说出来，而不是挑一条当成唯一答案。',
  )
  lines.push('')

  if (context.skillNames.length > 0) {
    lines.push('## 可用的模块知识')
    lines.push('')
    lines.push(
      `这个平台挂了 ${context.skillNames.length} 个模块技能：${context.skillNames.join('、')}。`,
    )
    lines.push(
      '它们写的是这些模块的业务背景与工程约定。判断某个技能和当前问题相关时，'
        + '用 `skill(<名字>)` 读它的正文，再结合代码回答 —— 它能解释代码本身看不出来的"为什么"。',
    )
    lines.push('')
  }

  lines.push('## 回答格式')
  lines.push('')
  lines.push('**用简体中文**写一段结构清晰的说明。开头一两句先给结论，然后展开。')
  lines.push('不要用 JSON，不要写前言和寒暄，不要复述问题，不要罗列你能做什么。')

  return lines.join('\n')
}

/**
 * 每一轮的用户提示词。
 *
 * 续跑的会话也要带上代码版本那一行：多轮之后模型对"我在看哪一版"的记忆会漂移，
 * 而它一旦漂了，后面所有引用的路径都可能来自它脑补的另一个版本。
 */
export function buildCodeQaUserPrompt(input: {
  question: string
  context: CodeQaPromptContext
  /** 是否续用既有会话。续跑时不重复注入身份与规则。 */
  resumed: boolean
}): string {
  const lines: string[] = []
  if (input.resumed) {
    const repos = input.context.repositories
      .map((repo) => `${repo.name}@${repo.commitSha.slice(0, 8)}`)
      .join('、')
    lines.push(`（仍然是 ${input.context.branch} 分支的同一版代码：${repos}。请用中文回答。）`)
    lines.push('')
  }
  lines.push(input.question.trim())
  return lines.join('\n')
}

export function buildCodeQaPrompt(input: {
  question: string
  context: CodeQaPromptContext
  resumed: boolean
}): CodeQaPrompt {
  return {
    system: buildCodeQaSystemPrompt(input.context),
    user: buildCodeQaUserPrompt(input),
  }
}

/**
 * 从 ACP 观测到的工具调用里提取"读过哪些文件"。
 *
 * 这份清单会作为证据回给产品，所以只收**快照内的相对路径**：绝对路径会暴露容器布局，
 * 而且对产品毫无意义 —— 他要的是能在 GitLab 上找到的那个路径。
 *
 * `workspaceRoot` 必须传真实的快照根（Agent 的 cwd）。早先这里靠在路径里找
 * `workspace|snapshot|code` 这类标记猜根，本地实测直接猜错：真实快照根是
 * `/workspace/cache/<repo>/<sha>/`，于是 `pom.xml` 被记成
 * `cache/kdmanage-backend/e63ae4f…/pom.xml`。产品拿着那条路径在 GitLab 上找不到文件。
 * 精确前缀不需要猜。
 */
export function collectReadFiles(
  toolCalls: readonly { toolName: string; arguments?: Record<string, unknown> }[],
  options: { workspaceRoot?: string } = {},
): string[] {
  const files = new Set<string>()
  for (const call of toolCalls) {
    if (!READ_TOOLS.has(call.toolName)) continue
    for (const key of PATH_ARGUMENT_KEYS) {
      const value = call.arguments?.[key]
      if (typeof value !== 'string') continue
      const normalized = normalizeSnapshotPath(value, options.workspaceRoot)
      if (normalized === null) continue
      /*
       * 快照工具（`read_snapshot_code`）的 `path` 是**仓库内**相对路径，它另有一个
       * `repository` 参数；而 `read` 的路径是相对 cwd 的，多仓库时本来就带仓库名前缀。
       *
       * 不补前缀的后果在多仓库会话里是实测过的：证据里同时出现
       * `kdmanage-frontend/src/pages/X.tsx`（来自 read）和 `src/pages/X.tsx`
       * （来自 read_snapshot_code），既重复又歧义 —— 产品看到后者不知道是哪个仓库的。
       */
      const repository = call.arguments?.repository
      const qualified =
        typeof repository === 'string' &&
        repository !== '' &&
        !normalized.startsWith(`${repository}/`)
          ? `${repository}/${normalized}`
          : normalized
      files.add(qualified)
    }
  }
  return [...files].sort()
}

const READ_TOOLS = new Set(['read', 'read_snapshot_code', 'read_image'])

/** 不同工具用的参数名不统一，全部试一遍比假设一个名字安全。 */
const PATH_ARGUMENT_KEYS = ['path', 'file_path', 'filePath', 'file'] as const

/**
 * 把工具参数里的路径归一成快照内相对路径；不合格的一律丢弃。
 *
 * 丢弃而不是"尽量修"：一条修错的路径比没有这条路径更糟 —— 产品会拿着它去问开发，
 * 而开发找不到那个文件。
 */
export function normalizeSnapshotPath(raw: string, workspaceRoot?: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null

  if (trimmed.startsWith('/')) {
    // 有快照根就用精确前缀，不猜。
    if (workspaceRoot !== undefined && workspaceRoot !== '') {
      const root = workspaceRoot.endsWith('/') ? workspaceRoot : `${workspaceRoot}/`
      if (trimmed.startsWith(root)) {
        const rest = trimmed.slice(root.length)
        return rest === '' ? null : rest
      }
      // 绝对路径但不在快照里：丢弃。模型可能在探测容器，不该把它记成"读过的代码"。
      return null
    }
    /*
     * 没传快照根时的退化路径（只有单测和历史调用会走到）。
     *
     * 取**最后**一个根标记之后的部分：`/workspace/code/src/a.java` 里 `workspace` 和
     * `code` 都是标记，而正确答案是 `src/a.java`。前导 `.*` 贪婪匹配保证吃到最后那个。
     */
    const marker = trimmed.match(/^.*\/(?:workspace|snapshot|code)\/(.+)$/)
    return marker ? marker[1] : null
  }

  // 逃出快照的相对路径一律丢弃。
  if (trimmed.split('/').includes('..')) return null
  return trimmed.replace(/^\.\//, '')
}
