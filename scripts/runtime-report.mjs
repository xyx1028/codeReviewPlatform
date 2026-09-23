#!/usr/bin/env node

/**
 * AI 取数通道：运行监控的只读诊断导出（V1.5 方案 §8.5）。
 *
 * 为什么是 CLI 而不是页面：AI Agent 没有浏览器，也不应该为了取数去到处连生产库。
 * 前端只服务人的实时监控需求；归因、趋势和异常清单只存在于数据库与结构化日志里。
 *
 * 硬要求（不是建议）：
 *
 *   * **只读。** 只调用 §6.10 的三个查询 RPC。这个文件里不出现 insert / update /
 *     delete / drop 这类动词，也没有任何写路径。
 *   * **凭据不落盘、不回显。** 从环境变量或既有 .env.local / .docker/worker.env 读取，
 *     绝不打印；输出前对结果做一次敏感模式扫描，命中就拒绝输出并报错。
 *   * **--format md 默认。** Markdown 便于 AI 直接阅读，也便于人贴进 issue。
 *   * **输出自带可信度。** 开头固定打印 instrumentation_health：先知道这份数据能不能
 *     采信，再看结论。
 *   * **默认连本地。** 没有显式 --remote 时连本地 Supabase；连生产要 --remote 且二次确认。
 *
 * 用法：
 *   node scripts/runtime-report.mjs attempt --task <task_id> [--attempt N] [--format md|json]
 *   node scripts/runtime-report.mjs trend --group-by model_label,policy_hash --since 30d
 *   node scripts/runtime-report.mjs findings [--batch <batch_id>] [--since 7d]
 */

import { existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321'

/** 允许的趋势分组维度。与数据库侧的白名单逐字一致。 */
export const TREND_DIMENSIONS = [
  'model_label',
  'policy_hash',
  'profile_config_hash',
  'harness_version',
  'capability_contract_hash',
  'worker_id',
  'batch_id',
  'finished_day',
]

/**
 * 输出前的敏感模式扫描（方案 §10.4）。
 *
 * 这些模式刻意写得很窄：`input_tokens` / `output_tokens` 是合法的字段名，不能因为里面
 * 有 "token" 三个字就整份报告拒绝输出。命中的判据是「这个字符串能不能反推出凭据、
 * 主机布局或源码」。
 */
const FORBIDDEN_PATTERNS = [
  { name: 'bearer 头', re: /Bearer\s+[A-Za-z0-9._-]{8,}/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: '模型密钥', re: /\bsk-[A-Za-z0-9_-]{8,}/ },
  { name: 'api key 字段', re: /"(api[_-]?key|apikey|secret|password|service_role_key)"\s*:/i },
  { name: 'URL', re: /\bhttps?:\/\//i },
  { name: '宿主机绝对路径', re: /(^|[^A-Za-z0-9])(\/Users\/|\/home\/|\/workspace\/|\/tmp\/crp-)/ },
  { name: 'git 凭据', re: /\bgl(pat|deploy)-[A-Za-z0-9_-]{8,}/ },
  { name: 'session locator', re: /\.jsonl\b/ },
]

function fail(message) {
  console.error(`runtime-report: ${message}`)
  process.exit(1)
}

/** 解析 KEY=VALUE 形式的环境文件。返回值只在内存里用，绝不打印。 */
function readEnvFile(path) {
  if (!existsSync(path)) return {}
  const out = {}
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (value !== '') out[key] = value
  }
  return out
}

export function parseArgs(argv) {
  const options = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      options._.push(token)
      continue
    }
    const key = token.slice(2)
    if (key === 'remote') {
      options.remote = true
      continue
    }
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      options[key] = true
      continue
    }
    options[key] = next
    index += 1
  }
  return options
}

/** `30d` / `12h` / ISO 时间戳 → ISO 字符串。 */
export function parseSince(raw, fallbackDays) {
  if (raw === undefined || raw === true) {
    return new Date(Date.now() - fallbackDays * 86_400_000).toISOString()
  }
  const relative = /^(\d+)\s*([dhm])$/i.exec(String(raw))
  if (relative !== null) {
    const amount = Number(relative[1])
    const unit = relative[2].toLowerCase()
    const ms = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000
    return new Date(Date.now() - amount * ms).toISOString()
  }
  const parsed = Date.parse(String(raw))
  if (Number.isNaN(parsed)) fail(`--since 无法解析：${String(raw)}`)
  return new Date(parsed).toISOString()
}

async function confirmRemote() {
  if (!process.stdin.isTTY) {
    fail('--remote 需要交互确认，但当前不是 TTY。请在终端里手动执行。')
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const answer = await new Promise((resolvePrompt) => {
    rl.question('即将查询【远端】数据库。确认请输入 yes：', (value) => {
      rl.close()
      resolvePrompt(value.trim())
    })
  })
  if (answer !== 'yes') fail('已取消。')
}

export function resolveCredentials(options) {
  /*
   * 本地与远端读**不同**的 env 文件。
   *
   * 之前两种模式都把 `.docker/worker.env`（云端）并进来，于是在任何跑过云端 Worker 的机器上
   * 默认模式必然拿到云端 `SUPABASE_URL`，然后被自己的"必须是本地地址"守卫拒掉 ——
   * 文档写的"默认连本地 Supabase"在这些机器上根本走不通（2026-09-23 本地全链路排查实测）。
   *
   * 本地模式还刻意**不采用 env 文件里的 URL**：`.docker/worker.local.env` 里是容器视角的
   * `http://host.docker.internal:54321`，在宿主机上不解析。本地只用文件里的 service role key，
   * URL 固定回落到 127.0.0.1，除非调用方在 process.env 里显式指定（那时守卫仍然生效）。
   */
  const localFileEnv = {
    ...readEnvFile(join(root, '.docker/worker.local.env')),
    ...readEnvFile(join(root, '.env.local')),
  }
  const remoteFileEnv = {
    ...readEnvFile(join(root, '.docker/worker.env')),
    ...readEnvFile(join(root, '.env.local')),
  }
  const fileEnv = options.remote === true ? remoteFileEnv : localFileEnv
  const env = { ...fileEnv, ...process.env }
  const url = options.remote === true
    ? env.SUPABASE_URL
    : (process.env.SUPABASE_URL ?? LOCAL_SUPABASE_URL)
  const key = env.SUPABASE_SERVICE_ROLE_KEY

  if (options.remote !== true) {
    // 默认连本地：显式 URL 指向非本地时报错，避免"以为在查本地其实在查生产"。
    const isLocal =
      url === undefined ||
      url.includes('127.0.0.1') ||
      url.includes('localhost') ||
      url.includes('[::1]')
    if (!isLocal) {
      fail('SUPABASE_URL 不是本地地址。要查远端请显式加 --remote。')
    }
  }
  if (url === undefined || url === '') fail('缺少 SUPABASE_URL。')
  if (key === undefined || key === '') {
    fail('缺少 SUPABASE_SERVICE_ROLE_KEY。诊断 RPC 只授予 service_role。')
  }
  return { url: url.replace(/\/+$/, ''), key }
}

async function callRpc(credentials, fn, params) {
  const response = await fetch(`${credentials.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: credentials.key,
      authorization: `Bearer ${credentials.key}`,
    },
    body: JSON.stringify(params),
  })
  const text = await response.text()
  if (!response.ok) {
    // 不回显请求头，也不回显 URL：只把服务端的错误正文给出来。
    fail(`RPC ${fn} 失败（HTTP ${String(response.status)}）：${text.slice(0, 500)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    fail(`RPC ${fn} 返回了非 JSON 内容。`)
    return null
  }
}

export function forbiddenOutputPattern(text) {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.re.test(text)) return pattern.name
  }
  return null
}

/** 命中任何敏感模式就拒绝输出。宁可不输出，也不要把凭据或路径写进 issue。 */
function assertSafeOutput(text) {
  const patternName = forbiddenOutputPattern(text)
  if (patternName !== null) {
    fail(
      `输出被拒绝：命中敏感模式「${patternName}」。这是数据库 payload allowlist 的回归信号，` +
        '请先检查 analysis_runtime_event_payload 与插桩点，不要绕过这个检查。',
    )
  }
}

function emit(text) {
  assertSafeOutput(text)
  process.stdout.write(`${text}\n`)
}

function ms(value) {
  if (value === null || value === undefined) return '—'
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  if (number < 1000) return `${String(Math.round(number))} ms`
  if (number < 60_000) return `${(number / 1000).toFixed(1)} s`
  return `${(number / 60_000).toFixed(1)} min`
}

function pct(value) {
  if (value === null || value === undefined) return '—'
  return `${Number(value).toFixed(2)}%`
}

function mdTable(headers, rows) {
  const lines = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`]
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`)
  return lines.join('\n')
}

/** 可信度块永远第一个打印：先知道数据能不能采信，再看结论。 */
function healthBlock(health) {
  const dropped = Number(health?.events_dropped ?? 0)
  const unattributed = Number(health?.unattributed_pct ?? 0)
  const lines = [
    '## 数据可信度（先看这里）',
    '',
    mdTable(
      ['指标', '值', '说明'],
      [
        ['events_reported', String(health?.events_reported ?? '—'), '已落库的事件数'],
        [
          'events_dropped',
          String(dropped),
          dropped > 0 ? '**有事件丢失，下面的归因偏小**' : '无丢失',
        ],
        [
          'unattributed_pct',
          pct(unattributed),
          unattributed > 40
            ? '**超过 40%：插桩盲区过大，先补插桩再谈优化**'
            : '无法解释的墙钟时间占比',
        ],
        [
          'timeline_truncated',
          String(health?.timeline_truncated ?? false),
          '为真时时间线按 scope 降采样过，不是完整序列',
        ],
        ['rollup_version', String(health?.rollup_version ?? '—'), '0 表示汇总待补算'],
      ],
    ),
    '',
  ]
  return lines.join('\n')
}

/**
 * 已知插桩盲区。
 *
 * 紧跟在可信度块后面打印，而不是塞在报告末尾：`unattributed_pct` 偏高时，AI 应该先看到
 * 「这几块本来就没插桩」，而不是先去怀疑归因算错了。补上插桩后数据库侧会从这个清单里
 * 删掉对应条目，报告随之变短 —— 清单变短就是插桩进度。
 */
function gapsBlock(gaps) {
  if (!Array.isArray(gaps) || gaps.length === 0) return ''
  return [
    '## 已知插桩盲区（这些时间无法归因，不是算错了）',
    '',
    mdTable(
      ['code', '回答不了的问题', '原因', '落在哪个桶'],
      gaps.map((gap) => [
        String(gap.code ?? '—'),
        String(gap.question ?? '—'),
        String(gap.reason ?? '—'),
        String(gap.falls_into ?? '—'),
      ]),
    ),
    '',
  ].join('\n')
}

function renderAttempt(pack) {
  const attribution = pack.attribution ?? {}
  const fingerprint = pack.fingerprint ?? {}
  const out = [
    `# Attempt 诊断 · task ${String(pack.task_id)} · 第 ${String(pack.agent_attempt)} 次`,
    '',
    healthBlock(pack.instrumentation_health),
    gapsBlock(pack.instrumentation_gaps),
    '## 终态与指纹',
    '',
    mdTable(
      ['字段', '值'],
      [
        ['terminal_status', String(pack.terminal_status ?? '—')],
        ['terminal_error_code', String(pack.terminal_error_code ?? '—')],
        ['model_label', String(fingerprint.model_label ?? '—')],
        ['harness_version', String(fingerprint.harness_version ?? '—')],
        ['policy_version', String(fingerprint.policy_version ?? '—')],
        ['prompt_version', String(fingerprint.prompt_version ?? '—')],
        ['policy_hash', String(fingerprint.policy_hash ?? '—')],
        ['profile_config_hash', String(fingerprint.profile_config_hash ?? '—')],
        ['capability_contract_hash', String(fingerprint.capability_contract_hash ?? '—')],
      ],
    ),
    '',
    '## 墙钟时间归因',
    '',
    '归因等式：`setup + busy_union + teardown + unattributed = wall`。',
    '`sum / union` 就是有效并行倍数；`unattributed` 是插桩盲区，允许很大，但不许被摊平。',
    '',
    mdTable(
      ['桶', '时长', '备注'],
      [
        ['wall_ms', ms(attribution.wall_ms), '整次 attempt'],
        ['setup_ms', ms(attribution.setup_ms), 'ATTEMPT_STARTED → HARNESS_PROCESS_STARTED'],
        ['model_ms_union', ms(attribution.model_ms_union), '模型区间并集'],
        ['tool_ms_union', ms(attribution.tool_ms_union), '工具区间并集'],
        [
          'platform_tool_ms_union',
          ms(attribution.platform_tool_ms_union),
          '平台侧：经 Broker 读冻结快照 / 提交',
        ],
        [
          'harness_tool_ms_union',
          ms(attribution.harness_tool_ms_union),
          'Harness 侧：bash / edit / read 等进程内工具',
        ],
        ['busy_ms_union', ms(attribution.busy_ms_union), '(模型 ∪ 工具) 并集'],
        ['teardown_ms', ms(attribution.teardown_ms), '最后一个 TERMINAL → 终态'],
        ['agent_idle_ms', ms(attribution.agent_idle_ms), 'Agent 已注册但无未闭合请求'],
        ['unattributed_ms', ms(attribution.unattributed_ms), `占比 ${pct(attribution.unattributed_pct)}`],
        ['model_ms_sum', ms(attribution.model_ms_sum), `并行倍数 ${String(attribution.model_parallelism ?? '—')}`],
        ['tool_ms_sum', ms(attribution.tool_ms_sum), '总消耗（并发下会超过 wall）'],
      ],
    ),
    '',
    `并发：Agent 峰值 ${String(attribution.max_concurrent_agents ?? '—')} · 工具峰值 ${String(attribution.max_concurrent_tools ?? '—')}`,
    '',
    '> 「慢是模型侧还是平台侧」看上表的 `model_ms_union` / `platform_tool_ms_union` /',
    '> `harness_tool_ms_union` 三项。第四项「数据库往返」首版没有插桩，它在 `unattributed_ms`',
    '> 里 —— 见上面的盲区清单，不要拿 `platform_tool_ms_union` 当数据库耗时用。',
    '',
    '## 模型请求分桶（retry / compaction 是非有效推进）',
    '',
    '```json',
    JSON.stringify(attribution.model_requests_by_kind ?? {}, null, 2),
    '```',
    '',
    '## 最慢的工具调用',
    '',
    mdTable(
      ['工具', '角色', '耗时', '已闭合'],
      (pack.slowest_tools ?? [])
        .slice(0, 20)
        .map((row) => [
          String(row.tool_name ?? '—'),
          String(row.agent_role ?? '—'),
          ms(row.duration_ms),
          String(row.closed),
        ]),
    ),
    '',
    '## 最慢的模型请求',
    '',
    mdTable(
      ['类型', '角色', '耗时', '已闭合'],
      (pack.slowest_model_requests ?? [])
        .slice(0, 20)
        .map((row) => [
          String(row.model_request_kind ?? '—'),
          String(row.agent_role ?? '—'),
          ms(row.duration_ms),
          String(row.closed),
        ]),
    ),
    '',
    '## 失败与拒绝（按错误码聚合）',
    '',
    mdTable(
      ['事件', '错误码', 'reason_code', '次数', '首次出现'],
      (pack.failures ?? []).map((row) => [
        String(row.event_type ?? '—'),
        String(row.error_code ?? '—'),
        String(row.reason_code ?? '—'),
        String(row.occurrences ?? 0),
        String(row.first_seen_at ?? '—'),
      ]),
    ),
    '',
    '## 终态时仍未闭合的 correlation（插桩漏洞或进程被杀的证据）',
    '',
    (pack.open_at_end ?? []).length === 0
      ? '无。'
      : mdTable(
          ['scope', '工具', '开始时间'],
          (pack.open_at_end ?? []).map((row) => [
            String(row.scope ?? '—'),
            String(row.tool_name ?? '—'),
            String(row.started_at ?? '—'),
          ]),
        ),
    '',
    '## 阶段序列',
    '',
    mdTable(
      ['事件', '活动码', '时间', '耗时', '错误码'],
      (pack.phases ?? []).map((row) => [
        String(row.event_type ?? '—'),
        String(row.activity_code ?? '—'),
        String(row.occurred_at ?? '—'),
        ms(row.duration_ms),
        String(row.error_code ?? '—'),
      ]),
    ),
    '',
    '## per-Agent 归因（回答「哪个子 Agent 烧了预算却没产出」）',
    '',
    '```json',
    JSON.stringify(pack.agents ?? [], null, 2),
    '```',
    '',
  ]
  return out.join('\n')
}

function renderTrend(result) {
  const lines = [
    '# 跨运行趋势与回归对比',
    '',
    `分组维度：\`${(result.group_by ?? []).join(', ')}\` · 起始：${String(result.since ?? '—')}`,
    '',
    '> 汇总表不随事件清理，所以这里能跨月比较。`unattributed_pct` 越高说明插桩盲区越大，',
    '> 这份对比的可信度也越低。',
    '',
    '> 判读顺序：先看**每次模型请求 p50** —— 它只反映模型端速度，平台改不动它。',
    '> 它正常而 wall 很大时，再看"模型请求次数"（编排来回太多）和"每次请求输入 token"',
    '> （上下文膨胀）。三者相乘约等于 `model_ms_union`，所以任何一次变慢都能落到具体一项上。',
    '',
  ]
  for (const group of result.groups ?? []) {
    lines.push(`## ${JSON.stringify(group.group ?? {})}`)
    lines.push('')
    lines.push(
      mdTable(
        ['指标', '值'],
        [
          ['count', String(group.count ?? 0)],
          ['failed', String(group.failed ?? 0)],
          ['failure_rate', String(group.failure_rate ?? 0)],
          ['wall_ms p50', ms(group.wall_ms_p50)],
          ['wall_ms p95', ms(group.wall_ms_p95)],
          ['wall_ms max', ms(group.wall_ms_max)],
          // 下面三行是"为什么这么慢"的分解：单请求耗时 × 请求次数 ≈ model_ms_union。
          // 模型端慢、上下文膨胀、来回太多，三种病因看的是不同的那一行。
          ['**每次模型请求 p50**', ms(group.model_ms_per_request_p50)],
          ['每次模型请求 p95', ms(group.model_ms_per_request_p95)],
          ['模型请求次数 p50', String(group.model_requests_p50 ?? '—')],
          ['每次请求输入 token p50', String(
            group.input_tokens_per_request_p50 === null ||
            group.input_tokens_per_request_p50 === undefined
              ? '—'
              : Math.round(Number(group.input_tokens_per_request_p50)),
          )],
          ['setup_ms p50', ms(group.setup_ms_p50)],
          ['model_ms_union p50', ms(group.model_ms_union_p50)],
          ['tool_ms_union p50', ms(group.tool_ms_union_p50)],
          ['platform_tool_ms_union p50', ms(group.platform_tool_ms_union_p50)],
          ['busy_ms_union p50', ms(group.busy_ms_union_p50)],
          ['teardown_ms p50', ms(group.teardown_ms_p50)],
          ['agent_idle_ms p50', ms(group.agent_idle_ms_p50)],
          ['unattributed_pct', pct(group.unattributed_pct)],
          ['events_dropped', String(group.events_dropped ?? 0)],
        ],
      ),
    )
    lines.push('')
    lines.push(`错误码分布：\`${JSON.stringify(group.terminal_error_codes ?? {})}\``)
    lines.push('')
  }
  if ((result.groups ?? []).length === 0) {
    lines.push('这个时间窗口内没有已汇总的 attempt。')
    lines.push('')
  }
  return lines.join('\n')
}

function renderFindings(result) {
  const findings = result.findings ?? []
  const lines = [
    '# 预计算异常清单',
    '',
    `起始：${String(result.since ?? '—')}${result.batch_id ? ` · 批次 ${String(result.batch_id)}` : ''}`,
    '',
    '> 人和 AI 用同一套判据（`get_analysis_runtime_findings`），避免两边结论不一致。',
    '',
  ]
  if (findings.length === 0) {
    lines.push('没有命中任何 finding。')
    lines.push('')
    return lines.join('\n')
  }
  lines.push(
    mdTable(
      ['code', '严重度', 'agent_run_id', '证据'],
      findings.map((finding) => [
        String(finding.code ?? '—'),
        String(finding.severity ?? '—'),
        String(finding.agent_run_id ?? '—'),
        `\`${JSON.stringify(finding.evidence ?? {})}\``,
      ]),
    ),
  )
  lines.push('')
  return lines.join('\n')
}

function usage() {
  return [
    '用法：',
    '  node scripts/runtime-report.mjs attempt --task <task_id> [--attempt N] [--format md|json] [--remote]',
    '  node scripts/runtime-report.mjs trend [--group-by model_label,policy_hash] [--since 30d] [--batch <id>] [--status COMMITTED|FAILED]',
    '  node scripts/runtime-report.mjs findings [--batch <id>] [--since 7d]',
    '',
    `允许的 --group-by 维度：${TREND_DIMENSIONS.join(', ')}`,
    '默认连接本地 Supabase；查远端需要显式 --remote 并二次确认。',
  ].join('\n')
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (command === undefined || command === 'help' || command === '--help') {
    process.stdout.write(`${usage()}\n`)
    return
  }
  const options = parseArgs(rest)
  const format = options.format === 'json' ? 'json' : 'md'
  if (options.remote === true) await confirmRemote()
  const credentials = resolveCredentials(options)

  if (command === 'attempt') {
    const taskId = options.task
    if (typeof taskId !== 'string') fail('attempt 需要 --task <task_id>。')
    const attempt =
      options.attempt === undefined || options.attempt === true ? null : Number(options.attempt)
    const pack = await callRpc(credentials, 'get_analysis_attempt_diagnostics', {
      p_task_id: taskId,
      p_agent_attempt: attempt,
    })
    emit(format === 'json' ? JSON.stringify(pack, null, 2) : renderAttempt(pack))
    return
  }

  if (command === 'trend') {
    const raw =
      options['group-by'] === undefined || options['group-by'] === true
        ? 'model_label,policy_hash'
        : String(options['group-by'])
    const groupBy = raw
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '')
    for (const dimension of groupBy) {
      if (!TREND_DIMENSIONS.includes(dimension)) {
        fail(`--group-by 维度不在白名单内：${dimension}`)
      }
    }
    const result = await callRpc(credentials, 'get_analysis_run_trend', {
      p_group_by: groupBy,
      p_since: parseSince(options.since, 90),
      p_batch_id: typeof options.batch === 'string' ? options.batch : null,
      p_terminal_status: typeof options.status === 'string' ? options.status : null,
    })
    emit(format === 'json' ? JSON.stringify(result, null, 2) : renderTrend(result))
    return
  }

  if (command === 'findings') {
    const result = await callRpc(credentials, 'get_analysis_runtime_findings', {
      p_batch_id: typeof options.batch === 'string' ? options.batch : null,
      p_since: parseSince(options.since, 7),
    })
    emit(format === 'json' ? JSON.stringify(result, null, 2) : renderFindings(result))
    return
  }

  fail(`未知命令：${command}\n\n${usage()}`)
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) await main()
