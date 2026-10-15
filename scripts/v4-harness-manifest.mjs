#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'worker/harness/code-review-acp/v4-capability-contract.json')
const migrationsDir = join(root, 'supabase/migrations')

function fail(message) {
  console.error(`V4 Harness manifest error: ${message}`)
  process.exit(1)
}

function compareCanonicalText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.entries(value)
    .sort(([a], [b]) => compareCanonicalText(a, b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`
}

function sortedRecord(record) {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => compareCanonicalText(a, b)))
}

function semanticManifest(manifest) {
  return {
    manifestRevision: manifest.manifestRevision,
    contractVersion: manifest.contractVersion,
    harnessVersion: manifest.harnessVersion,
    bundles: [...manifest.bundles].sort(),
    defaultPolicy: manifest.defaultPolicy,
    enabledPlugins: [...manifest.enabledPlugins].sort(),
    disabledPlugins: [...manifest.disabledPlugins].sort(),
    platformPlugins: [...manifest.platformPlugins].sort(),
    modelTools: sortedRecord(manifest.modelTools),
    roleTools: Object.fromEntries(
      Object.entries(manifest.roleTools).map(([role, tools]) => [role, [...tools].sort()]),
    ),
    brokerRoutes: sortedRecord(manifest.brokerRoutes),
    errorCodes: [...manifest.errorCodes].sort(),
  }
}

function loadManifest() {
  const raw = readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(raw)
  if (!Number.isInteger(manifest.manifestRevision) || manifest.manifestRevision < 1) {
    fail('manifestRevision must be a positive integer')
  }
  if (manifest.contractVersion !== 4 || manifest.defaultPolicy?.version !== 4) {
    fail('contractVersion and defaultPolicy.version must both be 4')
  }
  if (!manifest.defaultPolicy?.capabilities) fail('defaultPolicy.capabilities is required')
  const disabled = Object.entries(manifest.defaultPolicy.capabilities)
    .filter(([, enabled]) => enabled !== true)
    .map(([capability]) => capability)
  if (disabled.length) fail(`all default capabilities must be true: ${disabled.join(', ')}`)

  const semantic = semanticManifest(manifest)
  return {
    raw,
    manifest,
    manifestHash: createHash('sha256').update(stableStringify(semantic)).digest('hex'),
    sourceHash: createHash('sha256').update(raw).digest('hex'),
    policyJson: JSON.stringify(manifest.defaultPolicy),
  }
}

function migrationMetadataFiles() {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => ({ name, text: readFileSync(join(migrationsDir, name), 'utf8') }))
    .map((file) => ({
      ...file,
      revision: Number(file.text.match(/^-- v4-manifest-revision: (\d+)$/m)?.[1] ?? 0),
    }))
    .filter((file) => file.revision > 0)
    .sort((a, b) => b.revision - a.revision)
}

function check() {
  const current = loadManifest()
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const dshDependencies = Object.entries(pkg.dependencies ?? {}).filter(([name]) =>
    name.startsWith('@deepseek-ai/dsh'),
  )
  const mismatchedDsh = dshDependencies.filter(([, version]) => version !== current.manifest.harnessVersion)
  if (mismatchedDsh.length > 0) {
    fail(`all direct @deepseek-ai/dsh* dependencies must equal harnessVersion: ${mismatchedDsh.map(([name, version]) => `${name}@${version}`).join(', ')}`)
  }

  const profile = JSON.parse(
    readFileSync(join(root, 'worker/harness/code-review-acp/package.json'), 'utf8'),
  )
  if (stableStringify(profile.dsh?.profile?.bundles ?? []) !== stableStringify(current.manifest.bundles)) {
    fail('profile bundles differ from manifest.bundles')
  }
  const expectedPlatformPackages = current.manifest.platformPlugins
    .map((id) => `@codereview/harness-${id}`)
    .sort()
  const actualPlatformPackages = Object.keys(profile.dependencies ?? {}).sort()
  if (stableStringify(actualPlatformPackages) !== stableStringify(expectedPlatformPackages)) {
    fail('profile platform plugin dependencies differ from manifest.platformPlugins')
  }

  const patch = readFileSync(join(root, 'worker/harness/code-review-acp/cordis.patch.yml'), 'utf8')
  for (const id of current.manifest.platformPlugins) {
    if (!new RegExp(`(?:^|\\n)\\s*-?\\s*id:\\s*${id}\\s*(?:\\n|$)`).test(patch)) {
      fail(`cordis.patch.yml does not declare platform plugin ${id}`)
    }
  }
  const explicitlyDisabled = [...patch.matchAll(/^\s*- id:\s*([A-Za-z0-9._-]+)\s*\n\s*disabled:\s*true\s*$/gm)]
    .map((match) => match[1])
  const untrackedDisabled = explicitlyDisabled.filter((id) => !current.manifest.disabledPlugins.includes(id))
  if (untrackedDisabled.length > 0) {
    fail(`cordis.patch.yml disables plugins absent from manifest.disabledPlugins: ${untrackedDisabled.join(', ')}`)
  }
  const missingDisabled = current.manifest.disabledPlugins.filter(
    (id) => !explicitlyDisabled.includes(id),
  )
  if (missingDisabled.length > 0) {
    fail(`manifest.disabledPlugins are not explicitly disabled in cordis.patch.yml: ${missingDisabled.join(', ')}`)
  }
  const enabledButDisabled = current.manifest.enabledPlugins.filter((id) =>
    explicitlyDisabled.includes(id),
  )
  if (enabledButDisabled.length > 0) {
    fail(`manifest.enabledPlugins are disabled in cordis.patch.yml: ${enabledButDisabled.join(', ')}`)
  }

  // Local development builds use Dockerfile.worker. The company CI image uses
  // Dockerfile.workercompany; pass that filename explicitly during its build
  // instead of copying a second Dockerfile into the image only for this check.
  const dockerfileName = process.env.WORKER_DOCKERFILE || 'Dockerfile.worker'
  if (dockerfileName.includes('/') || dockerfileName.includes('\\')) {
    fail('WORKER_DOCKERFILE must be a Dockerfile name in the repository root')
  }
  const dockerfile = readFileSync(join(root, dockerfileName), 'utf8')
  const dockerPluginList = dockerfile.match(/for plugin in ([^;]+); do/)?.[1]?.trim().split(/\s+/).sort() ?? []
  if (stableStringify(dockerPluginList) !== stableStringify([...current.manifest.platformPlugins].sort())) {
    fail('Docker platform plugin links differ from manifest.platformPlugins')
  }

  const migrations = migrationMetadataFiles()
  const duplicateRevisions = migrations.filter(
    (file, index) => migrations.findIndex((candidate) => candidate.revision === file.revision) !== index,
  )
  if (duplicateRevisions.length > 0) fail('duplicate V4 manifest revisions exist in migrations')
  const latest = migrations[0]
  if (!latest) fail('no generated V4 manifest migration found')
  if (latest.revision !== current.manifest.manifestRevision) {
    fail(`latest DB revision is ${latest.revision}, manifest is ${current.manifest.manifestRevision}; generate a migration`)
  }
  if (!latest.text.includes(`-- v4-manifest-hash: ${current.manifestHash}`)) {
    fail('latest DB migration manifest hash is stale')
  }
  const escapedPolicy = current.policyJson.replaceAll("'", "''")
  if (!latest.text.includes(`'${escapedPolicy}'::jsonb`)) {
    fail('latest DB migration default policy differs from the canonical manifest')
  }
  console.log(
    `V4 Harness manifest OK: revision ${current.manifest.manifestRevision}, Harness ${current.manifest.harnessVersion}, ${Object.keys(current.manifest.modelTools).length} tools`,
  )
}

/** `YYYYMMDDHHMMSS`（UTC）。迁移文件名的唯一合法前缀形式。 */
function utcStamp(now = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  )
}

/**
 * 生成下一份 manifest 迁移。
 *
 * 文件名**必须**是时间戳前缀，不再接受四位序号。这不是命名偏好：迁移按**字典序**应用，
 * 而 `0042_*` 排在 `2026...` **之前**（`'0' < '2'`）。于是一个四位序号的 manifest 迁移会
 * 在同批次的时间戳迁移**之前**执行 —— 对本仓库就意味着"先切契约、后建表"，正好落进
 * OPERATIONS §17.2 警告的那个空档：契约哈希对上了，但新 RPC 还不存在。
 *
 * 不传参数就按当前 UTC 时间生成；显式传值必须是 14 位时间戳。两种情况都必须严格大于
 * 目录里现有的最大文件名，否则新迁移会插到已有迁移之前。
 */
function generateMigration(stamp) {
  const chosen = stamp === undefined || stamp === '' ? utcStamp() : stamp
  if (!/^\d{14}$/.test(chosen)) {
    fail(
      'usage: npm run harness:manifest:new-migration [-- <14-digit UTC timestamp>]\n' +
        '       migration names must be timestamp-prefixed; four-digit numbers sort before them',
    )
  }
  const current = loadManifest()
  const manifestMigrations = migrationMetadataFiles()
  const latestRevision = manifestMigrations[0]?.revision ?? 0
  if (current.manifest.manifestRevision !== latestRevision + 1) {
    fail(`manifestRevision must be ${latestRevision + 1} before generating the next migration`)
  }
  const allMigrationNames = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'))
  if (allMigrationNames.some((name) => name.startsWith(`${chosen}_`))) {
    fail(`migration ${chosen} already exists`)
  }
  // 字典序守卫：新名字必须排在现有全部迁移之后，包括历史上的四位序号文件。
  const latestName = [...allMigrationNames].sort().at(-1) ?? ''
  const candidate = `${chosen}_v4_harness_manifest_r${current.manifest.manifestRevision}.sql`
  if (latestName !== '' && candidate <= latestName) {
    fail(`migration name ${candidate} must sort after the current latest ${latestName}`)
  }
  const output = join(migrationsDir, candidate)
  if (existsSync(output)) fail(`${output} already exists`)
  const escapedPolicy = current.policyJson.replaceAll("'", "''")
  const sql = `-- Generated from worker/harness/code-review-acp/v4-capability-contract.json.\n-- Do not edit the policy JSON by hand.\n-- v4-manifest-revision: ${current.manifest.manifestRevision}\n-- v4-manifest-source-sha256: ${current.sourceHash}\n-- v4-manifest-hash: ${current.manifestHash}\n\nbegin;\n\nupdate public.v4_harness_manifest set is_active = false where is_active;\ninsert into public.v4_harness_manifest (\n  manifest_revision, contract_version, harness_version, manifest_hash, default_policy, is_active\n) values (\n  ${current.manifest.manifestRevision}, ${current.manifest.contractVersion}, '${current.manifest.harnessVersion}',\n  '${current.manifestHash}',\n  '${escapedPolicy}'::jsonb,\n  true\n);\n\ncommit;\n`
  writeFileSync(output, sql, { flag: 'wx' })
  console.log(`Created ${output}`)
}

const [command = 'check', argument] = process.argv.slice(2)
if (command === 'check') check()
else if (command === 'generate-migration') generateMigration(argument)
else fail(`unknown command: ${command}`)
