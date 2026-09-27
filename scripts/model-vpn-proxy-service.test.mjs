import { describe, it, expect } from 'vitest'
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { once } from 'node:events'
import { buildConfig, parseEnv, updateWorkerEnv, launchdPlist, windowsInstallScript, windowsWatchdogScript } from './model-vpn-proxy-service.mjs'

describe('shared proxy installer', () => {
  it('preserves Worker credentials and unrelated configuration across reinstalls', () => {
    const original = '# custom\r\nLINKY_NETWORK_ACCESS_MODE=HOST_PROXY\r\nMODEL_CONNECTIVITY_PROXY_USERNAME=existing\r\nMODEL_CONNECTIVITY_PROXY_PASSWORD=a=b&c\r\n'
    const config = buildConfig(parseEnv(original), {})
    expect(config.MODEL_VPN_PROXY_ALLOWED_PORTS).toBe('80,443,2055,90')
    expect(config.MODEL_VPN_PROXY_PASSWORD).toBe('a=b&c')
    const updated = updateWorkerEnv(original, config)
    expect(updated).toContain('LINKY_NETWORK_ACCESS_MODE=HOST_PROXY')
    expect(updateWorkerEnv(updated, buildConfig(parseEnv(updated), {}))).toBe(updated)
    expect(parseEnv(updated).MODEL_CONNECTIVITY_PROXY_URL).toBe('http://host.docker.internal:17890')
  })
  it('honors explicit port policy and rejects malformed settings before installing', () => {
    expect(buildConfig({}, { MODEL_VPN_PROXY_ALLOWED_PORTS: '443,8443' }).MODEL_VPN_PROXY_ALLOWED_PORTS).toBe('443,8443')
    for (const value of ['', '443,0', 'abc', '65536']) {
      expect(() => buildConfig({}, { MODEL_VPN_PROXY_ALLOWED_PORTS: value })).toThrow()
    }
    expect(() => buildConfig({}, { MODEL_VPN_PROXY_PORT: '0' })).toThrow()
  })
  it('escapes launchd paths and keeps credentials out of the service definition', () => {
    const result = launchdPlist('/a & b/node', '/code/proxy.mjs', '/private/config.json', '/logs')
    expect(result).toContain('/a &amp; b/node')
    expect(result).toContain('<string>run</string>')
    expect(result).not.toContain('PASSWORD')
  })
  it('installs a single-instance primary task plus a minute watchdog task', () => {
    const result = windowsInstallScript('C:\\Program Files\\node.exe', "C:\\O'Brien\\proxy.mjs", 'C:\\用户\\config.json', "C:\\O'Brien", 18990)
    expect(result).toContain("O''Brien")
    expect(result).toContain('-MultipleInstances IgnoreNew')
    expect(result).toContain('-ExecutionTimeLimit ([TimeSpan]::Zero)')
    expect(result).toContain('New-ScheduledTaskTrigger -Once')
    expect(result).toContain('-RepetitionInterval (New-TimeSpan -Minutes 1)')
    expect(result).toContain("'codereviewplatform-model-vpn-proxy-watchdog'")
    expect(result).toContain('Disable-ScheduledTask -InputObject $legacy')
    expect(result).toContain('-Force')
    expect(result).not.toContain('Unregister-ScheduledTask')
  })
  it('only restarts the primary task when the local proxy port is unhealthy', () => {
    const result = windowsWatchdogScript(18990)
    expect(result).toContain("Test-NetConnection -ComputerName '127.0.0.1' -Port $port")
    expect(result).toContain("'codereviewplatform-model-vpn-proxy'")
    expect(result).toContain('Stop-ScheduledTask -InputObject $proxyTask')
    expect(result).toContain("Start-ScheduledTask -TaskPath '\\' -TaskName")
    expect(() => windowsWatchdogScript(0)).toThrow('Invalid MODEL_VPN_PROXY_PORT')
  })
  it('starts the actual proxy from paths containing spaces, Unicode and #', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'proxy 测试 # '))
    let child
    try {
      for (const name of ['model-vpn-proxy.mjs', 'model-vpn-proxy-config.mjs']) {
        copyFileSync(new URL(name, import.meta.url), path.join(dir, name))
      }
      const reserve = net.createServer()
      reserve.listen(0, '127.0.0.1')
      await once(reserve, 'listening')
      const port = reserve.address().port
      await new Promise(resolve => reserve.close(resolve))
      const childEnv = { ...process.env, MODEL_VPN_PROXY_PORT: String(port), MODEL_VPN_PROXY_USERNAME: 'test', MODEL_VPN_PROXY_PASSWORD: 'test' }
      delete childEnv.MODEL_VPN_PROXY_ALLOWED_PORTS
      child = spawn(process.execPath, [path.join(dir, 'model-vpn-proxy.mjs')], {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const output = await new Promise((resolve, reject) => {
        let buffer = ''
        const timer = setTimeout(() => reject(new Error('proxy startup timed out')), 5000)
        child.on('error', error => { clearTimeout(timer); reject(error) })
        child.on('exit', code => { clearTimeout(timer); reject(new Error(`proxy exited: ${code}`)) })
        child.stdout.on('data', data => {
          buffer += data
          if (buffer.includes('proxy_started')) { clearTimeout(timer); resolve(buffer) }
        })
      })
      expect(JSON.parse(output.trim()).allowed_ports).toEqual([80, 443, 2055, 90])
      const response = await new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => socket.write('GET http://example.invalid/ HTTP/1.1\r\nHost: example.invalid\r\nConnection: close\r\n\r\n'))
        let data = ''
        socket.setTimeout(2000, () => socket.destroy(new Error('response timed out')))
        socket.on('data', chunk => { data += chunk })
        socket.on('end', () => resolve(data))
        socket.on('error', reject)
      })
      expect(response).toContain('407')
    } finally {
      if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited }
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
