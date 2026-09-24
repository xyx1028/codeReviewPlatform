/**
 * 宿主机代理链路的回归测试。
 *
 * 存在理由是一个真实故障（2026-09-24）：HTTPS 目标经 CONNECT 隧道时，代码写的是
 * `https.request({ createConnection: () => tunnel, agent: false })`。Node 在
 * `agent === false` 时会新建一个默认 Agent 并走 Agent 自己的 createConnection，
 * options 里那个函数被忽略，请求实际去连 `127.0.0.1:443` → ECONNREFUSED → 又被错误映射成
 * `PROXY_UNREACHABLE`。表象是「宿主机代理不可用」，而代理其实好着，隧道也建成了 ——
 * 只是请求一个字节都没写进隧道。
 *
 * 所以这里断言的正是那两条：请求必须真的写进隧道 socket（ClientHello 到达目标），
 * 以及隧道建成之后的失败不许再报成「代理不可用」。
 */
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ProxyHttpError, proxyHttpGet } from '../net/proxy-http.js'

const closers: Array<() => Promise<void>> = []

function track(server: http.Server | net.Server): void {
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  )
}

function port(server: http.Server | net.Server): number {
  return (server.address() as AddressInfo).port
}

function listen<T extends http.Server | net.Server>(server: T): Promise<T> {
  track(server)
  return new Promise<T>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.()
})

/** 记录收到的字节的裸 TCP 目标。收到第一块数据后回垃圾，让 TLS 立刻失败。 */
async function startByteRecorder(): Promise<{ server: net.Server; received: Buffer[] }> {
  const received: Buffer[] = []
  const server = net.createServer((socket) => {
    socket.once('data', (chunk: Buffer) => {
      received.push(chunk)
      socket.end('not-tls\r\n\r\n')
    })
    socket.on('error', () => {})
  })
  await listen(server)
  return { server, received }
}

/** 只支持 CONNECT 的最小代理，把隧道直连到指定端口。 */
async function startConnectProxy(targetPort: number): Promise<{
  server: http.Server
  tunnels: string[]
}> {
  const tunnels: string[] = []
  const server = http.createServer()
  server.on('connect', (request, clientSocket, head) => {
    tunnels.push(request.url ?? '')
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  await listen(server)
  return { server, tunnels }
}

describe('proxyHttpGet：HTTPS 经 CONNECT 隧道', () => {
  it('把请求写进隧道 socket，而不是另开一条到 127.0.0.1:443 的连接', async () => {
    const target = await startByteRecorder()
    const proxy = await startConnectProxy(port(target.server))

    const error = await proxyHttpGet({
      url: `https://localhost:${port(target.server)}/quality-platform/api/linky/stories`,
      timeoutMs: 3000,
      maxBytes: 1024,
      proxy: { url: `http://127.0.0.1:${port(proxy.server)}`, username: 'u', password: 'p' },
    }).then(
      () => null,
      (reason: unknown) => reason,
    )

    // 隧道按 host:port 建立。
    expect(proxy.tunnels).toEqual([`localhost:${port(target.server)}`])
    // 目标真的收到了 TLS ClientHello（记录类型 0x16）。修复前这里是空的。
    expect(target.received.length).toBeGreaterThan(0)
    expect(target.received[0]?.[0]).toBe(0x16)
    // 隧道建成之后的 TLS 失败不是「代理不可用」。
    expect(error).toBeInstanceOf(ProxyHttpError)
    expect((error as ProxyHttpError).code).toBe('NETWORK_ERROR')
  })

  it('代理端口没人监听时才报 PROXY_UNREACHABLE', async () => {
    const idle = await listen(net.createServer())
    const deadPort = port(idle)
    await new Promise<void>((resolve) => idle.close(() => resolve()))

    const error = await proxyHttpGet({
      url: 'https://localhost:2055/stories',
      timeoutMs: 2000,
      maxBytes: 1024,
      proxy: { url: `http://127.0.0.1:${deadPort}`, username: 'u', password: 'p' },
    }).then(
      () => null,
      (reason: unknown) => reason,
    )

    expect(error).toBeInstanceOf(ProxyHttpError)
    expect((error as ProxyHttpError).code).toBe('PROXY_UNREACHABLE')
  })
})

describe('proxyHttpGet：明文 HTTP 经代理绝对 URL 转发', () => {
  it('把绝对 URL 与 Proxy-Authorization 交给代理，DNS 与路由都在宿主机侧完成', async () => {
    let seenPath = ''
    let seenAuth = ''
    const proxy = http.createServer((request, response) => {
      seenPath = request.url ?? ''
      seenAuth = String(request.headers['proxy-authorization'] ?? '')
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ items: [], total: 0 }))
    })
    await listen(proxy)

    const result = await proxyHttpGet({
      url: 'http://feature.internal:2055/api/linky/stories?page=1',
      timeoutMs: 3000,
      maxBytes: 4096,
      proxy: { url: `http://127.0.0.1:${port(proxy)}`, username: 'worker', password: 'secret' },
    })

    expect(result.statusCode).toBe(200)
    expect(JSON.parse(result.body.toString('utf8'))).toEqual({ items: [], total: 0 })
    expect(seenPath).toBe('http://feature.internal:2055/api/linky/stories?page=1')
    expect(seenAuth).toBe(`Basic ${Buffer.from('worker:secret').toString('base64')}`)
  })
})
