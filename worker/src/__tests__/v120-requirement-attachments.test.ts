/**
 * V1.20：需求附件物化。
 *
 * 三条不许退让的行为：
 *   sha256 不符即 fail closed（不是"少一份资料"，是"资料和冻结时不是同一份"）；
 *   取不到的附件不让 attempt 失败，但必须计数，提示词里如实说明；
 *   清洗后同名的附件加序号，不互相覆盖。
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  materializeRequirementAttachments,
  parseFrozenRequirementAttachments,
} from '../ai/requirements/attachment-materializer.js'
import type { StoryAttachmentStorage } from '../linky/attachment-storage.js'
import { Logger } from '../logger.js'

const silentLogger = new Logger({ sink: () => undefined, minLevel: 'error' })
const KEY = 'catalog/3bb2fffc-1b01-49a5-8e01-f1890d687894/01a08f41-08cb-7940-9a40-05e931d46aa0.md'

function digest(text: string): string {
  return createHash('sha256').update(Buffer.from(text)).digest('hex')
}

function storageWith(map: Record<string, string>): StoryAttachmentStorage {
  return {
    upload: async () => undefined,
    remove: async () => undefined,
    download: async (objectKey: string) => {
      const value = map[objectKey]
      if (value === undefined) throw new Error('not found')
      return Buffer.from(value)
    },
  }
}

function collectingWorkspace() {
  const written: Array<{ story: string; name: string; bytes: number }> = []
  return {
    written,
    materializeRequirementAttachment: (story: string, name: string, bytes: Buffer) => {
      written.push({ story, name, bytes: bytes.length })
      return `requirements/${story}/${name}`
    },
  }
}

describe('parseFrozenRequirementAttachments', () => {
  it('只接受形状完整的条目', () => {
    const items = parseFrozenRequirementAttachments({
      attachments: [
        { filename: 'a.md', storage_path: KEY, sha256: digest('x'), size_bytes: 1, content_type: 'text/plain' },
        { filename: '', storage_path: KEY, sha256: digest('x') },
        { filename: 'b.md', storage_path: '', sha256: digest('x') },
        { filename: 'c.md', storage_path: KEY, sha256: 'not-a-digest' },
      ],
    })
    expect(items).toHaveLength(1)
    expect(items[0]?.filename).toBe('a.md')
  })

  it('没有 attachments 键时返回空数组', () => {
    expect(parseFrozenRequirementAttachments({})).toEqual([])
    expect(parseFrozenRequirementAttachments(null)).toEqual([])
  })
})

describe('materializeRequirementAttachments', () => {
  it('校验通过就落盘，返回 workspace 相对路径', async () => {
    const workspace = collectingWorkspace()
    const result = await materializeRequirementAttachments({
      workspace,
      storyCode: 'US-2026-009362',
      attachments: [
        { filename: '方案.md', contentType: 'text/plain', sizeBytes: 5, sha256: digest('hello'), storagePath: KEY },
      ],
      storage: storageWith({ [KEY]: 'hello' }),
      logger: silentLogger,
    })
    expect(result.failures).toHaveLength(0)
    expect(result.materialized[0]?.relativePath).toBe('requirements/US-2026-009362/方案.md')
    expect(workspace.written[0]?.bytes).toBe(5)
  })

  it('sha256 不符即 fail closed，不落盘', async () => {
    const workspace = collectingWorkspace()
    const result = await materializeRequirementAttachments({
      workspace,
      storyCode: 'US-1',
      attachments: [
        { filename: 'a.md', contentType: null, sizeBytes: null, sha256: digest('expected'), storagePath: KEY },
      ],
      storage: storageWith({ [KEY]: 'tampered' }),
      logger: silentLogger,
    })
    expect(result.materialized).toHaveLength(0)
    expect(result.failures[0]?.code).toBe('REQUIREMENT_ATTACHMENT_DIGEST_MISMATCH')
    expect(workspace.written).toHaveLength(0)
  })

  it('取不到的附件只计数，不抛错', async () => {
    const result = await materializeRequirementAttachments({
      workspace: collectingWorkspace(),
      storyCode: 'US-1',
      attachments: [
        { filename: 'a.md', contentType: null, sizeBytes: null, sha256: digest('x'), storagePath: KEY },
      ],
      storage: storageWith({}),
      logger: silentLogger,
    })
    expect(result.failures[0]?.code).toBe('REQUIREMENT_ATTACHMENT_UNAVAILABLE')
  })

  it('清洗后同名的附件加序号而不是互相覆盖', async () => {
    const workspace = collectingWorkspace()
    const second = 'catalog/3bb2fffc-1b01-49a5-8e01-f1890d687894/att-2.md'
    const result = await materializeRequirementAttachments({
      workspace,
      storyCode: 'US-1',
      attachments: [
        { filename: 'a/b.md', contentType: null, sizeBytes: null, sha256: digest('one'), storagePath: KEY },
        { filename: 'x/b.md', contentType: null, sizeBytes: null, sha256: digest('two'), storagePath: second },
      ],
      storage: storageWith({ [KEY]: 'one', [second]: 'two' }),
      logger: silentLogger,
    })
    expect(result.materialized.map((entry) => entry.filename)).toEqual(['b.md', 'b-2.md'])
    expect(workspace.written).toHaveLength(2)
  })
})
