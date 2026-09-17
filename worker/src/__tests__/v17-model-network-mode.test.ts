/**
 * V1.7 阶段二：模型网络类型与代理防护。
 *
 * 这些用例守的是阶段一实测出来的三个缺陷，所以每条都对着一个具体的失败现场：
 *
 *   1. 连接测试**无条件**走代理 → 公网模型被代理的域名白名单拒成 HTTP 403；
 *   2. 正式评审链路压根没接代理 → 内网模型"测得通、跑必挂"；
 *   3. 代理用域名白名单做准入 → 新增内网模型要改代理配置并重启服务。
 *
 * 判定只有一处（`resolveModelNetworkRoute`），所以这里也只测那一处 —— 两条链路共用它，
 * 就不可能再分叉。
 */

import { describe, expect, it } from 'vitest'
import { JobsDb } from '../db/jobs.js'
import {
  MODEL_PROXY_NOT_CONFIGURED,
  ModelNetworkRouteError,
  hostProxyChildEnv,
  parseModelNetworkAccessMode,
  resolveModelNetworkRoute,
  type HostProxySettings,
} from '../model-connectivity/network-mode.js'

const PROXY: HostProxySettings = {
  url: 'http://host.docker.internal:17890',
  username: 'worker',
  password: 'p@ss word/1',
}

describe('parseModelNetworkAccessMode', () => {
  it('treats a missing mode as DIRECT so in-flight jobs never change network path', () => {
    // 在途旧 Job 的 model_snapshot 里没有这个字段。缺失必须等于改造前的行为，
    // 否则一次部署就会把正在跑的任务搬到另一张网上。
    expect(parseModelNetworkAccessMode(undefined)).toBe('DIRECT')
    expect(parseModelNetworkAccessMode(null)).toBe('DIRECT')
    expect(parseModelNetworkAccessMode('')).toBe('DIRECT')
  })

  it('passes through the two known modes', () => {
    expect(parseModelNetworkAccessMode('DIRECT')).toBe('DIRECT')
    expect(parseModelNetworkAccessMode('HOST_PROXY')).toBe('HOST_PROXY')
  })

  it.each(['direct', 'PROXY', 'HOST-PROXY', 0, true, {}])(
    'refuses the unrecognized mode %p instead of guessing',
    (raw) => {
      // 猜一个默认值会把写入侧的 bug 变成一次静默的网络路径变更。
      expect(() => parseModelNetworkAccessMode(raw)).toThrow(ModelNetworkRouteError)
    },
  )
})

describe('resolveModelNetworkRoute', () => {
  it('never proxies a public model, even when a proxy is configured', () => {
    // 这就是 DashScope 那个 403 的根因：阶段一在这里无条件传了代理。
    expect(resolveModelNetworkRoute({ mode: 'DIRECT', configuredProxy: PROXY })).toEqual({
      mode: 'DIRECT',
      proxy: null,
    })
  })

  it('proxies an intranet model when the worker has a proxy', () => {
    expect(resolveModelNetworkRoute({ mode: 'HOST_PROXY', configuredProxy: PROXY })).toEqual({
      mode: 'HOST_PROXY',
      proxy: PROXY,
    })
  })

  it('refuses an intranet model on a worker without a proxy instead of going direct', () => {
    // 静默直连的后果：内网域名被公网 DNS 解析到某个同名主机，API Key 跟着发出去。
    try {
      resolveModelNetworkRoute({ mode: 'HOST_PROXY', configuredProxy: null })
      expect.unreachable('a HOST_PROXY model must not fall back to a direct request')
    } catch (err) {
      expect(err).toBeInstanceOf(ModelNetworkRouteError)
      expect((err as ModelNetworkRouteError).code).toBe(MODEL_PROXY_NOT_CONFIGURED)
      // 报错必须指向 Worker 配置，而不是让管理员去查模型端点。
      expect((err as ModelNetworkRouteError).message).toContain('未配置内网代理')
    }
  })

  it('treats a legacy snapshot without the field as a public model', () => {
    expect(resolveModelNetworkRoute({ mode: undefined, configuredProxy: PROXY }).proxy).toBeNull()
  })
})

describe('hostProxyChildEnv', () => {
  it('sets exactly what Node 24 needs to honour the proxy', () => {
    // 实测三组对照：不设变量 → ENOTFOUND；只设 HTTPS_PROXY → 仍 ENOTFOUND
    // （Node 24 必须显式 opt-in）；两者都设 → ECONNREFUSED（确实去连代理了）。
    const env = hostProxyChildEnv(PROXY)
    expect(env.NODE_USE_ENV_PROXY).toBe('1')
    expect(env.HTTP_PROXY).toBe(env.HTTPS_PROXY)
    expect(env.HTTPS_PROXY).toContain('host.docker.internal:17890')
    // Broker 走 Unix socket，但显式排除 loopback 是给"万一有人改成 TCP"留的保护。
    expect(env.NO_PROXY).toContain('127.0.0.1')
  })

  it('url-encodes credentials so a password with reserved characters still parses', () => {
    const env = hostProxyChildEnv(PROXY)
    // 密码里有空格和斜杠。不编码的话 new URL() 在下游会解析出错误的 host。
    expect(env.HTTPS_PROXY).not.toContain(' ')
    const parsed = new URL(env.HTTPS_PROXY)
    expect(parsed.hostname).toBe('host.docker.internal')
    expect(decodeURIComponent(parsed.password)).toBe('p@ss word/1')
  })

  it('omits credentials when the proxy has none', () => {
    const env = hostProxyChildEnv({ url: 'http://127.0.0.1:17890', username: null, password: null })
    expect(new URL(env.HTTPS_PROXY).username).toBe('')
  })
})

describe('host proxy SSRF guard', () => {
  /**
   * `isDeniedTarget` 是代理里唯一值得单测的纯函数。
   *
   * 它替代的是被删掉的域名白名单，但防的**不是**"访问了不该访问的模型" —— 那个判断已经
   * 上移到模型配置了。它防的是把这个代理当跳板去打本机与基础设施：Agent 的 Shell 会继承
   * 代理环境（用真实 dsh 进程实测确认过），所以代理必须自己挡住这些目标。
   */
  async function guard(): Promise<(hostname: unknown) => boolean> {
    // 代理是一个 .mjs 运维脚本，没有类型声明；用运行时路径 import 并显式收窄，
    // 避免给一个纯脚本硬造一份 .d.ts。
    const specifier = '../../../scripts/model-vpn-proxy.mjs'
    const module = (await import(/* @vite-ignore */ specifier)) as unknown as {
      isDeniedTarget: (hostname: unknown) => boolean
    }
    return module.isDeniedTarget
  }

  it('allows ordinary model hosts', async () => {
    const isDenied = await guard()
    for (const host of ['ai.zenithal.ai', 'dashscope.aliyuncs.com', 'api.openai.com', '10.20.30.40']) {
      expect(isDenied(host), host).toBe(false)
    }
  })

  it.each([
    ['loopback name', 'localhost'],
    ['loopback name suffix', 'api.localhost'],
    ['loopback v4', '127.0.0.1'],
    ['loopback v4 elsewhere in the block', '127.5.5.5'],
    ['loopback v6', '::1'],
    ['ipv4-mapped loopback', '::ffff:127.0.0.1'],
    ['link-local / cloud metadata', '169.254.169.254'],
    ['gcp metadata name', 'metadata.google.internal'],
    ['imds v6', 'fd00:ec2::254'],
    ['docker host', 'host.docker.internal'],
    ['docker gateway', 'gateway.docker.internal'],
    ['docker for mac', 'docker.for.mac.localhost'],
    ['docker bridge gateway', '172.17.0.1'],
    ['wildcard v4', '0.0.0.0'],
    ['wildcard v6', '::'],
    ['empty', ''],
    ['malformed with space', 'bad host'],
    ['non-string', 42],
  ])('denies %s', async (_label, host) => {
    const isDenied = await guard()
    expect(isDenied(host)).toBe(true)
  })

  it('denies the bracketed form of a loopback literal', async () => {
    const isDenied = await guard()
    // CONNECT 的 authority 形如 `[::1]:443`，去掉方括号后仍必须被识别。
    expect(isDenied('[::1]')).toBe(true)
  })
})

describe('claim mapper carries the frozen mode', () => {
  /**
   * 这条用例守的是一个**端到端才暴露出来的**缺口。
   *
   * `claimNextModelConnectivityTest` 逐字段构造返回对象。给 `ModelConnectivityTestClaim`
   * 加了字段但忘了在 mapper 里映射，编译照样通过，运行时该字段永远是 undefined —— 于是
   * 内网模型被当成公网模型直连。判定函数的单测抓不到它，因为数据根本没经过 mapper。
   */
  function fakeDb(row: Record<string, unknown>) {
    return {
      rpc: async <T>(): Promise<T> => row as unknown as T,
    }
  }

  it('maps network_access_mode_snapshot out of the RPC row', async () => {
    const db = new JobsDb(fakeDb({
      id: 'test-1',
      model_config_id: 'model-1',
      base_url_snapshot: 'https://model.invalid/v1',
      model_name_snapshot: 'm',
      request_timeout_ms_snapshot: 15000,
      network_access_mode_snapshot: 'HOST_PROXY',
      claim_token: 'token-1',
    }))
    const claim = await db.claimNextModelConnectivityTest('worker-1', 90)
    expect(claim?.network_access_mode_snapshot).toBe('HOST_PROXY')
    // 而且它必须能一路走到判定：这是"冻结值真的决定了路由"的最短证明。
    expect(
      resolveModelNetworkRoute({
        mode: claim?.network_access_mode_snapshot,
        configuredProxy: PROXY,
      }).proxy,
    ).toEqual(PROXY)
  })

  it('leaves the field undefined for a legacy row so it degrades to DIRECT', async () => {
    const db = new JobsDb(fakeDb({
      id: 'test-2',
      model_config_id: 'model-2',
      base_url_snapshot: 'https://model.invalid/v1',
      model_name_snapshot: 'm',
      request_timeout_ms_snapshot: 15000,
      claim_token: 'token-2',
    }))
    const claim = await db.claimNextModelConnectivityTest('worker-1', 90)
    expect(claim?.network_access_mode_snapshot).toBeUndefined()
    expect(
      resolveModelNetworkRoute({
        mode: claim?.network_access_mode_snapshot,
        configuredProxy: PROXY,
      }).proxy,
    ).toBeNull()
  })
})
