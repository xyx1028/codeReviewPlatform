/**
 * Worker 与 Edge Function 两份归档校验实现的**等价性**。
 *
 * 这两份实现是故意重复的（方案 §7.1：「Worker 必须独立重算，不能相信数据库或上传方
 * 自报」）。共用一份代码就只有一次判断，那时"三层 hash"只是同一个声明被抄了三遍。
 *
 * 重复的代价是"改一处要改两处"。这份测试就是那个代价的保险：任何一侧改了规范格式、
 * 角色规则、类型允许列表或拒绝条件，两侧算出的 bundle hash 会立刻分叉，而分叉在生产
 * 里的表现是**每个新 Job 一启动就 SESSION_SKILL_SET_MISMATCH** —— 那时才发现就太晚了。
 *
 * Edge Function 的 `bundle.ts` 只用 Web 标准 API（`crypto.subtle`、`DecompressionStream`、
 * `Blob`、`TextDecoder`），所以它在 Node 上也能跑。Deno 专属的东西全部在 `index.ts` 里，
 * 这里不碰它。
 */

import { describe, expect, it } from 'vitest'
import { validateSkillArchive as workerValidate } from '../ai/skills/bundle-validator.js'
import {
  validateSkillArchive as edgeValidate,
  readArchiveTextEntries,
  LIMITS as EDGE_LIMITS,
} from '../../../supabase/functions/skill-bundle-admin/bundle.js'
import { SKILL_BUNDLE_LIMITS } from '../ai/skills/skill-limits.js'
import {
  buildZip,
  UNIX_MODE,
  validBundleEntries,
  validEntryMarkdown,
  type ZipEntrySpec,
} from './helpers/zip-builder.js'

const SKILL_NAME = 'bos-bill-review'

describe('worker and edge-function bundle validators agree', () => {
  it('derives the same manifest and the same three hashes', async () => {
    const archive = buildZip(validBundleEntries())
    const worker = workerValidate({ archive, expectedSkillName: SKILL_NAME })
    const edge = await edgeValidate(new Uint8Array(archive), SKILL_NAME)

    expect(edge.bundleHash).toBe(worker.bundleHash)
    expect(edge.archiveSha256).toBe(worker.archiveSha256)
    expect(edge.expandedSizeBytes).toBe(worker.expandedSizeBytes)
    expect(edge.fileCount).toBe(worker.fileCount)
    expect(edge.containsScripts).toBe(worker.containsScripts)
    // 整份 manifest 逐字节相同 —— 包括文件顺序、角色与 mediaType 推导。
    expect(JSON.stringify(edge.manifest)).toBe(JSON.stringify(worker.manifest))
    // frontmatter 也必须解析成同一份结果：它决定模型看到的 name 与 description。
    expect(JSON.stringify(edge.frontmatter)).toBe(JSON.stringify(worker.frontmatter))
  })

  it('agrees on deflated archives too', async () => {
    // 压缩路径在两侧用的是完全不同的解压器（zlib.inflateRawSync vs DecompressionStream）。
    const archive = buildZip(validBundleEntries().map((entry) => ({ ...entry, method: 8 as const })))
    const worker = workerValidate({ archive, expectedSkillName: SKILL_NAME })
    const edge = await edgeValidate(new Uint8Array(archive), SKILL_NAME)
    expect(edge.bundleHash).toBe(worker.bundleHash)
    expect(JSON.stringify(edge.manifest)).toBe(JSON.stringify(worker.manifest))
  })


  const metadata: ZipEntrySpec[] = [
    { name: '__MACOSX/', content: '' },
    { name: '__MACOSX/bundle/._SKILL.md', content: Buffer.from([0, 255, 1]) },
    { name: 'bundle/.DS_Store', content: Buffer.from([0, 255]) },
    { name: 'bundle/references/._domain-model.md', content: Buffer.from([0]) },
    { name: 'Thumbs.db', content: Buffer.from([255]) },
    { name: 'desktop.ini', content: 'windows metadata' },
  ]

  it.each(['Mac Finder', 'Windows Explorer', 'root layout'])('normalizes %s packaging with identical effective contents', async (style) => {
    const root = workerValidate({ archive: buildZip(validBundleEntries()), expectedSkillName: SKILL_NAME })
    const wrapped = style !== 'root layout'
    const entries = validBundleEntries().map((e) => ({
      ...e, name: (wrapped ? 'bundle/' : '') + e.name,
      ...(style === 'Windows Explorer' ? { unixMode: 0 } : {}),
    }))
    if (wrapped) entries.unshift({ name: 'bundle/', content: '' })
    const archive = buildZip([...entries, ...metadata])
    const worker = workerValidate({ archive, expectedSkillName: SKILL_NAME })
    const edge = await edgeValidate(new Uint8Array(archive), SKILL_NAME)
    expect(edge.manifest).toEqual(worker.manifest)
    expect(edge.bundleHash).toBe(root.bundleHash)
    expect(worker.manifest.files).toEqual(root.manifest.files)
    expect(worker.archiveSha256).not.toBe(root.archiveSha256)
    expect(worker.files.map((file) => file.path)).toEqual(root.files.map((file) => file.path))
    expect(worker.containsScripts).toBe(true)
    const diff = await readArchiveTextEntries(new Uint8Array(archive), ['SKILL.md', 'references/domain-model.md', 'assets/flow.png'])
    expect(diff.texts.get('SKILL.md')).toBe(validEntryMarkdown())
    expect(diff.texts.get('references/domain-model.md')).toBe('# domain\n')
    expect([...diff.binary]).toEqual(['assets/flow.png'])
  })

  it('does not count metadata against effective entry limits, with a bounded raw directory', async () => {
    const entries = [{ name: 'SKILL.md', content: validEntryMarkdown() }]
    for (let i = 0; i < 110; i++) {
      entries.push({ name: `references/f${i}.md`, content: `reference ${i}` })
      entries.push({ name: `__MACOSX/references/._f${i}.md`, content: 'metadata' })
    }
    const archive = buildZip(entries)
    const worker = workerValidate({ archive, expectedSkillName: SKILL_NAME })
    const edge = await edgeValidate(new Uint8Array(archive), SKILL_NAME)
    expect(edge.manifest).toEqual(worker.manifest)
    expect(worker.fileCount).toBe(111)
    const excessive = buildZip([
      { name: 'SKILL.md', content: validEntryMarkdown() },
      ...Array.from({ length: SKILL_BUNDLE_LIMITS.entryCount * 4 }, (_, i) => ({ name: `__MACOSX/._f${i}`, content: '' })),
    ])
    expect(() => workerValidate({ archive: excessive, expectedSkillName: SKILL_NAME })).toThrow()
    await expect(edgeValidate(new Uint8Array(excessive), SKILL_NAME)).rejects.toThrow()
  })

  const hostile: Array<[string, ZipEntrySpec[]]> = [
    ['metadata traversal', [{ name: 'SKILL.md', content: validEntryMarkdown() }, { name: '__MACOSX/../pwn', content: 'x' }]],
    ['absolute metadata', [{ name: 'SKILL.md', content: validEntryMarkdown() }, { name: '/__MACOSX/._file', content: 'x' }]],
    ['metadata symlink', [{ name: 'SKILL.md', content: validEntryMarkdown() }, { name: '__MACOSX/._file', content: '../x', unixMode: UNIX_MODE.symlink }]],
    ['encrypted metadata', [{ name: 'SKILL.md', content: validEntryMarkdown() }, { name: '.DS_Store', content: 'x', flags: 1 }]],
    ['metadata backslash', [{ name: 'SKILL.md', content: validEntryMarkdown() }, { name: '__MACOSX\\._file', content: 'x' }]],
    ['nested fake metadata directory', [{ name: 'SKILL.md', content: validEntryMarkdown() }, { name: 'references/../.DS_Store', content: 'x' }]],
    ['wrapped duplicate', [{ name: 'bundle/SKILL.md', content: validEntryMarkdown() }, { name: 'bundle/SKILL.md', content: validEntryMarkdown() }]],
    ['wrapped case collision', [{ name: 'bundle/SKILL.md', content: validEntryMarkdown() }, { name: 'bundle/references/A.md', content: 'x' }, { name: 'bundle/references/a.md', content: 'y' }]],
    ['wrapped illegal path', [{ name: 'bundle/SKILL.md', content: validEntryMarkdown() }, { name: 'bundle/references/bad name.md', content: 'x' }]],
    ['wrapped sibling file', [{ name: 'bundle/SKILL.md', content: validEntryMarkdown() }, { name: 'other.md', content: 'x' }]],
    ['zip slip', [{ name: 'SKILL.md', content: validEntryMarkdown() }, { name: '../../pwn', content: 'x' }]],
    ['absolute path', [{ name: 'SKILL.md', content: validEntryMarkdown() }, { name: '/etc/passwd', content: 'x' }]],
    ['backslash path', [{ name: 'SKILL.md', content: validEntryMarkdown() }, { name: 'references\\a.md', content: 'x' }]],
    ['multiple wrapper folders', [{ name: 'x/SKILL.md', content: validEntryMarkdown() }, { name: 'y/SKILL.md', content: validEntryMarkdown() }]],
    ['two outer directories', [{ name: `outer/${SKILL_NAME}/SKILL.md`, content: validEntryMarkdown() }]],
    [
      'symlink',
      [
        { name: 'SKILL.md', content: validEntryMarkdown() },
        { name: 'references/l.md', content: '../x', unixMode: UNIX_MODE.symlink },
      ],
    ],
    [
      'fifo',
      [
        { name: 'SKILL.md', content: validEntryMarkdown() },
        { name: 'references/p.md', content: '', unixMode: UNIX_MODE.fifo },
      ],
    ],
    [
      'duplicate path',
      [
        { name: 'SKILL.md', content: validEntryMarkdown() },
        { name: 'references/a.md', content: '1' },
        { name: 'references/a.md', content: '2' },
      ],
    ],
    [
      'case collision',
      [
        { name: 'SKILL.md', content: validEntryMarkdown() },
        { name: 'references/A.md', content: '1' },
        { name: 'references/a.md', content: '2' },
      ],
    ],
    ['fake png', [{ name: 'SKILL.md', content: validEntryMarkdown() }, { name: 'assets/a.png', content: '<html>' }]],
    ['unlisted svg', [{ name: 'SKILL.md', content: validEntryMarkdown() }, { name: 'assets/a.svg', content: '<svg/>' }]],
    ['unlisted html', [{ name: 'SKILL.md', content: validEntryMarkdown() }, { name: 'references/a.html', content: '<p/>' }]],
    ['script outside scripts/', [{ name: 'SKILL.md', content: validEntryMarkdown() }, { name: 'run.sh', content: '#!/bin/sh\n' }]],
    ['encrypted', [{ name: 'SKILL.md', content: validEntryMarkdown(), flags: 0x1 }]],
    ['bad crc', [{ name: 'SKILL.md', content: validEntryMarkdown(), crcOverride: 1 }]],
    ['no frontmatter', [{ name: 'SKILL.md', content: '# plain markdown\n' }]],
    ['unclosed frontmatter', [{ name: 'SKILL.md', content: '---\nname: bos-bill-review\n' }]],
    ['frontmatter name mismatch', [{ name: 'SKILL.md', content: validEntryMarkdown('other-skill') }]],
    [
      'model invocation disabled',
      [
        {
          name: 'SKILL.md',
          content: '---\nname: bos-bill-review\ndescription: x\ndisable-model-invocation: true\n---\n# body\n',
        },
      ],
    ],
    ['empty entry file', [{ name: 'SKILL.md', content: '' }]],
    [
      'invalid utf-8',
      [
        { name: 'SKILL.md', content: validEntryMarkdown() },
        { name: 'references/bad.md', content: Buffer.from([0xff, 0xfe, 0x00]) },
      ],
    ],
  ]

  it.each(hostile)('both implementations reject: %s', async (_label, entries) => {
    const archive = buildZip(entries)
    expect(() => workerValidate({ archive, expectedSkillName: SKILL_NAME })).toThrow()
    await expect(edgeValidate(new Uint8Array(archive), SKILL_NAME)).rejects.toThrow()
  })

  it('enforces the same per-bundle limits on both sides', () => {
    // 上限在三处生效（SQL / Worker / Edge Function）。SQL 那一处由
    // src/lib/__tests__/skill-limits-consistency.test.ts 守；这里守 TypeScript 的两处。
    expect(EDGE_LIMITS.archiveBytes).toBe(SKILL_BUNDLE_LIMITS.archiveBytes)
    expect(EDGE_LIMITS.expandedBytes).toBe(SKILL_BUNDLE_LIMITS.expandedBytes)
    expect(EDGE_LIMITS.entryCount).toBe(SKILL_BUNDLE_LIMITS.entryCount)
    expect(EDGE_LIMITS.fileBytes).toBe(SKILL_BUNDLE_LIMITS.fileBytes)
    expect(EDGE_LIMITS.entryFileBytes).toBe(SKILL_BUNDLE_LIMITS.entryFileBytes)
    expect(EDGE_LIMITS.pathDepth).toBe(SKILL_BUNDLE_LIMITS.pathDepth)
    expect(EDGE_LIMITS.pathBytes).toBe(SKILL_BUNDLE_LIMITS.pathBytes)
    expect(EDGE_LIMITS.compressionRatio).toBe(SKILL_BUNDLE_LIMITS.compressionRatio)
    expect(EDGE_LIMITS.validateMs).toBe(SKILL_BUNDLE_LIMITS.validateMs)
  })

  it('rejects a zip bomb on both sides', async () => {
    const bomb = Buffer.alloc(1024 * 1024, 0x41)
    const archive = buildZip([
      { name: 'SKILL.md', content: validEntryMarkdown() },
      { name: 'references/bomb.txt', content: bomb, method: 8 },
    ])
    expect(() => workerValidate({ archive, expectedSkillName: SKILL_NAME })).toThrow()
    await expect(edgeValidate(new Uint8Array(archive), SKILL_NAME)).rejects.toThrow()
  })
})
