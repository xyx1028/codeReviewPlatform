/**
 * `.env` 加载。
 *
 * 必须在进程里做，不能只靠文档让人 `set -a && . ./.env`：README 和 `npm run mcp:start`
 * 都是"填好 .env 就能起"的口径，而 `node src/index.mjs` 本身不读任何文件 —— 结果是
 * 第一次启动必然停在"缺少必需的环境变量"，而配置其实已经填好了。
 *
 * 真实环境变量优先（`process.loadEnvFile` 的语义就是不覆盖已存在的值）：容器里用
 * `--env-file` / systemd 的 `EnvironmentFile` 注入时，不会被仓库里一份过期的 .env 盖掉。
 */

import { existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export class EnvFileError extends Error {
  constructor(message) {
    super(message)
    this.name = 'EnvFileError'
  }
}

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * @returns 实际加载的文件路径；没有可加载的文件时返回 null。
 * @throws {EnvFileError} `CRP_MCP_ENV_FILE` 指向的文件不存在或读不动时 —— 显式指定却
 *   加载不了必须是硬错误，否则会退化成"静默少了一半配置"。
 */
export function loadEnvFileIfPresent({
  env = process.env,
  cwd = process.cwd(),
  packageRoot = PACKAGE_ROOT,
  execArgv = process.execArgv,
  loadEnvFile = typeof process.loadEnvFile === 'function'
    ? (file) => process.loadEnvFile(file)
    : null,
  exists = existsSync,
} = {}) {
  const configured = (env.CRP_MCP_ENV_FILE ?? '').trim()

  /**
   * 已经用 `node --env-file=...` 指过文件时就不要再叠一份 `.env`。
   *
   * 叠加的后果不是报错而是"两份配置混在一起"：`--env-file` 的值先进 env，随后 `.env`
   * 里只有它才有的键会被补进来 —— 看起来起来了，实际跑的是两份配置的并集。
   * `start:selfhost` 就是这种启动方式。
   */
  if (configured === '' && (execArgv ?? []).some((arg) => String(arg).startsWith('--env-file'))) {
    return null
  }

  const target =
    configured === ''
      ? resolve(packageRoot, '.env')
      : isAbsolute(configured)
        ? configured
        : resolve(cwd, configured)

  if (!exists(target)) {
    if (configured !== '') {
      throw new EnvFileError(`CRP_MCP_ENV_FILE 指向的文件不存在：${target}`)
    }
    return null
  }
  if (loadEnvFile === null) {
    throw new EnvFileError(
      `当前 Node（${process.version}）不支持 process.loadEnvFile，无法加载 ${target}。` +
        '请升级到 Node 20.12 及以上，或改用 `set -a && . ./.env && set +a` 后再启动。',
    )
  }
  try {
    loadEnvFile(target)
  } catch (error) {
    throw new EnvFileError(`读取 ${target} 失败：${String(error?.message ?? error)}`)
  }
  return target
}
