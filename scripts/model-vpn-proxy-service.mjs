#!/usr/bin/env node
/** One installer for macOS launchd and Windows Task Scheduler. No third-party dependencies. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEFAULT_PROXY_PORTS } from './model-vpn-proxy-config.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = path.dirname(path.dirname(scriptPath))
const label = 'com.codereviewplatform.model-vpn-proxy'
const taskName = 'codereviewplatform-model-vpn-proxy'
const watchdogTaskName = 'codereviewplatform-model-vpn-proxy-watchdog'
const legacyTaskName = 'CodeReviewPlatform-ModelVpnProxy'
const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`
export const xmlEscape = (value) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c])

export function parseEnv(text) {
  const result = {}
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (match) result[match[1]] = match[2]
  }
  return result
}

export function buildConfig(workerEnv, env = process.env) {
  const port = Number(env.MODEL_VPN_PROXY_PORT ?? '17890')
  const ports = env.MODEL_VPN_PROXY_ALLOWED_PORTS ?? DEFAULT_PROXY_PORTS
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid MODEL_VPN_PROXY_PORT')
  if (!ports.split(',').every(p => /^\d+$/.test(p.trim()) && Number(p) > 0 && Number(p) < 65536)) {
    throw new Error('Invalid MODEL_VPN_PROXY_ALLOWED_PORTS')
  }
  const config = {
    MODEL_VPN_PROXY_BIND: env.MODEL_VPN_PROXY_BIND ?? '127.0.0.1',
    MODEL_VPN_PROXY_PORT: String(port),
    MODEL_VPN_PROXY_ALLOWED_PORTS: ports,
    MODEL_VPN_PROXY_USERNAME: workerEnv.MODEL_CONNECTIVITY_PROXY_USERNAME || 'worker',
    MODEL_VPN_PROXY_PASSWORD: workerEnv.MODEL_CONNECTIVITY_PROXY_PASSWORD || crypto.randomBytes(24).toString('hex'),
    MODEL_VPN_PROXY_UPSTREAM_TIMEOUT_MS: env.MODEL_VPN_PROXY_UPSTREAM_TIMEOUT_MS ?? '300000',
  }
  if (Object.values(config).some(v => /[\r\n\0]/.test(v))) throw new Error('Proxy settings must be single-line values')
  return config
}

export function updateWorkerEnv(text, config) {
  const settings = {
    MODEL_CONNECTIVITY_PROXY_URL: `http://host.docker.internal:${config.MODEL_VPN_PROXY_PORT}`,
    MODEL_CONNECTIVITY_PROXY_USERNAME: config.MODEL_VPN_PROXY_USERNAME,
    MODEL_CONNECTIVITY_PROXY_PASSWORD: config.MODEL_VPN_PROXY_PASSWORD,
  }
  const kept = text.split(/\r?\n/).filter(line => !Object.hasOwn(settings, line.split('=', 1)[0]))
  return kept.join('\n').trimEnd() + '\n' + Object.entries(settings).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
}

function command(executable, args, optional = false) {
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true })
  if ((result.error || result.status !== 0) && !optional) {
    throw new Error(`${executable} failed: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`)
  }
  return result
}
function powershell(source) {
  return command('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference = 'Stop'\n${source}`, 'utf16le').toString('base64')])
}
function protectWindowsDirectory(dir) {
  // Establish a private ACL before writing credentials. SYSTEM retains maintenance access.
  powershell(`$dir = ${psQuote(dir)}
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
foreach ($id in @($sid, [System.Security.Principal.SecurityIdentifier]'S-1-5-18')) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($id, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $dir -AclObject $acl`)
}

export function launchdPlist(node, installer, configPath, logDir) {
  const string = value => `<string>${xmlEscape(value)}</string>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string(label)}
<key>ProgramArguments</key><array>${[node, installer, 'run', configPath].map(string).join('')}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key>${string(path.join(logDir, 'model-vpn-proxy.log'))}
<key>StandardErrorPath</key>${string(path.join(logDir, 'model-vpn-proxy.error.log'))}
</dict></plist>\n`
}

function powershellEncodedArguments(source) {
  return `-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(source, 'utf16le').toString('base64')}`
}

/**
 * Windows watchdog: only restarts the primary task when the loopback proxy port
 * cannot accept a TCP connection. This makes a graceful/external process exit
 * recoverable even when Task Scheduler does not classify it as a failure.
 */
export function windowsWatchdogScript(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid MODEL_VPN_PROXY_PORT')
  return `$port = ${port}
if (-not (Test-NetConnection -ComputerName '127.0.0.1' -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue)) {
  $proxyTask = Get-ScheduledTask -TaskPath '\\' -TaskName ${psQuote(taskName)} -ErrorAction Stop
  if ($proxyTask.State -eq 'Running') {
    Stop-ScheduledTask -InputObject $proxyTask -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
  Start-ScheduledTask -TaskPath '\\' -TaskName ${psQuote(taskName)}
}`
}

export function windowsInstallScript(node, installer, configPath, root, port = 17890) {
  const args = [installer, 'run', configPath].map(v => `"${v}"`).join(' ')
  const watchdogArgs = powershellEncodedArguments(windowsWatchdogScript(port))
  return `$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute ${psQuote(node)} -Argument ${psQuote(args)} -WorkingDirectory ${psQuote(root)}
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$old = Get-ScheduledTask -TaskPath '\\' -TaskName ${psQuote(taskName)} -ErrorAction SilentlyContinue
if ($old) { Stop-ScheduledTask -InputObject $old }
Register-ScheduledTask -TaskPath '\\' -TaskName ${psQuote(taskName)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
$watchdogAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${psQuote(watchdogArgs)} -WorkingDirectory ${psQuote(root)}
$watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$watchdogSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$oldWatchdog = Get-ScheduledTask -TaskPath '\\' -TaskName ${psQuote(watchdogTaskName)} -ErrorAction SilentlyContinue
if ($oldWatchdog) { Stop-ScheduledTask -InputObject $oldWatchdog }
Register-ScheduledTask -TaskPath '\\' -TaskName ${psQuote(watchdogTaskName)} -Action $watchdogAction -Trigger $watchdogTrigger -Principal $principal -Settings $watchdogSettings -Force | Out-Null
# Keep the alternate task for recovery, but remove its login trigger from service.
$legacy = Get-ScheduledTask -TaskPath '\\' -TaskName ${psQuote(legacyTaskName)} -ErrorAction SilentlyContinue
if ($legacy) {
  Disable-ScheduledTask -InputObject $legacy | Out-Null
  Stop-ScheduledTask -InputObject $legacy
}
Start-ScheduledTask -TaskPath '\\' -TaskName ${psQuote(taskName)}`
}

async function main(action, suppliedConfig) {
  if (!['install', 'uninstall', 'run'].includes(action)) {
    throw new Error('Usage: node scripts/model-vpn-proxy-service.mjs install|uninstall')
  }
  if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Supported hosts: macOS and Windows')
  const windows = process.platform === 'win32'
  const stateDir = windows
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'CodeReviewPlatform', 'model-vpn-proxy')
    : path.join(os.homedir(), 'Library', 'Application Support', 'codereviewplatform', 'model-vpn-proxy')
  const logDir = windows ? stateDir : path.join(os.homedir(), 'Library', 'Logs', 'codereviewplatform')
  const configPath = path.join(stateDir, 'config.json')
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`)

  if (action === 'run') {
    // Read before importing the proxy, whose options are evaluated at module load.
    const config = JSON.parse(fs.readFileSync(suppliedConfig || configPath, 'utf8'))
    for (const [key, value] of Object.entries(config)) {
      if (key.startsWith('MODEL_VPN_PROXY_') && typeof value === 'string') process.env[key] = value
    }
    fs.mkdirSync(logDir, { recursive: true })
    // In-process startup lets Task Scheduler stop the actual proxy, without orphan children.
    if (windows) {
      const log = fs.createWriteStream(path.join(logDir, 'model-vpn-proxy.log'), { flags: 'a' })
      console.log = (...items) => log.write(items.join(' ') + '\n')
      console.error = (...items) => log.write(items.join(' ') + '\n')
    }
    const { startProxy } = await import('./model-vpn-proxy.mjs')
    startProxy()
    return
  }
  if (action === 'uninstall') {
    if (windows) {
      powershell(`foreach ($name in @(${psQuote(taskName)}, ${psQuote(watchdogTaskName)}, ${psQuote(legacyTaskName)})) {
  $task = Get-ScheduledTask -TaskPath '\\' -TaskName $name -ErrorAction SilentlyContinue
  if ($task) { Stop-ScheduledTask -InputObject $task; Disable-ScheduledTask -InputObject $task | Out-Null }
}`)
    } else {
      command('launchctl', ['bootout', `gui/${process.getuid()}/${label}`], true)
      fs.rmSync(plist, { force: true })
    }
    console.log('Proxy service disabled. Credentials, logs and Worker configuration retained for reinstall.')
    return
  }

  const workerFile = path.join(repoRoot, '.docker', 'worker.env')
  if (!fs.existsSync(workerFile)) throw new Error('Missing .docker/worker.env; copy .docker/worker.env.example first')
  const text = fs.readFileSync(workerFile, 'utf8')
  const config = buildConfig(parseEnv(text))
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  if (windows) protectWindowsDirectory(stateDir)
  else fs.chmodSync(stateDir, 0o700)
  fs.mkdirSync(logDir, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  fs.writeFileSync(workerFile, updateWorkerEnv(text, config), { mode: 0o600 })
  if (!windows) { fs.chmodSync(configPath, 0o600); fs.chmodSync(workerFile, 0o600) }
  if (windows) {
    powershell(windowsInstallScript(process.execPath, scriptPath, configPath, repoRoot, Number(config.MODEL_VPN_PROXY_PORT)))
  } else {
    fs.mkdirSync(path.dirname(plist), { recursive: true })
    fs.writeFileSync(plist, launchdPlist(process.execPath, scriptPath, configPath, logDir), { mode: 0o600 })
    command('launchctl', ['bootout', `gui/${process.getuid()}/${label}`], true)
    command('launchctl', ['enable', `gui/${process.getuid()}/${label}`])
    command('launchctl', ['bootstrap', `gui/${process.getuid()}`, plist])
  }
  console.log(`Service installed; startup requested on ${config.MODEL_VPN_PROXY_BIND}:${config.MODEL_VPN_PROXY_PORT}. Allowed ports: ${config.MODEL_VPN_PROXY_ALLOWED_PORTS}`)
  console.log(`Logs: ${logDir}`)
  console.log('Verify proxy_started in logs and test Linky/model connectivity. Restart Workers if their proxy settings changed.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main(process.argv[2], process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1 })
}
