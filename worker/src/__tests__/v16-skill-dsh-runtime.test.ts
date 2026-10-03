/**
 * V1.6 技能注入的**真实 dsh 运行**验证。
 *
 * 存在的理由：§19 的第 9、10、11、12、13 条问的都不是"平台代码写对了吗"，而是
 * **"dsh 实际做了什么"**：
 *
 *   §19.9   首轮只披露 name + description，不含 SKILL.md 正文
 *   §19.10  调用 skill 后拿到完整正文与正确的 resourceBase
 *   §19.11  能通过绝对 resourceBase 读到文本与图片资源
 *   §19.12  脚本不会因为加载技能而被执行
 *   §19.13  Workspace 里同名的项目 Skill 无法覆盖平台 Bundle
 *
 * 这些只能由真实进程回答。单测比对的永远是我们自己写下的期望；Harness 升级悄悄改掉
 * 披露时机或 resourceBase 形状时，只有这里会失败 —— 而失败正是想要的结果。
 *
 * 怎么在没有真实模型的情况下做到：脚本化的 mock 模型端点**逐轮记录请求体**。工具面、
 * 系统提示、以及每一次工具结果都必须出现在某一次模型请求里，所以"模型看到了什么"
 * 完全可以从请求体读出来。整个过程是秒级的，不烧任何真实预算。
 *
 * 用 `RUN_ACP_INTEGRATION=1` 打开，与仓库里其余真实进程用例一致。
 */

import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runSingleAcpTurn } from '../ai/acp/acp-client.js'
import { startAcpProcess } from '../ai/acp/acp-process-supervisor.js'
import { materializeAttemptProfile } from '../ai/acp/profile-materializer.js'
import { V4_DEFAULT_POLICY } from '../ai/policy/v4-capability-policy.js'
import { relaxTree, SkillCache } from '../ai/skills/skill-cache.js'
import { validateSkillArchive } from '../ai/skills/bundle-validator.js'
import { relaxSkillTree } from '../ai/skills/skill-materializer.js'
import type { ProvisionedSkill } from '../ai/skills/skill-provisioner.js'
import { buildZip, pngBytes } from './helpers/zip-builder.js'

const ENABLED = process.env.RUN_ACP_INTEGRATION === '1'

const SKILL_NAME = 'bos-bill-review'
/** 只出现在 description 里的标记：首轮**应当**看到它。 */
const DESCRIPTION_MARKER = 'DESC-MARKER-6f2a'
/** 只出现在 SKILL.md 正文里的标记：首轮**绝不**应当看到它。 */
const BODY_MARKER = 'BODY-MARKER-91cd'
/** 只出现在 references 资源里的标记：只有 read 之后才应当出现。 */
const REFERENCE_MARKER = 'REFERENCE-MARKER-4b7e'
/** 只出现在被 Workspace 里同名技能占位的 description 里：**任何时候都不该出现**。 */
const WORKSPACE_MARKER = 'WORKSPACE-OVERRIDE-MARKER-c3d1'

interface ModelExchange {
  index: number
  body: string
}

interface ScriptedCall {
  name: string
  args: unknown
}

/** 脚本可以看前面所有请求体后再决定这一轮调什么 —— resourceBase 就是这样取到的。 */
type Turn = (history: readonly ModelExchange[]) => ScriptedCall | { finish: true }

/**
 * 记录每一次模型请求体的 OpenAI 兼容端点。
 *
 * 与 `acp-runtime.integration.test.ts` 里那个 mock 的差别只有两点：这个把**全部**请求体
 * 留下来供断言，并且支持"这一轮不调工具、直接收尾"。
 */
function startRecordingModel(script: readonly Turn[]): Promise<{
  baseUrl: string
  exchanges: () => readonly ModelExchange[]
  close: () => Promise<void>
}> {
  const exchanges: ModelExchange[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (!req.url?.includes('/chat/completions')) {
        res.writeHead(404).end('{}')
        return
      }
      const index = exchanges.length
      exchanges.push({ index, body: Buffer.concat(chunks).toString('utf8') })
      const turn = script[Math.min(index, script.length - 1)]!
      const decision = turn(exchanges)

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const base = {
        id: `chatcmpl-${index}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'skill-probe-model',
      }
      const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`)

      if ('finish' in decision) {
        send({
          ...base,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
        })
        send('[DONE]')
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      send({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      })
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: `call_${index}`,
                  type: 'function',
                  function: { name: decision.name, arguments: JSON.stringify(decision.args) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        exchanges: () => exchanges,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

/** 只需要不挡住 turn 的 Broker 替身：预算放行，审计与用量接收。 */
function startPermissiveBroker(socketPath: string, token: string): Promise<{
  routes: () => string[]
  close: () => Promise<void>
}> {
  const routes: string[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ accepted: false, reason: 'unauthorized' }))
        return
      }
      routes.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'application/json' })
      if (req.url === '/attempt/reserve-model-request') {
        res.end(JSON.stringify({ allowed: true, reserved: 1 }))
        return
      }
      if (req.url === '/attempt/tool-audit') {
        res.end(JSON.stringify({ accepted: true, allowed: true }))
        return
      }
      res.end(JSON.stringify({ accepted: true }))
    })
  })
  return new Promise((resolve) => {
    server.listen(socketPath, () => {
      resolve({
        routes: () => [...routes],
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

/**
 * 真实 Bundle：带 frontmatter 的入口 + 文本资源 + 图片资源 + 会留痕的脚本。
 *
 * 脚本写**两个**哨兵，这一点是刻意的：
 *
 *   * `insidePath` 在 Workspace 之内 —— 沙箱允许写。它是"脚本到底有没有跑"的可信信号；
 *     如果拿 Workspace 之外的路径当哨兵，脚本跑了但被沙箱拦住写入，看起来和"没跑"
 *     一模一样，于是"加载技能不会执行脚本"这条断言就变成了空话。这个坑实测踩到过。
 *   * `outsidePath` 在 Workspace 之外 —— 沙箱必须拦住它。它验证 §7.4 的"脚本输出只能写
 *     代码 Workspace"。
 */
function buildProbeBundle(insidePath: string, outsidePath: string): Buffer {
  const entry = [
    '---',
    `name: ${SKILL_NAME}`,
    `description: ${DESCRIPTION_MARKER} BOS 单据领域评审要点`,
    '---',
    '',
    `# ${SKILL_NAME}`,
    '',
    BODY_MARKER,
    '',
    '需要时读取 references/domain-model.md 与 assets/flow.png。',
    '',
  ].join('\n')
  return buildZip([
    { name: 'SKILL.md', content: entry },
    { name: 'references/domain-model.md', content: `# domain\n\n${REFERENCE_MARKER}\n` },
    { name: 'assets/flow.png', content: pngBytes() },
    // 这个脚本**只要被执行过就会留下证据**。断言它没有留下证据，就是断言 dsh 没有
    // 因为加载技能而执行它 —— 比"我们没写执行代码"强得多的证明。
    {
      name: 'scripts/sentinel.sh',
      content: `#!/bin/sh\necho executed > ${insidePath}\necho executed > ${outsidePath}\n`,
    },
  ])
}

/** 把一个 Bundle 走完"校验 → 发布进 cache"，返回可直接物化的条目。 */
function provisionLocally(cacheRoot: string, archive: Buffer): ProvisionedSkill {
  const cache = new SkillCache({ cacheRoot })
  const validated = validateSkillArchive({ archive, expectedSkillName: SKILL_NAME })
  const entry = cache.publish({
    bundleHash: validated.bundleHash,
    manifest: validated.manifest,
    archive,
    files: validated.files,
  })
  return {
    bundle: {
      snapshotId: 'probe-snapshot',
      name: SKILL_NAME,
      description: validated.frontmatter.description,
      version: 1,
      archiveBucket: 'skill-bundles',
      archiveObjectKey: `00000000-0000-0000-0000-000000000000/versions/1/${validated.archiveSha256.slice(7)}.zip`,
      archiveSha256: validated.archiveSha256,
      archiveSizeBytes: validated.archiveSizeBytes,
      bundleHash: validated.bundleHash,
      bundleManifest: validated.manifest,
      expandedSizeBytes: validated.expandedSizeBytes,
      containsScripts: validated.containsScripts,
    },
    cache: entry,
  }
}

/**
 * 在 Workspace 里种一个**同名**的项目技能。
 *
 * 它的 description 带 `WORKSPACE_MARKER`，而且 `.dsh/skills` 的 rank（100）比 bundled
 * root（600）**更高** —— 也就是说如果 `includeDefaultRoots` 没被关掉，它会顶替平台
 * Bundle。断言这个标记从不出现，就是 §19.13 的真实证据。
 */
function plantWorkspaceOverride(cwd: string): void {
  const dir = join(cwd, '.dsh', 'skills', SKILL_NAME)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    [
      '---',
      `name: ${SKILL_NAME}`,
      `description: ${WORKSPACE_MARKER} 这份不该被发现`,
      '---',
      '',
      '# workspace override',
      '',
      WORKSPACE_MARKER,
      '',
    ].join('\n'),
  )
}

interface ChatMessage {
  role?: string
  content?: unknown
  tool_call_id?: string
}

/**
 * 取某一次工具调用的**结果正文**。
 *
 * 必须解析 JSON 而不是在整个请求体上做子串匹配：每一次请求体都完整携带全部 30 个工具的
 * **定义**，所以 `body.includes('read_image')` 在第一轮就为真。那样的断言看起来在测东西，
 * 实际上永远通过 —— 这个坑在写这份用例时真的踩到过。
 *
 * `call_<n>` 与脚本轮次一一对应（见 startRecordingModel），所以调用方按轮次索引取结果。
 */
function toolResultFor(history: readonly ModelExchange[], callId: string): string | null {
  for (const exchange of history) {
    let parsed: { messages?: ChatMessage[] }
    try {
      parsed = JSON.parse(exchange.body) as { messages?: ChatMessage[] }
    } catch {
      continue
    }
    for (const message of parsed.messages ?? []) {
      if (message.role !== 'tool' || message.tool_call_id !== callId) continue
      if (typeof message.content === 'string') return message.content
      // 图片结果是结构化内容块数组；序列化回字符串供断言检查形状。
      return JSON.stringify(message.content)
    }
  }
  return null
}

/**
 * 从 `skill` 工具结果里取 resourceBase 绝对路径。
 *
 * dsh 把它渲染成 `Base directory for this skill: <abs path>`（实测，见
 * `<skill_resources>` 块）。这里按那个真实形状解析，而不是猜一个 JSON 字段名。
 */
function resourceBaseFrom(history: readonly ModelExchange[]): string | null {
  const skillResult = toolResultFor(history, 'call_0')
  if (skillResult === null) return null
  const match = /Base directory for this skill:\s*(\S+)/.exec(skillResult)
  return match === null ? null : match[1]!
}

/**
 * 两种路由模态各跑一遍。
 *
 * 这不是"多测一个组合"，而是 §19.11 图片半边的**唯一**诚实答法：`read_image` 的准入检查
 * 读的是路由声明的 `inputModalities`，而 llm-pi-ai 的默认值是 `['text']`。所以
 * "图片资源能不能读"完全取决于这一个配置，两种取值都必须被断言，否则文档里那句
 * "Agent 可通过绝对 resourceBase 读取文本和图片资源"就是一句没有条件的空话。
 */
const IMAGE_MODES: Array<{ label: string; modalities: readonly ('text' | 'image')[]; readable: boolean }> = [
  { label: 'text-only route (default)', modalities: ['text'], readable: false },
  { label: 'image-capable route', modalities: ['text', 'image'], readable: true },
]

describe.skipIf(!ENABLED)('V1.6 skill injection (real dsh process)', () => {
  it.each(IMAGE_MODES)(
    'discloses only name+description first, then the body and a usable resourceBase — $label',
    async (mode) => {
      const cwd = mkdtempSync(join(tmpdir(), 'v16-cwd-'))
      const attemptsRoot = mkdtempSync(join(tmpdir(), 'v16-att-'))
      const sessionRoot = mkdtempSync(join(tmpdir(), 'v16-sess-'))
      const cacheRoot = mkdtempSync(join(tmpdir(), 'v16-cache-'))
      const socketDir = mkdtempSync(join(tmpdir(), 'v16-sock-'))
      const sentinelDir = mkdtempSync(join(tmpdir(), 'v16-sentinel-'))
      // Workspace 之内：沙箱允许写，所以它是"脚本跑过了"的可信信号。
      const insideSentinel = join(cwd, 'script-ran-inside')
      // Workspace 之外：沙箱必须拦住（§7.4）。
      const outsideSentinel = join(sentinelDir, 'script-ran-outside')
      const socketPath = join(socketDir, 's.sock')
      const token = 'v16-probe-token'

      plantWorkspaceOverride(cwd)
      const provisioned = provisionLocally(
        cacheRoot,
        buildProbeBundle(insideSentinel, outsideSentinel),
      )

      /*
       * 脚本化的四轮：
       *   0  首轮 —— 什么都不做之前先记下请求体（§19.9 的证据），然后调 skill；
       *   1  读文本资源（§19.11 文本半边）；
       *   2  读图片资源（§19.11 图片半边）；
       *   3+ 收尾。
       */
      const script: Turn[] = [
        () => ({ name: 'skill', args: { name: SKILL_NAME } }),
        (history) => {
          const base = resourceBaseFrom(history)
          return base === null
            ? { finish: true }
            : { name: 'read', args: { file_path: `${base}/references/domain-model.md` } }
        },
        (history) => {
          const base = resourceBaseFrom(history)
          return base === null
            ? { finish: true }
            : { name: 'read_image', args: { file_path: `${base}/assets/flow.png` } }
        },
        () => ({ finish: true }),
      ]

      const model = await startRecordingModel(script)
      const broker = await startPermissiveBroker(socketPath, token)

      const profile = materializeAttemptProfile({
        taskId: 'v16-probe-task',
        agentAttempt: 1,
        attemptsRoot,
        route: {
          providerId: 'review-route',
          displayName: 'Skill Probe',
          baseUrl: model.baseUrl,
          modelName: 'skill-probe-model',
          contextWindow: 131072,
          maxTokens: 4096,
          apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
          requestTimeoutMs: 60000,
          inputModalities: mode.modalities,
        },
        policy: V4_DEFAULT_POLICY,
        identity: { rootAgentId: 'root-v16', rootSessionId: 'session-v16' },
        cwd,
        sessionRoot,
        broker: { socketPath },
        skills: { catalogHash: 'probe-catalog', bundles: [provisioned] },
      })

      const child = startAcpProcess({
        dshHome: profile.dshHome,
        profileName: profile.profileName,
        patchPath: profile.patchPath,
        cwd,
        apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
        apiKey: 'v16-not-a-real-key',
        brokerToken: token,
        rootCapability: 'root-cap-v16',
        killGraceMs: 3000,
      })

      const controller = new AbortController()
      try {
        const turn = await runSingleAcpTurn(
          { process: child, cwd, permittedTools: [...profile.rootTools] },
          `Load the ${SKILL_NAME} skill and read its resources.`,
          controller.signal,
        )
        const exchanges = model.exchanges()
        const stderr = child.stderr()
        const all = exchanges.map((exchange) => exchange.body).join('\n')

        if (process.env.V16_DUMP === '1') {
          // 诊断开关。断言只说"通过/不通过"，而排查"dsh 到底回了什么"需要原文。
          for (const exchange of exchanges) {
            process.stdout.write(`\n===== exchange ${exchange.index} =====\n${exchange.body}\n`)
          }
          process.stdout.write(`\n===== stderr =====\n${stderr}\n`)
        }

        // 四次请求 = skill、read、read_image 三次工具调用 + 一次收尾。少一次就说明某个
        // 工具调用根本没发生，而后面所有"结果里应当出现 X"的断言都会变成空话。
        expect(exchanges.length, `stderr: ${stderr}`).toBeGreaterThanOrEqual(4)
        expect(turn.stopReason, `stderr: ${stderr}`).not.toBe('refusal')

        // ---- §19.9 首轮只披露 name + description ---------------------------
        const first = exchanges[0]!.body
        expect(first, 'the first request must advertise the skill by name').toContain(SKILL_NAME)
        expect(first, 'the first request must carry the description').toContain(DESCRIPTION_MARKER)
        // 这一条是渐进式披露的**核心**：正文与资源都不能进初始上下文。
        expect(first, 'SKILL.md body must NOT be in the first request').not.toContain(BODY_MARKER)
        expect(first, 'resource content must NOT be in the first request').not.toContain(
          REFERENCE_MARKER,
        )

        // ---- §19.13 Workspace 同名技能全程不可见 --------------------------
        expect(all, 'a workspace .dsh/skills override must never be discovered').not.toContain(
          WORKSPACE_MARKER,
        )

        // ---- §19.10 调用 skill 后拿到正文与正确的 resourceBase -------------
        const skillResult = toolResultFor(exchanges, 'call_0')
        expect(skillResult, `skill(name) must return a result. stderr: ${stderr}`).not.toBeNull()
        expect(skillResult, `skill(name) must return the body. stderr: ${stderr}`).toContain(
          BODY_MARKER,
        )
        const resourceBase = resourceBaseFrom(exchanges)
        expect(resourceBase, `resourceBase must be disclosed. stderr: ${stderr}`).not.toBeNull()
        // resourceBase 必须正好是 per-attempt 物化目录，而不是 Workspace 里的任何位置。
        expect(resourceBase).toBe(join(profile.skills.skillsDir, SKILL_NAME))
        expect(resourceBase!.startsWith(profile.dshHome)).toBe(true)
        expect(resourceBase!.startsWith(cwd)).toBe(false)

        // ---- §19.11 文本资源可读 ------------------------------------------
        const textResult = toolResultFor(exchanges, 'call_1')
        expect(textResult, `read must have produced a result. stderr: ${stderr}`).not.toBeNull()
        expect(
          textResult,
          `a text resource must be readable through the absolute resourceBase. stderr: ${stderr}`,
        ).toContain(REFERENCE_MARKER)
        expect(textResult).toContain('references/domain-model.md')

        // ---- §19.11 图片资源：取决于路由声明的模态 -------------------------
        //
        // 断言的是 read_image 这一次调用的**结果正文**（call_2），不是整个请求体 ——
        // 请求体里永远带着 read_image 的工具定义。
        const imageResult = toolResultFor(exchanges, 'call_2')
        expect(imageResult, `read_image must have produced a result. stderr: ${stderr}`).not.toBeNull()
        if (mode.readable) {
          expect(
            imageResult,
            `an image-capable route must actually read the asset. stderr: ${stderr}`,
          ).not.toContain('does not declare image input')
          expect(
            imageResult,
            `the asset bytes must decode as a real image. stderr: ${stderr}`,
          ).not.toContain('malformed image data')
          // 成功时结果里带图片本身的路径；失败时它是一行 `Error: ...`。
          expect(imageResult!.startsWith('Error:')).toBe(false)
          expect(imageResult).toContain('assets/flow.png')
        } else {
          // 这条断言把一个**配置依赖**钉成了已知行为：默认路由读不到图片，报错明确指向
          // 模型未声明 image 输入，而不是指向技能包。
          expect(imageResult).toContain('does not declare image input')
        }

        // ---- §19.12 脚本没有因为加载技能而被执行 ---------------------------
        //
        // 哨兵落在 Workspace 之内，沙箱允许写 —— 所以"文件不存在"只能解释为脚本没跑，
        // 不能解释为"跑了但写被拦住"。下一条用例用同一个哨兵做正对照。
        expect(
          existsSync(insideSentinel),
          'loading a skill must never execute its scripts',
        ).toBe(false)
        expect(existsSync(outsideSentinel)).toBe(false)

        // 预算预留确实先于模型请求发生，说明这条链路走的是真实治理面。
        expect(broker.routes()).toContain('/attempt/reserve-model-request')
      } finally {
        controller.abort()
        await child.terminate()
        await broker.close()
        await model.close()
        relaxSkillTree(profile.dshHome)
        profile.cleanup()
        // cache 目录发布后是 0500/0400：不先放宽权限，rmSync 会以 ENOTEMPTY 失败，
        // 而那个失败会盖掉真正的断言结果。
        relaxTree(cacheRoot)
        for (const dir of [cwd, attemptsRoot, sessionRoot, cacheRoot, socketDir, sentinelDir]) {
          rmSync(dir, { recursive: true, force: true })
        }
      }
    },
    180000,
  )

  it(
    'runs a bundle script only when bash is explicitly invoked',
    async () => {
      /*
       * 这是上一条用例的**正对照**。
       *
       * "加载技能不会执行脚本"如果只断言哨兵文件不存在，那它是一句永远为真的空话 ——
       * 哨兵机制自己可能根本不工作。所以这里显式用 `bash` 跑同一个脚本，证明：
       *
       *   1. 哨兵确实能被写出来（机制有效，上一条断言因此有意义）；
       *   2. 脚本能被执行的**唯一**路径是模型显式调用 `bash` —— 而那条路径受角色工具面、
       *      Sandbox 与容器资源限制约束，不是 mode 位。物化成 0400 并不代表不可执行：
       *      `bash x.sh` 不需要 +x。把 mode 位当执行闸门是危险的误解。
       */
      const cwd = mkdtempSync(join(tmpdir(), 'v16b-cwd-'))
      const attemptsRoot = mkdtempSync(join(tmpdir(), 'v16b-att-'))
      const sessionRoot = mkdtempSync(join(tmpdir(), 'v16b-sess-'))
      const cacheRoot = mkdtempSync(join(tmpdir(), 'v16b-cache-'))
      const socketDir = mkdtempSync(join(tmpdir(), 'v16b-sock-'))
      const sentinelDir = mkdtempSync(join(tmpdir(), 'v16b-sentinel-'))
      const insideSentinel = join(cwd, 'script-ran-inside')
      const outsideSentinel = join(sentinelDir, 'script-ran-outside')
      const socketPath = join(socketDir, 's.sock')
      const token = 'v16b-probe-token'

      const provisioned = provisionLocally(
        cacheRoot,
        buildProbeBundle(insideSentinel, outsideSentinel),
      )

      const script: Turn[] = [
        () => ({ name: 'skill', args: { name: SKILL_NAME } }),
        (history) => {
          const base = resourceBaseFrom(history)
          return base === null
            ? { finish: true }
            : {
                name: 'bash',
                args: {
                  command: `sh ${base}/scripts/sentinel.sh`,
                  description: 'run the bundle sentinel script',
                },
              }
        },
        () => ({ finish: true }),
      ]

      const model = await startRecordingModel(script)
      const broker = await startPermissiveBroker(socketPath, token)

      const profile = materializeAttemptProfile({
        taskId: 'v16-script-task',
        agentAttempt: 1,
        attemptsRoot,
        route: {
          providerId: 'review-route',
          displayName: 'Skill Probe',
          baseUrl: model.baseUrl,
          modelName: 'skill-probe-model',
          contextWindow: 131072,
          maxTokens: 4096,
          apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
          requestTimeoutMs: 60000,
        },
        policy: V4_DEFAULT_POLICY,
        identity: { rootAgentId: 'root-v16b', rootSessionId: 'session-v16b' },
        cwd,
        sessionRoot,
        broker: { socketPath },
        skills: { catalogHash: 'probe-catalog', bundles: [provisioned] },
      })

      const child = startAcpProcess({
        dshHome: profile.dshHome,
        profileName: profile.profileName,
        patchPath: profile.patchPath,
        cwd,
        apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
        apiKey: 'v16-not-a-real-key',
        brokerToken: token,
        rootCapability: 'root-cap-v16b',
        killGraceMs: 3000,
      })

      const controller = new AbortController()
      try {
        await runSingleAcpTurn(
          { process: child, cwd, permittedTools: [...profile.rootTools] },
          `Load ${SKILL_NAME} and run its sentinel script.`,
          controller.signal,
        )
        const exchanges = model.exchanges()
        const stderr = child.stderr()

        // 脚本必须真的被跑到 —— 否则上一条"没有被自动执行"的断言就是空话。
        expect(
          existsSync(insideSentinel),
          `an explicit bash call must be able to run a bundle script. ` +
            `bash result: ${toolResultFor(exchanges, 'call_1') ?? '(none)'} stderr: ${stderr}`,
        ).toBe(true)
        /*
         * §7.4：脚本输出只能落在代码 Workspace 之内。
         *
         * 同一次执行里对 Workspace 之外的写必须被沙箱拦住 —— 实测报的是
         * `[sandbox: file access denied under workspace-write mode]`，而且 bash 结果里会
         * 明确带上这条标记，不是静默失败。
         */
        expect(
          existsSync(outsideSentinel),
          'a bundle script must not be able to write outside the code workspace',
        ).toBe(false)
        expect(toolResultFor(exchanges, 'call_1')).toContain('sandbox: file access denied')
        // 物化成只读并不妨碍 `sh <path>`：mode 位不是执行闸门。
        expect(statSync(join(profile.skills.skillsDir, SKILL_NAME, 'scripts', 'sentinel.sh')).mode & 0o111).toBe(0)
      } finally {
        controller.abort()
        await child.terminate()
        await broker.close()
        await model.close()
        relaxSkillTree(profile.dshHome)
        profile.cleanup()
        relaxTree(cacheRoot)
        for (const dir of [cwd, attemptsRoot, sessionRoot, cacheRoot, socketDir, sentinelDir]) {
          rmSync(dir, { recursive: true, force: true })
        }
      }
    },
    180000,
  )
})
