/**
 * V1.6 Skill Bundle 供给链测试。
 *
 * 覆盖方案 §19 的验收标准，按"哪一条被证明了"组织：
 *
 *   §19.2  根 SKILL.md 缺失或歧义入口拒绝；V1.51 兼容唯一一层外层目录
 *   §19.3  Zip Slip、绝对路径、`..`、重复规范路径、symlink、特殊文件、Zip Bomb
 *   §19.7  cache miss 下载一次；cache hit 不重复下载且复核 manifest
 *   §19.8  完整文件树物化到 DSH_HOME/skills/<name>，不写代码 Workspace
 *   §19.12 脚本不因加载而执行；物化后不带 executable bit
 *   §19.13 Workspace 中同名项目 Skill 无法覆盖平台 Bundle（skill-filesystem 隔离）
 *   §19.15 Worker 重启按相同 Job snapshot 重建；hash 不一致拒绝恢复
 *   §19.16 单包 / 全目录 / 压缩比 / 文件数 / 时间上限一律 fail closed
 *
 * 三层 hash 的**跨语言一致性**（SQL 与 TypeScript 算出同一个值）由
 * `supabase/tests/20260917100000_managed_dsh_skill_bundles_test.sql` 与本文件共用的
 * 规范格式保证，并在那份 SQL 测试里直接断言。
 */

import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertContained,
  assertNoPathConflicts,
  canonicalizeEntryPath,
} from '../ai/skills/skill-paths.js'
import {
  SkillBundleInvalidError,
  SkillBundleLimitError,
  validateSkillArchive,
} from '../ai/skills/bundle-validator.js'
import { SKILL_BUNDLE_LIMITS, SKILL_CATALOG_LIMITS } from '../ai/skills/skill-limits.js'
import {
  bundleHashDirName,
  catalogHashFromBundles,
  computeBundleHash,
  computeCatalogHash,
  emptyCatalogHash,
  roleForPath,
  sha256Prefixed,
  type FrozenSkillBundle,
} from '../ai/skills/skill-manifest.js'
import { SkillCache } from '../ai/skills/skill-cache.js'
import { materializeSkillTree, relaxSkillTree } from '../ai/skills/skill-materializer.js'
import {
  parseFrozenSkillCatalog,
  provisionSkillCatalog,
  resolveCatalogLimits,
} from '../ai/skills/skill-provisioner.js'
import { SKILL_ERROR_CODES, SkillGovernanceError } from '../ai/skills/skill-errors.js'
import { assertFrozenObjectKey, type SkillStorageClient } from '../ai/skills/skill-storage.js'
import { evaluateResume, type ResumeCandidate } from '../ai/session/session-recovery.js'
import { V4_ERROR_CODES } from '../ai/policy/v4-errors.js'
import {
  assertPatchHasNoCredentials,
  buildAttemptPatch,
  computeConfigHash,
  resolveProfileTemplateDir,
  type AttemptProfileSpec,
} from '../ai/acp/profile-materializer.js'
import { V4_DEFAULT_POLICY } from '../ai/policy/v4-capability-policy.js'
import { describeSkillResourceAccess } from '../harness-plugins/agent-authority-policy/index.js'
import {
  buildZip,
  pngBytes,
  UNIX_MODE,
  validBundleEntries,
  validEntryMarkdown,
} from './helpers/zip-builder.js'

const SKILL_NAME = 'bos-bill-review'
const PATH_LIMITS = { pathBytes: SKILL_BUNDLE_LIMITS.pathBytes, pathDepth: SKILL_BUNDLE_LIMITS.pathDepth }

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function validate(entries: Parameters<typeof buildZip>[0], name = SKILL_NAME) {
  return validateSkillArchive({ archive: buildZip(entries), expectedSkillName: name })
}

// ---------------------------------------------------------------------------
// §7.2 路径规则
// ---------------------------------------------------------------------------

describe('skill bundle path rules', () => {
  it('accepts a canonical relative path', () => {
    expect(canonicalizeEntryPath('references/domain-model.md', PATH_LIMITS)).toEqual({
      path: 'references/domain-model.md',
      isDirectory: false,
    })
  })

  it('reports directory entries so the caller can skip them', () => {
    expect(canonicalizeEntryPath('references/', PATH_LIMITS).isDirectory).toBe(true)
  })

  it.each([
    ['absolute path', '/etc/passwd'],
    ['parent traversal', '../../etc/passwd'],
    ['embedded traversal', 'references/../../escape.md'],
    ['backslash separator', 'references\\domain.md'],
    ['windows drive letter', 'C:/skills/SKILL.md'],
    ['UNC path', '//host/share/SKILL.md'],
    ['NUL byte', 'SKILL.md\u0000.png'],
    ['empty segment', 'references//domain.md'],
    ['single dot segment', 'references/./domain.md'],
    ['leading space', ' SKILL.md'],
    ['trailing space', 'SKILL.md '],
    ['non-ASCII', 'references/域模型.md'],
  ])('rejects %s', (_label, name) => {
    expect(() => canonicalizeEntryPath(name, PATH_LIMITS)).toThrow()
  })

  it('rejects a path deeper than the configured limit', () => {
    const deep = `${'a/'.repeat(SKILL_BUNDLE_LIMITS.pathDepth)}x.md`
    expect(() => canonicalizeEntryPath(deep, PATH_LIMITS)).toThrow(/deeper than/)
  })

  it('rejects a path longer than the configured byte limit', () => {
    const long = `references/${'a'.repeat(SKILL_BUNDLE_LIMITS.pathBytes)}.md`
    expect(() => canonicalizeEntryPath(long, PATH_LIMITS)).toThrow(/longer than/)
  })

  it('rejects duplicate and case-folded duplicate paths', () => {
    expect(() => assertNoPathConflicts(['SKILL.md', 'SKILL.md'])).toThrow(/duplicate/)
    // 大小写不敏感的文件系统上这两个 entry 会互相覆盖：bundle hash 相同、磁盘内容不同。
    expect(() => assertNoPathConflicts(['SKILL.md', 'skill.md'])).toThrow(/case is normalized/)
  })

  it('refuses a target that escapes the bundle root even after resolution', () => {
    expect(() => assertContained('/cache/abc/files', '../../../etc/cron.d/x')).toThrow(/escapes/)
    expect(assertContained('/cache/abc/files', 'references/a.md')).toBe(
      '/cache/abc/files/references/a.md',
    )
  })
})

// ---------------------------------------------------------------------------
// §6.2 / §7.3 / §8.1 归档准入
// ---------------------------------------------------------------------------

describe('skill archive validation', () => {
  it('produces a canonical manifest for a legal multi-file bundle', () => {
    const result = validate(validBundleEntries())
    expect(result.manifest.skillName).toBe(SKILL_NAME)
    expect(result.manifest.entry).toBe('SKILL.md')
    expect(result.fileCount).toBe(6)
    expect(result.containsScripts).toBe(true)
    // 角色与 mediaType 由**规范路径**推导，绝不由上传方声明。
    expect(result.manifest.files.map((file) => [file.path, file.role, file.mediaType])).toEqual([
      ['SKILL.md', 'ENTRY', 'text/markdown'],
      ['assets/flow.png', 'ASSET', 'image/png'],
      ['references/domain-model.md', 'REFERENCE', 'text/markdown'],
      ['references/rules.yaml', 'REFERENCE', 'application/yaml'],
      ['scripts/inspect.sh', 'SCRIPT', 'application/x-sh'],
      ['templates/checklist.md', 'TEMPLATE', 'text/markdown'],
    ])
    // 目录 entry 不进 manifest：目录由文件路径隐含创建。
    expect(result.manifest.files.some((file) => file.path.endsWith('/'))).toBe(false)
    expect(result.bundleHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(result.bundleHash).toBe(computeBundleHash(result.manifest))
  })

  it('rejects an archive without SKILL.md at the root (§19.2)', () => {
    expect(() =>
      validate([{ name: 'references/domain-model.md', content: '# domain\n' }]),
    ).toThrow(SkillBundleInvalidError)
  })

  it('accepts a single outer directory and materializes root-relative paths (V1.51)', () => {
    const result = validate([
      { name: `${SKILL_NAME}/`, content: '' },
      { name: `${SKILL_NAME}/SKILL.md`, content: validEntryMarkdown() },
    ])
    expect(result.files.map((file) => file.path)).toEqual(['SKILL.md'])
  })

  it('rejects an empty SKILL.md', () => {
    expect(() => validate([{ name: 'SKILL.md', content: '' }])).toThrow(/SKILL\.md is empty/)
  })

  it('rejects a SKILL.md without YAML frontmatter (§19.2)', () => {
    // 这是最危险的一种非法输入：dsh 只写一行 warn 就忽略整个技能，平台侧没有任何错误码。
    expect(() =>
      validate([{ name: 'SKILL.md', content: '# no frontmatter here\n' }]),
    ).toThrow(/must start with "---"/)
  })

  it.each([
    ['unclosed frontmatter', '---\nname: bos-bill-review\ndescription: x\n# body\n'],
    ['missing description', '---\nname: bos-bill-review\n---\n# body\n'],
    ['missing name', '---\ndescription: x\n---\n# body\n'],
    ['empty description', '---\nname: bos-bill-review\ndescription:\n---\n# body\n'],
    ['nested structure', '---\nname: bos-bill-review\ndescription: x\nmetadata:\n  a: b\n---\n# body\n'],
    ['no body', '---\nname: bos-bill-review\ndescription: x\n---\n\n'],
    ['duplicate field', '---\nname: bos-bill-review\nname: other\ndescription: x\n---\n# body\n'],
    ['legacy camelCase key', '---\nname: bos-bill-review\ndescription: x\nuserInvocable: true\n---\n# body\n'],
    ['non-boolean invocation flag', '---\nname: bos-bill-review\ndescription: x\nuser-invocable: maybe\n---\n# body\n'],
    ['model invocation disabled', '---\nname: bos-bill-review\ndescription: x\ndisable-model-invocation: true\n---\n# body\n'],
  ])('rejects frontmatter with %s (§19.2)', (_label, markdown) => {
    expect(() => validate([{ name: 'SKILL.md', content: markdown }])).toThrow(
      SkillBundleInvalidError,
    )
  })

  it('rejects a frontmatter name that differs from the platform skill name', () => {
    // dsh 会把技能注册成 frontmatter 里的名字，于是冻结目录的身份与模型看到的名字分叉：
    // catalog hash、审计归因和 `skill(name)` 调用全部对不上。
    expect(() =>
      validate([{ name: 'SKILL.md', content: validEntryMarkdown('another-skill') }]),
    ).toThrow(/must equal the platform skill name/)
  })

  it('returns the frontmatter as the single source of description', () => {
    const result = validate(validBundleEntries())
    expect(result.frontmatter.name).toBe(SKILL_NAME)
    expect(result.frontmatter.description).toContain('BOS 单据')
    expect(result.frontmatter.whenToUse).toBe('评审 BOS 单据相关需求时')
  })

  it.each([
    ['symlink', UNIX_MODE.symlink],
    ['fifo', UNIX_MODE.fifo],
    ['device', UNIX_MODE.device],
    ['socket', UNIX_MODE.socket],
  ])('rejects a %s entry (§19.3)', (_label, mode) => {
    expect(() =>
      validate([
        { name: 'SKILL.md', content: validEntryMarkdown() },
        { name: 'references/link.md', content: '../../etc/passwd', unixMode: mode },
      ]),
    ).toThrow(SkillBundleInvalidError)
  })

  it('treats an archive with no mode bits as regular files', () => {
    // Windows 打的包没有 st_mode。它表达不了 symlink，所以按普通文件处理是安全的。
    const result = validate([
      { name: 'SKILL.md', content: validEntryMarkdown(), unixMode: 0 },
      { name: 'references/a.md', content: 'x\n', unixMode: 0 },
    ])
    expect(result.fileCount).toBe(2)
  })

  it('rejects a zip slip entry (§19.3)', () => {
    expect(() =>
      validate([
        { name: 'SKILL.md', content: validEntryMarkdown() },
        { name: '../../etc/cron.d/pwn', content: 'x\n' },
      ]),
    ).toThrow(SkillBundleInvalidError)
  })

  it('rejects duplicate entries (§19.3)', () => {
    expect(() =>
      validate([
        { name: 'SKILL.md', content: validEntryMarkdown() },
        { name: 'references/a.md', content: '1\n' },
        { name: 'references/a.md', content: '2\n' },
      ]),
    ).toThrow(/duplicate entry path/)
  })

  it('rejects an encrypted archive', () => {
    expect(() =>
      validate([{ name: 'SKILL.md', content: validEntryMarkdown(), flags: 0x1 }]),
    ).toThrow(/encrypted/)
  })

  it('rejects an entry whose CRC does not match its bytes', () => {
    expect(() =>
      validate([{ name: 'SKILL.md', content: validEntryMarkdown(), crcOverride: 0xdeadbeef }]),
    ).toThrow(/CRC32/)
  })

  it('rejects an entry whose declared size does not match its bytes', () => {
    expect(() =>
      validate([{ name: 'SKILL.md', content: validEntryMarkdown(), uncompressedSizeOverride: 999 }]),
    ).toThrow(SkillBundleInvalidError)
  })

  it('rejects a zip bomb by compression ratio (§19.3, §8.1)', () => {
    // 1 MiB 的零字节 deflate 到几 KiB，比值远超 20:1。
    const bomb = Buffer.alloc(1024 * 1024, 0x41)
    expect(() =>
      validate([
        { name: 'SKILL.md', content: validEntryMarkdown() },
        { name: 'references/bomb.txt', content: bomb, method: 8 },
      ]),
    ).toThrow(SkillBundleLimitError)
  })

  it('rejects a SKILL.md above the 64 KiB entry limit (§19.16)', () => {
    const big = validEntryMarkdown() + 'a'.repeat(SKILL_BUNDLE_LIMITS.entryFileBytes)
    expect(() => validate([{ name: 'SKILL.md', content: big }])).toThrow(SkillBundleLimitError)
  })

  it('rejects more entries than the configured limit (§19.16)', () => {
    const entries: Array<{ name: string; content: string }> = [
      { name: 'SKILL.md', content: validEntryMarkdown() },
    ]
    for (let index = 0; index <= SKILL_BUNDLE_LIMITS.entryCount; index++) {
      entries.push({ name: `references/f${index}.md`, content: 'x\n' })
    }
    expect(() => validate(entries)).toThrow(SkillBundleLimitError)
  })

  it('rejects an archive above the upload byte limit (§19.16)', () => {
    const archive = Buffer.alloc(SKILL_BUNDLE_LIMITS.archiveBytes + 1)
    expect(() =>
      validateSkillArchive({ archive, expectedSkillName: SKILL_NAME }),
    ).toThrow(SkillBundleLimitError)
  })

  it('rejects text that is not strict UTF-8', () => {
    expect(() =>
      validate([
        { name: 'SKILL.md', content: validEntryMarkdown() },
        { name: 'references/bad.md', content: Buffer.from([0xff, 0xfe, 0x00]) },
      ]),
    ).toThrow(/not valid UTF-8|NUL byte/)
  })

  it('rejects an asset whose bytes do not match its declared image type', () => {
    expect(() =>
      validate([
        { name: 'SKILL.md', content: validEntryMarkdown() },
        { name: 'assets/fake.png', content: '<html>not a png</html>' },
      ]),
    ).toThrow(/does not match its declared image type/)
  })

  it('rejects a script outside scripts/ because its role forbids the extension', () => {
    // 根目录的 `.sh` 落在 OTHER 角色上，而 OTHER 只允许文本类扩展名。于是脚本必须显式
    // 放进 scripts/，从而必然带上 contains_scripts 标记与发布页的额外确认。
    expect(roleForPath('inspect.sh')).toBe('OTHER')
    expect(() =>
      validate([
        { name: 'SKILL.md', content: validEntryMarkdown() },
        { name: 'inspect.sh', content: '#!/bin/sh\n' },
      ]),
    ).toThrow(/not allowed for its role/)
  })

  it.each(['assets/logo.svg', 'references/page.html', 'references/report.xlsx', 'bin/tool'])(
    'rejects the unlisted file type %s',
    (name) => {
      expect(() =>
        validate([
          { name: 'SKILL.md', content: validEntryMarkdown() },
          { name, content: 'x' },
        ]),
      ).toThrow(SkillBundleInvalidError)
    },
  )
})

// ---------------------------------------------------------------------------
// §7.1 三层 hash 的稳定性
// ---------------------------------------------------------------------------

describe('three-layer hash identity', () => {
  it('keeps the bundle hash stable across entry order and compression method', () => {
    const base = validBundleEntries()
    const reordered = [...base].reverse()
    const deflated = base.map((entry) => ({ ...entry, method: 8 as const }))
    const a = validate(base)
    const b = validate(reordered)
    const c = validate(deflated)
    expect(b.bundleHash).toBe(a.bundleHash)
    expect(c.bundleHash).toBe(a.bundleHash)
    // archive hash 反过来**必须**不同：它证明的是"字节是否完整"，不是逻辑内容。
    expect(c.archiveSha256).not.toBe(a.archiveSha256)
  })

  it('changes the bundle hash when a single resource byte changes', () => {
    const changed = validBundleEntries().map((entry) =>
      entry.name === 'references/domain-model.md' ? { ...entry, content: '# domain!\n' } : entry,
    )
    expect(validate(changed).bundleHash).not.toBe(validate(validBundleEntries()).bundleHash)
  })

  it('makes the catalog hash independent of enumeration order', () => {
    const entries = [
      { name: 'b-skill', version: 2, bundleHash: 'sha256:b'.padEnd(71, '0'), archiveSha256: 'sha256:1'.padEnd(71, '0') },
      { name: 'a-skill', version: 1, bundleHash: 'sha256:a'.padEnd(71, '0'), archiveSha256: 'sha256:2'.padEnd(71, '0') },
    ]
    expect(computeCatalogHash(entries)).toBe(computeCatalogHash([...entries].reverse()))
    expect(computeCatalogHash(entries)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('pins the empty catalog hash so historical jobs keep one stable identity (§19.20)', () => {
    // 这个常量同时出现在迁移的 `empty_skill_catalog_hash()` 里。它变了就意味着所有
    // 历史空技能 Job 的身份变了 —— 那必须是一次显式的、有意的迁移，不能是重构副作用。
    expect(emptyCatalogHash()).toBe(
      '68e1066195ea5e45438f0297d4408c32cdd3ed6d9571db897d20bea766e3a50b',
    )
    expect(computeCatalogHash([])).toBe(emptyCatalogHash())
  })

  it('derives the cache directory name from the bundle hash only', () => {
    expect(bundleHashDirName(`sha256:${'a'.repeat(64)}`)).toBe('a'.repeat(64))
    expect(() => bundleHashDirName('not-a-hash')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// §10 共享 cache
// ---------------------------------------------------------------------------

function publishFixture(cacheRoot: string, entries = validBundleEntries()) {
  const cache = new SkillCache({ cacheRoot })
  const archive = buildZip(entries)
  const validated = validateSkillArchive({ archive, expectedSkillName: SKILL_NAME })
  const entry = cache.publish({
    bundleHash: validated.bundleHash,
    manifest: validated.manifest,
    archive,
    files: validated.files,
  })
  return { cache, archive, validated, entry }
}

describe('shared skill cache', () => {
  it('publishes atomically and then reports a verified hit (§19.7)', () => {
    const cacheRoot = tempRoot('crp-skill-cache-')
    const { cache, validated, entry } = publishFixture(cacheRoot)
    expect(entry.hit).toBe(false)
    expect(existsSync(join(entry.root, 'manifest.json'))).toBe(true)
    expect(existsSync(join(entry.root, 'bundle.zip'))).toBe(true)
    expect(existsSync(join(entry.filesDir, 'SKILL.md'))).toBe(true)

    const hit = cache.lookup(validated.bundleHash)
    expect(hit?.hit).toBe(true)
    expect(hit?.manifest.skillName).toBe(SKILL_NAME)
  })

  it('publishes cache content read-only', () => {
    const cacheRoot = tempRoot('crp-skill-cache-ro-')
    const { entry } = publishFixture(cacheRoot)
    // 0400：cache 是"不可变的共享事实"。可写的共享事实不是事实。
    expect(statSync(join(entry.filesDir, 'SKILL.md')).mode & 0o777).toBe(0o400)
  })

  it('lets the loser of a publish race reuse the winner result', () => {
    const cacheRoot = tempRoot('crp-skill-cache-race-')
    const { cache, archive, validated } = publishFixture(cacheRoot)
    const second = cache.publish({
      bundleHash: validated.bundleHash,
      manifest: validated.manifest,
      archive,
      files: validated.files,
    })
    // 第二次 publish 的 rename 会失败（目标已存在），于是复用胜出者并报成命中。
    expect(second.hit).toBe(true)
    expect(second.root).toBe(join(cacheRoot, bundleHashDirName(validated.bundleHash)))
  })

  it('drops a cache entry whose manifest no longer matches its bundle hash', () => {
    const cacheRoot = tempRoot('crp-skill-cache-corrupt-')
    const { cache, validated, entry } = publishFixture(cacheRoot)
    chmodSync(entry.root, 0o700)
    chmodSync(join(entry.root, 'manifest.json'), 0o600)
    const tampered = JSON.parse(readFileSync(join(entry.root, 'manifest.json'), 'utf8'))
    tampered.files = tampered.files.slice(1)
    writeFileSync(join(entry.root, 'manifest.json'), JSON.stringify(tampered))

    // 复核失败 → 目录被删除并返回 null，让调用方走下载路径。留着它只会让下一个
    // attempt 再失败一次，而 cache 的全部内容都可以重新下载。
    expect(cache.lookup(validated.bundleHash)).toBeNull()
    expect(existsSync(entry.root)).toBe(false)
  })

  it('drops a cache entry whose entry file bytes were replaced', () => {
    const cacheRoot = tempRoot('crp-skill-cache-bytes-')
    const { cache, validated, entry } = publishFixture(cacheRoot)
    chmodSync(entry.root, 0o700)
    chmodSync(entry.filesDir, 0o700)
    const target = join(entry.filesDir, 'SKILL.md')
    const original = readFileSync(target)
    chmodSync(target, 0o600)
    // 同样长度、不同内容：尺寸校验放行，逐字节 hash 抓住它。
    writeFileSync(target, Buffer.alloc(original.length, 0x58))
    expect(cache.lookup(validated.bundleHash)).toBeNull()
  })

  it('reclaims by capacity while keeping the bundles this attempt needs', () => {
    const cacheRoot = tempRoot('crp-skill-cache-lru-')
    const { cache, validated } = publishFixture(cacheRoot)
    const keepDir = bundleHashDirName(validated.bundleHash)
    // 上限设成 1 字节：除被 keep 的目录以外全部应当被回收。
    const before = cache.reclaim({ maxBytes: 1, keep: new Set([keepDir]) })
    expect(before.removed).toBe(0)
    expect(existsSync(join(cacheRoot, keepDir))).toBe(true)
    // 不保护它时才回收 —— 证明 keep 真的在起作用，而不是"恰好没删"。
    const after = cache.reclaim({ maxBytes: 1 })
    expect(after.removed).toBe(1)
    expect(existsSync(join(cacheRoot, keepDir))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// §11 per-attempt 物化
// ---------------------------------------------------------------------------

describe('per-attempt materialization', () => {
  function frozen(validated: ReturnType<typeof validateSkillArchive>): FrozenSkillBundle {
    return {
      snapshotId: 'snap-1',
      name: SKILL_NAME,
      description: 'bill review',
      version: 1,
      archiveBucket: 'skill-bundles',
      archiveObjectKey: `${'0'.repeat(8)}-0000-0000-0000-000000000000/versions/1/${validated.archiveSha256.slice(7)}.zip`,
      archiveSha256: validated.archiveSha256,
      archiveSizeBytes: validated.archiveSizeBytes,
      bundleHash: validated.bundleHash,
      bundleManifest: validated.manifest,
      expandedSizeBytes: validated.expandedSizeBytes,
      containsScripts: validated.containsScripts,
    }
  }

  it.each(['root', 'Mac', 'Windows'])('copies the %s bundle tree into DSH_HOME/skills/<name> (§19.8)', (style) => {
    const cacheRoot = tempRoot('crp-skill-mat-cache-')
    const dshHome = tempRoot('crp-skill-mat-home-')
    const entries = style === 'root' ? validBundleEntries() : [
      { name: 'bundle/', content: '' },
      ...validBundleEntries().map((e) => ({ ...e, name: 'bundle/' + e.name, ...(style === 'Windows' ? { unixMode: 0 } : {}) })),
      { name: style === 'Mac' ? '__MACOSX/bundle/._SKILL.md' : 'bundle/desktop.ini', content: 'metadata' },
    ]
    const { validated, entry } = publishFixture(cacheRoot, entries)
    const tree = materializeSkillTree({
      dshHome,
      bundles: [{ bundle: frozen(validated), cache: entry }],
    })

    expect(tree.skillsDir).toBe(join(dshHome, 'skills'))
    const skillDir = join(tree.skillsDir, SKILL_NAME)
    for (const relative of [
      'SKILL.md',
      'references/domain-model.md',
      'references/rules.yaml',
      'templates/checklist.md',
      'assets/flow.png',
      'scripts/inspect.sh',
    ]) {
      expect(existsSync(join(skillDir, relative))).toBe(true)
    }
    expect(tree.fileCount).toBe(6)
    expect(existsSync(join(skillDir, 'bundle'))).toBe(false)
    expect(existsSync(join(skillDir, '__MACOSX'))).toBe(false)
    expect(existsSync(join(skillDir, 'desktop.ini'))).toBe(false)
    relaxSkillTree(dshHome)
  })

  it('never hardlinks the cache into the attempt tree (§11.2)', () => {
    const cacheRoot = tempRoot('crp-skill-mat-link-')
    const dshHome = tempRoot('crp-skill-mat-link-home-')
    const { validated, entry } = publishFixture(cacheRoot)
    materializeSkillTree({ dshHome, bundles: [{ bundle: frozen(validated), cache: entry }] })
    const cached = statSync(join(entry.filesDir, 'SKILL.md'))
    const materialized = statSync(join(dshHome, 'skills', SKILL_NAME, 'SKILL.md'))
    // 不同 inode = 真复制。hardlink 会让 attempt 的写入改掉所有其他 attempt 看到的内容。
    expect(materialized.ino).not.toBe(cached.ino)
    expect(cached.nlink).toBe(1)
    relaxSkillTree(dshHome)
  })

  it('materializes scripts read-only and without an executable bit (§19.12)', () => {
    const cacheRoot = tempRoot('crp-skill-mat-script-')
    const dshHome = tempRoot('crp-skill-mat-script-home-')
    const { validated, entry } = publishFixture(cacheRoot)
    materializeSkillTree({ dshHome, bundles: [{ bundle: frozen(validated), cache: entry }] })
    const mode = statSync(join(dshHome, 'skills', SKILL_NAME, 'scripts', 'inspect.sh')).mode & 0o777
    expect(mode).toBe(0o400)
    // 注意：只读**不代表**脚本不能被执行（`bash x.sh` 不需要 +x）。执行的闸门是角色
    // 权限、Sandbox 与容器资源限制。这条断言证明的是"不继承 ZIP 的 mode 位"。
    expect(mode & 0o111).toBe(0)
    relaxSkillTree(dshHome)
  })

  it('creates an empty skills root for a job with no frozen skills', () => {
    const dshHome = tempRoot('crp-skill-mat-empty-')
    const tree = materializeSkillTree({ dshHome, bundles: [] })
    expect(existsSync(tree.skillsDir)).toBe(true)
    expect(tree.skills).toEqual([])
    expect(tree.fileCount).toBe(0)
  })

  it('reports cache corruption when a manifest file vanished before materialization', () => {
    const cacheRoot = tempRoot('crp-skill-mat-missing-')
    const dshHome = tempRoot('crp-skill-mat-missing-home-')
    const { validated, entry } = publishFixture(cacheRoot)
    // 手工构造"manifest 说有、磁盘上没有"：物化必须 fail closed，不能默默少复制一个文件。
    const brokenEntry = {
      ...entry,
      filesDir: join(cacheRoot, 'does-not-exist'),
    }
    expect(() =>
      materializeSkillTree({ dshHome, bundles: [{ bundle: frozen(validated), cache: brokenEntry }] }),
    ).toThrow()
    relaxSkillTree(dshHome)
  })
})

// ---------------------------------------------------------------------------
// §12 下载 / 复用 / fail closed
// ---------------------------------------------------------------------------

describe('frozen catalog provisioning', () => {
  function snapshotRow(validated: ReturnType<typeof validateSkillArchive>, overrides: Record<string, unknown> = {}) {
    const key = `12ab34cd-0000-0000-0000-000000000000/versions/1/${validated.archiveSha256.slice(7)}.zip`
    return {
      snapshot_id: 'snap-1',
      name: SKILL_NAME,
      description: 'bill review',
      when_to_use: null,
      version: 1,
      archive_bucket: 'skill-bundles',
      archive_object_key: key,
      archive_sha256: validated.archiveSha256,
      archive_size_bytes: validated.archiveSizeBytes,
      bundle_hash: validated.bundleHash,
      bundle_manifest: validated.manifest,
      expanded_size_bytes: validated.expandedSizeBytes,
      file_count: validated.fileCount,
      contains_scripts: validated.containsScripts,
      ...overrides,
    }
  }

  function countingStorage(archive: Buffer): SkillStorageClient & { calls: number } {
    return {
      calls: 0,
      async downloadArchive(objectKey: string) {
        assertFrozenObjectKey(objectKey)
        this.calls += 1
        return archive
      },
    } as SkillStorageClient & { calls: number }
  }

  it('downloads once on miss and never again on hit (§19.7)', async () => {
    const cacheRoot = tempRoot('crp-skill-prov-')
    const cache = new SkillCache({ cacheRoot })
    const archive = buildZip(validBundleEntries())
    const validated = validateSkillArchive({ archive, expectedSkillName: SKILL_NAME })
    const storage = countingStorage(archive)
    const catalog = parseFrozenSkillCatalog({
      snapshot_version: 1,
      catalog_hash: catalogHashFromBundles([
        {
          snapshotId: 'snap-1',
          name: SKILL_NAME,
          description: 'bill review',
          version: 1,
          archiveBucket: 'skill-bundles',
          archiveObjectKey: 'x',
          archiveSha256: validated.archiveSha256,
          archiveSizeBytes: validated.archiveSizeBytes,
          bundleHash: validated.bundleHash,
          bundleManifest: validated.manifest,
          expandedSizeBytes: validated.expandedSizeBytes,
          containsScripts: validated.containsScripts,
        },
      ]),
      bundles: [snapshotRow(validated)],
    })

    const first = await provisionSkillCatalog({ catalog, cache, storage })
    expect(storage.calls).toBe(1)
    expect(first.cacheMisses).toBe(1)
    expect(first.cacheHits).toBe(0)
    expect(first.downloadBytes).toBe(archive.length)
    // Worker 自己重算的 catalog hash 必须等于 Job 冻结的那一份。
    expect(first.catalogHash).toBe(catalog.catalogHash)

    const second = await provisionSkillCatalog({ catalog, cache, storage })
    expect(storage.calls).toBe(1)
    expect(second.cacheHits).toBe(1)
    expect(second.downloadBytes).toBe(0)
    expect(second.catalogHash).toBe(first.catalogHash)
  })

  it('treats a job with no frozen skills as an explicit empty catalog (§19.20)', () => {
    const catalog = parseFrozenSkillCatalog({
      snapshot_version: 0,
      catalog_hash: emptyCatalogHash(),
      bundles: [],
    })
    expect(catalog.bundles).toEqual([])
    expect(catalog.catalogHash).toBe(emptyCatalogHash())
    // 完全没有返回（历史 Job / RPC 返回 null）也必须落到同一个身份。
    expect(parseFrozenSkillCatalog(null).catalogHash).toBe(emptyCatalogHash())
  })

  it('refuses a snapshot that names a bucket other than skill-bundles (§15)', () => {
    const validated = validateSkillArchive({
      archive: buildZip(validBundleEntries()),
      expectedSkillName: SKILL_NAME,
    })
    expect(() =>
      parseFrozenSkillCatalog({
        snapshot_version: 1,
        catalog_hash: 'x',
        bundles: [snapshotRow(validated, { archive_bucket: 'review-files' })],
      }),
    ).toThrow(SkillGovernanceError)
  })

  it.each([
    ['..', '12ab34cd-0000-0000-0000-000000000000/versions/1/../../secret.zip'],
    ['absolute', '/12ab34cd-0000-0000-0000-000000000000/versions/1/a.zip'],
    ['staging prefix', 'staging/user/upload.zip'],
  ])('refuses a frozen object key shaped like %s', (_label, key) => {
    expect(() => assertFrozenObjectKey(key)).toThrow()
  })

  async function provisionWith(
    row: Record<string, unknown>,
    storage: SkillStorageClient,
  ): Promise<SkillGovernanceError> {
    const cache = new SkillCache({ cacheRoot: tempRoot('crp-skill-prov-fail-') })
    const catalog = parseFrozenSkillCatalog({
      snapshot_version: 1,
      catalog_hash: 'ignored',
      bundles: [row],
    })
    try {
      await provisionSkillCatalog({ catalog, cache, storage })
    } catch (err) {
      return err as SkillGovernanceError
    }
    throw new Error('provisioning unexpectedly succeeded')
  }

  it('maps a download failure to SKILL_BUNDLE_DOWNLOAD_FAILED', async () => {
    const validated = validateSkillArchive({
      archive: buildZip(validBundleEntries()),
      expectedSkillName: SKILL_NAME,
    })
    const error = await provisionWith(snapshotRow(validated), {
      downloadArchive: async () => {
        throw new Error('storage unreachable')
      },
    })
    expect(error.code).toBe(SKILL_ERROR_CODES.SKILL_BUNDLE_DOWNLOAD_FAILED)
  })

  it('maps a byte-level mismatch to SKILL_ARCHIVE_HASH_MISMATCH', async () => {
    const archive = buildZip(validBundleEntries())
    const validated = validateSkillArchive({ archive, expectedSkillName: SKILL_NAME })
    const other = buildZip([{ name: 'SKILL.md', content: '# different\n' }])
    const error = await provisionWith(
      snapshotRow(validated, { archive_size_bytes: other.length }),
      { downloadArchive: async () => other },
    )
    expect(error.code).toBe(SKILL_ERROR_CODES.SKILL_ARCHIVE_HASH_MISMATCH)
  })

  it('refuses a snapshot whose manifest does not hash to its frozen bundle hash', async () => {
    const archive = buildZip(validBundleEntries())
    const validated = validateSkillArchive({ archive, expectedSkillName: SKILL_NAME })
    const error = await provisionWith(
      snapshotRow(validated, { bundle_hash: `sha256:${'0'.repeat(64)}` }),
      { downloadArchive: async () => archive },
    )
    expect(error.code).toBe(SKILL_ERROR_CODES.SKILL_BUNDLE_INVALID)
  })

  it('refuses a snapshot whose name is not a safe directory name', async () => {
    const archive = buildZip(validBundleEntries())
    const validated = validateSkillArchive({ archive, expectedSkillName: SKILL_NAME })
    const error = await provisionWith(snapshotRow(validated, { name: '../escape' }), {
      downloadArchive: async () => archive,
    })
    expect(error.code).toBe(SKILL_ERROR_CODES.SKILL_BUNDLE_INVALID)
  })

  it('fails closed when the frozen catalog exceeds the global bundle count (§19.16)', async () => {
    const archive = buildZip(validBundleEntries())
    const validated = validateSkillArchive({ archive, expectedSkillName: SKILL_NAME })
    const rows = Array.from({ length: 51 }, (_unused, index) =>
      snapshotRow(validated, { name: `skill-${index}` }),
    )
    const cache = new SkillCache({ cacheRoot: tempRoot('crp-skill-prov-limit-') })
    const catalog = parseFrozenSkillCatalog({
      snapshot_version: 1,
      catalog_hash: 'ignored',
      bundles: rows,
    })
    await expect(
      provisionSkillCatalog({
        catalog,
        cache,
        storage: { downloadArchive: async () => archive },
      }),
    ).rejects.toMatchObject({ code: SKILL_ERROR_CODES.SKILL_BUNDLE_LIMIT_EXCEEDED })
  })

  it('fails closed when the frozen catalog exceeds the total archive budget (§19.16)', async () => {
    const archive = buildZip(validBundleEntries())
    const validated = validateSkillArchive({ archive, expectedSkillName: SKILL_NAME })
    const rows = Array.from({ length: 20 }, (_unused, index) =>
      snapshotRow(validated, {
        name: `skill-${index}`,
        // 20 × 6 MiB = 120 MiB > 100 MiB 的全目录归档上限。
        archive_size_bytes: 6 * 1024 * 1024,
      }),
    )
    const cache = new SkillCache({ cacheRoot: tempRoot('crp-skill-prov-bytes-') })
    const catalog = parseFrozenSkillCatalog({
      snapshot_version: 1,
      catalog_hash: 'ignored',
      bundles: rows,
    })
    await expect(
      provisionSkillCatalog({
        catalog,
        cache,
        storage: { downloadArchive: async () => archive },
      }),
    ).rejects.toMatchObject({ code: SKILL_ERROR_CODES.SKILL_BUNDLE_LIMIT_EXCEEDED })
  })
})

// ---------------------------------------------------------------------------
// §13 恢复门禁
// ---------------------------------------------------------------------------

describe('session recovery skill gates', () => {
  function candidate(overrides: Partial<ResumeCandidate> = {}): ResumeCandidate {
    const root = tempRoot('crp-skill-resume-')
    const path = join(root, 'session-x.jsonl')
    mkdirSync(root, { recursive: true })
    const body = `${JSON.stringify({ seq: 0 })}\n${JSON.stringify({ seq: 1 })}\n`
    writeFileSync(path, body)
    return {
      agentRunId: 'run-1',
      rootAgentId: 'root-1',
      rootSessionId: 'session-x',
      sessionId: 'session-x',
      sessionRevision: 3,
      storageLocator: path,
      contentHash: sha256Prefixed(readFileSync(path)),
      harnessVersion: '0.1.5-rc.1/v3',
      profileHash: 'profile-1',
      policyHash: 'policy-1',
      resumeCount: 0,
      skillCatalogHash: 'catalog-1',
      jobSkillCatalogHash: 'catalog-1',
      ...overrides,
    }
  }

  const base = {
    harnessVersion: '0.1.5-rc.1/v3',
    policyHash: 'policy-1',
    profileHash: 'profile-1',
    skillCatalogHash: 'catalog-1',
    alreadyCommitted: false,
    maxResumes: 3,
  }

  it('resumes when Harness, policy, profile and catalog all match (§19.15)', () => {
    expect(evaluateResume({ ...base, candidate: candidate() }).resume).toBe(true)
  })

  it('refuses a checkpoint written under a different skill catalog (§19.15)', () => {
    const decision = evaluateResume({
      ...base,
      candidate: candidate({ skillCatalogHash: 'catalog-old' }),
    })
    expect(decision.resume).toBe(false)
    expect(decision.code).toBe(SKILL_ERROR_CODES.SESSION_SKILL_SET_MISMATCH)
  })

  it('refuses when the materialized catalog differs from the job freeze (§19.15)', () => {
    const decision = evaluateResume({
      ...base,
      candidate: candidate({ jobSkillCatalogHash: 'catalog-job' }),
    })
    expect(decision.code).toBe(SKILL_ERROR_CODES.SESSION_SKILL_SET_MISMATCH)
  })

  it('refuses a checkpoint written under a different attempt profile (§13)', () => {
    // V1.6 之前 profile hash 只被记进日志、从不参与判定 —— 这条测试守住那个缺口。
    const decision = evaluateResume({
      ...base,
      candidate: candidate({ profileHash: 'profile-old' }),
    })
    expect(decision.code).toBe(V4_ERROR_CODES.SESSION_FORMAT_UNSUPPORTED)
  })

  it('still resumes an in-flight checkpoint that predates the catalog column', () => {
    // 迁移之前写的 checkpoint 没有这个字段。缺失时不比对：一个在途 attempt 不该因为
    // "我们后来加了一个字段"而永久不可恢复。
    const decision = evaluateResume({
      ...base,
      candidate: candidate({ skillCatalogHash: null, jobSkillCatalogHash: null }),
    })
    expect(decision.resume).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// §7.4 图片与脚本 magic 的正例，确保允许列表不是"全拒"
// ---------------------------------------------------------------------------

describe('allowed resource types', () => {
  it('accepts every image type on the V1.6 allow list', () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('jfif')])
    const webp = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.alloc(4),
      Buffer.from('WEBP', 'latin1'),
    ])
    const gif = Buffer.from('GIF89a-payload', 'latin1')
    const result = validate([
      { name: 'SKILL.md', content: validEntryMarkdown() },
      { name: 'assets/a.png', content: pngBytes() },
      { name: 'assets/b.jpg', content: jpeg },
      { name: 'assets/c.webp', content: webp },
      { name: 'assets/d.gif', content: gif },
    ])
    expect(result.manifest.files.filter((file) => file.role === 'ASSET')).toHaveLength(4)
  })

  it('accepts every script extension on the allow list and flags the bundle', () => {
    const result = validate([
      { name: 'SKILL.md', content: validEntryMarkdown() },
      { name: 'scripts/a.sh', content: '#!/bin/sh\n' },
      { name: 'scripts/b.js', content: 'export {}\n' },
      { name: 'scripts/c.mjs', content: 'export {}\n' },
      { name: 'scripts/d.cjs', content: 'module.exports = {}\n' },
    ])
    expect(result.containsScripts).toBe(true)
    expect(result.manifest.files.filter((file) => file.role === 'SCRIPT')).toHaveLength(4)
  })

  it('accepts a bundle with no scripts and marks it accordingly', () => {
    const result = validate([
      { name: 'SKILL.md', content: validEntryMarkdown() },
      { name: 'references/a.json', content: '{}\n' },
    ])
    expect(result.containsScripts).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// §11.3 / §13 profile 隔离与配置身份
// ---------------------------------------------------------------------------

describe('attempt profile skill isolation', () => {
  function spec(overrides: Partial<AttemptProfileSpec> = {}): AttemptProfileSpec {
    return {
      taskId: 'task-skill',
      agentAttempt: 1,
      attemptsRoot: '/attempts',
      route: {
        providerId: 'review-route',
        displayName: 'r',
        baseUrl: 'https://model.invalid/v1',
        modelName: 'm',
        contextWindow: 131072,
        maxTokens: 4096,
        apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
        requestTimeoutMs: 30000,
      },
      policy: V4_DEFAULT_POLICY,
      identity: { rootAgentId: 'root-1', rootSessionId: 'session-1' },
      broker: { socketPath: '/tmp/a.sock' },
      cwd: '/workspace/jobs/task-skill/workspace',
      sessionRoot: '/workspace/agent-sessions/attempt-1',
      ...overrides,
    }
  }

  function skillFilesystemConfig(patch: unknown[]): Record<string, unknown> {
    const rows = patch as Array<{ id?: string; config?: Record<string, unknown> }>
    const row = rows.find((candidate) => candidate.id === 'skill-filesystem')
    if (row?.config === undefined) throw new Error('the attempt patch has no skill-filesystem row')
    return row.config
  }

  it('always isolates skill discovery, even when no skills are mounted (§19.13)', () => {
    // 隔离不能是"传了参数才有"的可选项：某条忘记传参的调用路径会静默恢复默认 roots，
    // 于是 Workspace 里的 `.dsh/skills`（模型可写、rank 更高）就能顶替平台 Bundle。
    const config = skillFilesystemConfig(buildAttemptPatch(spec()))
    expect(config.includeDefaultRoots).toBe(false)
    expect(config.customSkillDirs).toEqual([])
    expect(config.watch).toBe(false)
    expect(config.watchFollowSymlinks).toBe(false)
    expect(String(config.bundledSkillDir)).toMatch(/\/skills$/)
  })

  it('points the bundled root at the per-attempt DSH_HOME, never at the workspace (§11.1)', () => {
    const base = spec()
    const config = skillFilesystemConfig(
      buildAttemptPatch(base, {
        dshHome: '/attempts/attempt-xyz/dsh-home',
        dir: '/attempts/attempt-xyz/dsh-home/skills',
        catalogHash: emptyCatalogHash(),
      }),
    )
    expect(config.bundledSkillDir).toBe('/attempts/attempt-xyz/dsh-home/skills')
    // 绝不指向代码 Workspace：那里 Agent 可写，且会污染固定 commit 的语义。
    expect(String(config.bundledSkillDir)).not.toContain(base.cwd)
    expect(config.dshHome).toBe('/attempts/attempt-xyz/dsh-home')
  })

  it('gives the authority plugin the skill attribution table, not the model surface', () => {
    const rows = buildAttemptPatch(spec()) as Array<{ id?: string; config?: Record<string, unknown> }>
    const authority = rows.find((row) => row.id === 'agent-authority-policy')?.config
    expect(authority?.skills).toEqual([])
    expect(String(authority?.skillsDir)).toMatch(/\/skills$/)
  })

  it('folds the catalog hash into the profile config hash (§13)', () => {
    const templateDir = resolveProfileTemplateDir()
    const patch = buildAttemptPatch(spec())
    const plugins = { '@codereview/x': '/entry.js' }
    const empty = computeConfigHash(templateDir, patch, plugins, emptyCatalogHash())
    const withSkills = computeConfigHash(templateDir, patch, plugins, `${'a'.repeat(64)}`)
    // 技能集合是模型可见能力面的一部分。它变了而 profile hash 不变，就等于让恢复门禁
    // 放过一个"技能已经换了"的 Session。
    expect(withSkills).not.toBe(empty)
    expect(computeConfigHash(templateDir, patch, plugins)).toBe(empty)
  })

  it('normalizes every per-attempt skill path out of the config hash (§13)', () => {
    const templateDir = resolveProfileTemplateDir()
    const plugins = { '@codereview/x': '/entry.js' }
    const first = buildAttemptPatch(spec(), {
      dshHome: '/attempts/attempt-aaaa/dsh-home',
      dir: '/attempts/attempt-aaaa/dsh-home/skills',
      catalogHash: 'catalog-1',
    })
    const second = buildAttemptPatch(spec(), {
      dshHome: '/attempts/attempt-bbbb/dsh-home',
      dir: '/attempts/attempt-bbbb/dsh-home/skills',
      catalogHash: 'catalog-1',
    })
    // 两个 attempt 的物化路径不同（mkdtemp 随机），但配置身份必须相同 —— 否则
    // "生产 Job 能追溯到唯一 Harness/profile/policy 组合"不成立，而且所有恢复都会被拒。
    expect(computeConfigHash(templateDir, first, plugins, 'catalog-1')).toBe(
      computeConfigHash(templateDir, second, plugins, 'catalog-1'),
    )
  })

  it('keeps credentials out of the patch even with skills configured', () => {
    const patch = buildAttemptPatch(spec(), {
      dshHome: '/attempts/attempt-x/dsh-home',
      dir: '/attempts/attempt-x/dsh-home/skills',
      catalogHash: 'catalog-1',
    })
    expect(() => assertPatchHasNoCredentials(patch)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// §16 审计归因
// ---------------------------------------------------------------------------

describe('skill resource audit attribution', () => {
  const skillsDir = '/attempts/attempt-x/dsh-home/skills'

  it('derives the skill name and a safe relative path from an absolute read', () => {
    expect(
      describeSkillResourceAccess(
        { path: `${skillsDir}/bos-bill-review/references/domain-model.md` },
        skillsDir,
      ),
    ).toEqual({ skillName: 'bos-bill-review', relativePath: 'references/domain-model.md' })
  })

  it('derives attribution from a bash command that names a script', () => {
    expect(
      describeSkillResourceAccess(
        { command: `bash ${skillsDir}/bos-bill-review/scripts/inspect.sh --dry-run` },
        skillsDir,
      ),
    ).toEqual({ skillName: 'bos-bill-review', relativePath: 'scripts/inspect.sh' })
  })

  it('attributes a bare skill directory without a relative path', () => {
    expect(describeSkillResourceAccess({ path: `${skillsDir}/bos-bill-review` }, skillsDir)).toEqual({
      skillName: 'bos-bill-review',
    })
  })

  it('ignores paths outside the materialized skills directory', () => {
    expect(
      describeSkillResourceAccess({ path: '/workspace/jobs/x/workspace/repos/a.java' }, skillsDir),
    ).toBeUndefined()
    // 未配置技能目录时不做任何归因，而不是把整棵文件系统当成技能目录。
    expect(describeSkillResourceAccess({ path: `${skillsDir}/a/b.md` }, '')).toBeUndefined()
  })

  it('drops a traversal-shaped relative path instead of storing it', () => {
    // 审计表不是攻击载荷的转运站：路径不安全就丢弃字段，而不是"存下来以后再说"。
    const access = describeSkillResourceAccess(
      { path: `${skillsDir}/bos-bill-review/../../../etc/passwd` },
      skillsDir,
    )
    expect(access?.skillName).toBe('bos-bill-review')
    expect(access?.relativePath).toBeUndefined()
  })

  it('never attributes a non-kebab-case first segment', () => {
    expect(
      describeSkillResourceAccess({ path: `${skillsDir}/../escape/SKILL.md` }, skillsDir),
    ).toBeUndefined()
  })
})

describe('V1.8 configurable catalog limits carried on the frozen snapshot', () => {
  const FROZEN = {
    catalogBundles: 60,
    catalogRenderBytes: 65536,
    catalogArchiveBytes: 209715200,
    catalogExpandedBytes: 536870912,
  }

  it('parses catalog_limits out of the snapshot when present', () => {
    const catalog = parseFrozenSkillCatalog({
      snapshot_version: 1,
      catalog_hash: emptyCatalogHash(),
      catalog_limits: FROZEN,
      bundles: [],
    })
    expect(catalog.catalogLimits).toEqual(FROZEN)
  })

  it('resolves to the frozen four values, keeping descriptionChars from the compiled default', () => {
    const catalog = parseFrozenSkillCatalog({
      snapshot_version: 1,
      catalog_hash: emptyCatalogHash(),
      catalog_limits: FROZEN,
      bundles: [],
    })
    const resolved = resolveCatalogLimits(catalog)
    expect(resolved.catalogBundles).toBe(FROZEN.catalogBundles)
    expect(resolved.catalogRenderBytes).toBe(FROZEN.catalogRenderBytes)
    expect(resolved.catalogArchiveBytes).toBe(FROZEN.catalogArchiveBytes)
    expect(resolved.catalogExpandedBytes).toBe(FROZEN.catalogExpandedBytes)
    // descriptionChars 未随 Job 冻结，仍取编译默认。
    expect(resolved.descriptionChars).toBe(SKILL_CATALOG_LIMITS.descriptionChars)
  })

  it('falls back to compiled defaults for a historical snapshot without catalog_limits', () => {
    const catalog = parseFrozenSkillCatalog({
      snapshot_version: 1,
      catalog_hash: emptyCatalogHash(),
      bundles: [],
    })
    expect(catalog.catalogLimits).toBeUndefined()
    expect(resolveCatalogLimits(catalog)).toEqual(SKILL_CATALOG_LIMITS)
  })

  it('ignores a partial/corrupt catalog_limits and falls back to defaults', () => {
    const catalog = parseFrozenSkillCatalog({
      snapshot_version: 1,
      catalog_hash: emptyCatalogHash(),
      // 缺 catalogExpandedBytes —— 半份 limits 视为不可信。
      catalog_limits: { catalogBundles: 60, catalogRenderBytes: 65536, catalogArchiveBytes: 209715200 },
      bundles: [],
    })
    expect(catalog.catalogLimits).toBeUndefined()
    expect(resolveCatalogLimits(catalog)).toEqual(SKILL_CATALOG_LIMITS)
  })

  it('null RPC result (fully historical job) also resolves to defaults', () => {
    const catalog = parseFrozenSkillCatalog(null)
    expect(catalog.catalogLimits).toBeUndefined()
    expect(resolveCatalogLimits(catalog)).toEqual(SKILL_CATALOG_LIMITS)
  })
})
