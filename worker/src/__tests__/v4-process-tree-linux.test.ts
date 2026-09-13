/**
 * WP7 验收：进程树回收，在真实 Linux 容器里。
 *
 * 为什么必须在容器里跑：`reapProcessTree()` 依赖两个纯 POSIX 行为 —— `detached: true` 让
 * 子进程独立成组，`kill(-pgid)` 把信号送给整个组。Release Gate 明确要求"进程树回收在目标
 * Linux 容器中验证"，而开发机是 macOS。这套测试把判定逻辑搬进 node:24-bookworm-slim 跑一遍。
 *
 * 测的场景就是 V4 真正会遇到的那个：Agent 通过 Sandbox Shell 或 Jobs 启动构建/测试，那些
 * 进程是 dsh 的孙辈甚至更深。直接子进程退出不会带走它们。
 *
 * 这套测试的两条断言都来自实测发现的问题，不是理论推导：
 *
 *   1. 只终止直接子进程时孙辈存活 —— 这是 V3 的缺陷，也是"为什么需要进程组"的证明；
 *   2. 组信号之后后代变成僵尸（state `Z`）而不是立刻消失。把僵尸算成"存活"会让每一次用过
 *      Shell 的 attempt 都误报 PROCESS_TREE_CLEANUP_FAILED，所以 `listProcessGroup()` 必须
 *      按状态过滤；运维侧的配套是给容器一个 init 进程（compose 的 `init: true`）来收僵尸。
 *
 * 需要 Docker。默认跳过：RUN_LINUX_PROCESS_TREE=1 npm run test:worker
 */

import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ENABLED = process.env.RUN_LINUX_PROCESS_TREE === '1'
const IMAGE = 'node:24-bookworm-slim'

/**
 * 在容器里跑的脚本。
 *
 * 它复刻 supervisor 的两个关键决定（detached 进程组 + 对 -pgid 发信号）和
 * `listProcessGroup()` 的筛选方式（读全表 pgid 列 + 排除 state `Z`），然后制造一棵三层深的
 * 进程树：node → sh → 三个 sleep。
 */
const PROBE = String.raw`
const { spawn, execFileSync } = require('node:child_process')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** listProcessGroup() 的等价实现：按真实 pgid 筛选，排除僵尸。 */
function groupSnapshot(pgid) {
  let out = ''
  try {
    out = execFileSync('ps', ['-eo', 'pid=,pgid=,stat='], { encoding: 'utf8' })
  } catch {
    return { alive: [], zombies: [] }
  }
  const alive = []
  const zombies = []
  for (const line of out.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 3) continue
    const pid = Number(parts[0])
    const group = Number(parts[1])
    const state = parts[2]
    if (!Number.isInteger(pid) || pid <= 0 || group !== pgid) continue
    if (pid === process.pid) continue
    if (state.startsWith('Z')) zombies.push(pid)
    else alive.push(pid)
  }
  return { alive, zombies }
}

function countSleeps() {
  try {
    return Number(
      execFileSync('sh', ['-c', 'ps -eo stat=,comm= | grep "[s]leep" | grep -vc "^Z" || true'], {
        encoding: 'utf8',
      }).trim(),
    )
  } catch {
    return -1
  }
}

/** sh 再 spawn 三个 sleep：这些是 dsh 的孙辈，对应 Shell / Jobs 起的构建进程。 */
function startTree(detached) {
  return spawn('sh', ['-c', 'sleep 300 & sleep 300 & sleep 300 & wait'], {
    detached,
    stdio: 'ignore',
  })
}

async function main() {
  const result = { pid1: process.pid }

  // ---- 场景 1：不分组，只 kill 直接子进程（V3 的行为）----
  const naive = startTree(false)
  await sleep(500)
  naive.kill('SIGKILL')
  await sleep(700)
  result.livingSleepsAfterDirectKill = countSleeps()
  try { execFileSync('sh', ['-c', 'pkill -9 sleep >/dev/null 2>&1 || true']) } catch {}
  await sleep(400)

  // ---- 场景 2：detached 分组 + 对整组发信号（V4 的行为）----
  const grouped = startTree(true)
  await sleep(500)
  const pgid = grouped.pid
  const before = groupSnapshot(pgid)
  result.groupAliveBefore = before.alive.length
  result.groupZombiesBefore = before.zombies.length

  // supervisor 的顺序：先 SIGTERM 让它自己走，再对整组兜底 SIGKILL。
  try { grouped.kill('SIGTERM') } catch {}
  await sleep(400)
  let killError = null
  try { process.kill(-pgid, 'SIGKILL') } catch (err) { killError = String(err && err.code) }
  result.killError = killError
  await sleep(900)

  const after = groupSnapshot(pgid)
  result.groupAliveAfter = after.alive.length
  result.groupZombiesAfter = after.zombies.length
  result.livingSleepsAfterGroupKill = countSleeps()

  process.stdout.write('RESULT=' + JSON.stringify(result) + '\n')
}

main().catch((err) => {
  process.stdout.write('RESULT=' + JSON.stringify({ error: String(err && err.message) }) + '\n')
})
`

async function runProbe(withInit: boolean): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'crp-pgroup-'))
  writeFileSync(join(dir, 'probe.cjs'), PROBE)
  try {
    // procps 提供 ps —— 没有它 listProcessGroup() 无法确认回收结果。镜像里装它是
    // Dockerfile.worker 的一部分，这里显式复现同一步，让这条依赖也是被测过的。
    const { stdout } = await execFileAsync(
      'docker',
      [
        'run',
        '--rm',
        ...(withInit ? ['--init'] : []),
        '-v',
        `${dir}:/probe:ro`,
        IMAGE,
        'bash',
        '-lc',
        'apt-get update >/dev/null 2>&1 && ' +
          'apt-get install -y --no-install-recommends procps >/dev/null 2>&1 && ' +
          'node /probe/probe.cjs',
      ],
      { timeout: 240000, maxBuffer: 1024 * 1024 },
    )
    const line = stdout.split('\n').find((entry) => entry.startsWith('RESULT='))
    expect(line, `probe produced no result. output: ${stdout}`).toBeDefined()
    const result = JSON.parse(line!.slice('RESULT='.length)) as Record<string, unknown>
    expect(result.error, `probe failed: ${String(result.error)}`).toBeUndefined()
    return result
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe.skipIf(!ENABLED)('process tree reaping (real Linux container)', () => {
  it(
    'reclaims the whole descendant tree only when the process group is signalled',
    async () => {
      const result = await runProbe(false)

      // 这套测试跑在容器里，Worker 自己就是 PID 1 —— 与生产布局一致。
      expect(result.pid1).toBe(1)

      // V3 的缺陷：只终止直接子进程时，孙辈仍然在跑（不是僵尸，是真的活着）。
      expect(result.livingSleepsAfterDirectKill as number).toBeGreaterThan(0)

      // V4：子进程独立成组，组里能看到 sh 和它的 sleep 后代。
      expect(result.groupAliveBefore as number).toBeGreaterThan(1)
      expect(result.groupZombiesBefore).toBe(0)

      // 组信号本身没有报错，而且组里再没有活着的进程。
      expect(result.killError).toBeNull()
      expect(result.groupAliveAfter).toBe(0)
      expect(result.livingSleepsAfterGroupKill).toBe(0)

      // 但它们变成了僵尸：没有 init 收尸时，僵尸会留在进程表里。这正是
      // listProcessGroup() 必须按 state 过滤的原因 —— 否则每一次用过 Shell 的 attempt
      // 都会误报 PROCESS_TREE_CLEANUP_FAILED。
      expect(result.groupZombiesAfter as number).toBeGreaterThan(0)
    },
    300000,
  )

  it(
    'leaves no zombie behind when the container runs an init process',
    async () => {
      // 对应 docker-compose.worker.yml 的 `init: true`。没有它，孤儿僵尸会累积到撞上
      // 容器的 PID 上限。
      const result = await runProbe(true)
      expect(result.groupAliveAfter).toBe(0)
      expect(result.groupZombiesAfter).toBe(0)
      expect(result.livingSleepsAfterGroupKill).toBe(0)
    },
    300000,
  )
})
