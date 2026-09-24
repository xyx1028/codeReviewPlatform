/**
 * V1.20：Linky 映射与同步执行器。
 *
 * 用例都对着实测数据写（2026-09-24 对 feature.kingdee.com:2055 的探测）：
 * 正文在 field_values.gf_description、详情没有可读迭代名、附件列表 content_type 不可信、
 * team 为 null 时不许编人名。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  assertCatalogAttachmentKey,
  catalogAttachmentObjectKey,
  isAllowedAttachment,
  sanitizeAttachmentFileName,
  toAttachmentPayloads,
  toCatalogDetailPayload,
  toCatalogItemPayload,
} from '../linky/mapping.js'
import { runLinkySync, type LinkySyncClaim, type LinkySyncDb } from '../linky/sync-runner.js'
import { LinkyApiError, type LinkyClient } from '../linky/client.js'
import type { StoryAttachmentStorage } from '../linky/attachment-storage.js'
import { Logger } from '../logger.js'

const silentLogger = new Logger({ sink: () => undefined, minLevel: 'error' })
const WORKSPACE = '3bb2fffc-1b01-49a5-8e01-f1890d687894'
const ISSUE = '3677a47f-94ef-45ce-b279-c3ee8e97be13'

function listItem(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE,
    code: 'US-2026-012147',
    title: 'mcphub 增加 oauth 无 secret 鉴权',
    status: '需求编写完成',
    assignee: '何翘楚',
    iteration: '202610-1（0928-1016）',
    release_window: 'R20261016',
    subject: '【MCP】能力增强与体验优化',
    workspace_id: WORKSPACE,
    workspace_name: '工具开发组',
    ...overrides,
  }
}

describe('toCatalogItemPayload', () => {
  it('把列表项映射成镜像行，可读的迭代与发布窗口只能来自这里', () => {
    const payload = toCatalogItemPayload(listItem())
    expect(payload).not.toBeNull()
    expect(payload?.story_code).toBe('US-2026-012147')
    expect(payload?.iteration).toBe('202610-1（0928-1016）')
    expect(payload?.release_window).toBe('R20261016')
    expect(payload?.status_label).toBe('需求编写完成')
    expect(payload?.subject_name).toBe('【MCP】能力增强与体验优化')
    expect(payload?.story_url).toBeNull()
  })

  it('缺少 issue_id / code / workspace_id 的条目返回 null 而不是塞一条半成品进镜像', () => {
    expect(toCatalogItemPayload(listItem({ id: null }))).toBeNull()
    expect(toCatalogItemPayload(listItem({ code: '   ' }))).toBeNull()
    expect(toCatalogItemPayload(listItem({ workspace_id: 'not-a-uuid' }))).toBeNull()
  })

  it('配了 web base 才产出回链，否则不猜 URL', () => {
    const payload = toCatalogItemPayload(listItem(), { webBaseUrl: 'https://linky.example.com/' })
    expect(payload?.story_url).toBe(`https://linky.example.com/workspaces/${WORKSPACE}/issues/${ISSUE}`)
  })
})

describe('toCatalogDetailPayload', () => {
  it('正文取 field_values.gf_description —— 实测 description 恒为空', () => {
    const payload = toCatalogDetailPayload({
      id: ISSUE,
      workspace_id: WORKSPACE,
      description: '',
      field_values: { gf_description: 'mcphub 需要支持标准 OAuth 授权码 + PKCE 模式。' },
      team: { req: [{ name: '何翘楚' }], dev: [{ name: '王鹏程' }], test: [] },
      team_resolve_error: null,
    })
    expect(payload.requirement_detail).toBe('mcphub 需要支持标准 OAuth 授权码 + PKCE 模式。')
    expect(payload.team).toEqual({ req: [{ name: '何翘楚' }], dev: [{ name: '王鹏程' }], test: [] })
    expect(payload.team_resolve_error).toBeNull()
  })

  it('gf_description 缺失时退到 description；两个都空就是 null', () => {
    expect(
      toCatalogDetailPayload({ field_values: {}, description: '兜底正文' }).requirement_detail,
    ).toBe('兜底正文')
    expect(toCatalogDetailPayload({ field_values: {}, description: '  ' }).requirement_detail).toBeNull()
  })

  it('team 解析降级时 team 为 null 且保留原因，绝不编造人名', () => {
    const payload = toCatalogDetailPayload({
      field_values: { gf_description: 'x' },
      team: null,
      team_resolve_error: 'member api timeout',
    })
    expect(payload.team).toBeNull()
    expect(payload.team_resolve_error).toBe('member api timeout')
  })
})

describe('附件映射与 key 规则', () => {
  it('去重并归一化附件条目', () => {
    const items = toAttachmentPayloads([
      { id: 'a1', filename: 'prd.docx', content_type: 'application/zip', size_bytes: 17805 },
      { id: 'a1', filename: 'prd.docx' },
      { id: '', filename: 'x.md' },
      { id: 'a2', filename: '  ' },
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toEqual({
      linky_attachment_id: 'a1',
      filename: 'prd.docx',
      content_type: 'application/zip',
      size_bytes: '17805',
    })
  })

  it('允许列表拦掉可执行体与 svg', () => {
    expect(isAllowedAttachment('PRD-多智能体协作.html')).toBe(true)
    expect(isAllowedAttachment('方案.docx')).toBe(true)
    expect(isAllowedAttachment('setup.exe')).toBe(false)
    expect(isAllowedAttachment('icon.svg')).toBe(false)
    expect(isAllowedAttachment('noext')).toBe(false)
  })

  it('对象 key 只含 ASCII，真实文件名留在数据库里', () => {
    const key = catalogAttachmentObjectKey(WORKSPACE, '01a08f41-08cb-7940-9a40-05e931d46aa0', '需求说明.md')
    expect(key).toBe(`catalog/${WORKSPACE}/01a08f41-08cb-7940-9a40-05e931d46aa0.md`)
    expect(assertCatalogAttachmentKey(key)).toBe(key)
  })

  it('key 形状闸门拒绝路径穿越', () => {
    expect(() => assertCatalogAttachmentKey('catalog/../secrets.md')).toThrow('LINKY_ATTACHMENT_KEY_INVALID')
    expect(() => assertCatalogAttachmentKey('other/x.md')).toThrow('LINKY_ATTACHMENT_KEY_INVALID')
  })

  it('文件名清洗保留中文，拒绝空名与路径', () => {
    expect(sanitizeAttachmentFileName(' 需求 说明.md ')).toBe('需求 说明.md')
    expect(sanitizeAttachmentFileName('a/b/c.md')).toBe('c.md')
    expect(() => sanitizeAttachmentFileName('..')).toThrow('LINKY_ATTACHMENT_FILENAME_INVALID')
    expect(() => sanitizeAttachmentFileName('   ')).toThrow('LINKY_ATTACHMENT_FILENAME_INVALID')
  })
})

interface FakeDbCalls {
  catalog: unknown[][]
  details: Array<{ issueId: string; detail: Record<string, unknown> }>
  attachments: Array<{ attachmentId: string; status: string; error?: string | null }>
}

function fakeDb(options: { heartbeatOk?: boolean; pending?: Array<Record<string, unknown>> } = {}) {
  const calls: FakeDbCalls = { catalog: [], details: [], attachments: [] }
  const db: LinkySyncDb = {
    heartbeatLinkySync: async () => options.heartbeatOk ?? true,
    upsertLinkyStoryCatalog: async ({ items }) => {
      calls.catalog.push(items as unknown[])
      return items.length
    },
    upsertLinkyStoryDetail: async ({ issueId, detail }) => {
      calls.details.push({ issueId, detail })
      return (options.pending ?? []) as never
    },
    recordLinkyCatalogAttachment: async ({ attachmentId, status, error }) => {
      calls.attachments.push({ attachmentId, status, error })
      return true
    },
  }
  return { db, calls }
}

function fakeClient(overrides: Partial<LinkyClient> = {}): LinkyClient {
  return {
    listAllStories: vi.fn(async () => ({ items: [listItem()], total: 1, scopes: 1, pages: 1 })),
    getStory: vi.fn(async () => ({
      id: ISSUE,
      workspace_id: WORKSPACE,
      field_values: { gf_description: '正文' },
      team: { req: [], dev: [{ name: '王鹏程' }], test: [] },
    })),
    listAttachments: vi.fn(async () => []),
    downloadAttachment: vi.fn(async () => ({ body: Buffer.from('hello'), contentType: 'text/plain' })),
    ...overrides,
  } as unknown as LinkyClient
}

const fakeStorage = (): StoryAttachmentStorage & { uploaded: string[] } => {
  const uploaded: string[] = []
  return {
    uploaded,
    upload: async (key: string) => {
      uploaded.push(key)
    },
    download: async () => Buffer.from(''),
    remove: async () => undefined,
  }
}

const claim: LinkySyncClaim = {
  id: '11111111-1111-4111-8111-111111111111',
  depth: 'LIST',
  workspace_id: WORKSPACE,
  workspace_name: '工具开发组',
  release_window: null,
  claim_token: '22222222-2222-4222-8222-222222222222',
  attempt: 1,
}

const limits = {
  attachmentMaxBytes: 1024,
  storyAttachmentMaxBytes: 2048,
  maxDetailsPerSync: 10,
  leaseSeconds: 600,
}

describe('runLinkySync', () => {
  it('LIST 深度只写列表，不碰正文与附件', async () => {
    const { db, calls } = fakeDb()
    const client = fakeClient()
    const outcome = await runLinkySync({
      claim,
      workerId: 'w1',
      client,
      db,
      storage: fakeStorage(),
      limits,
      logger: silentLogger,
    })
    expect(outcome.storiesSynced).toBe(1)
    expect(outcome.detailsSynced).toBe(0)
    expect(calls.details).toHaveLength(0)
    expect(client.getStory).not.toHaveBeenCalled()
  })

  it('FULL 深度按发布窗口收窄范围', async () => {
    const { db, calls } = fakeDb()
    const client = fakeClient({
      listAllStories: vi.fn(async () => ({
        items: [listItem(), listItem({ id: '44444444-4444-4444-4444-444444444444', code: 'US-9', release_window: 'R20260101' })],
        total: 2,
        scopes: 1,
        pages: 1,
      })),
    } as never)
    const outcome = await runLinkySync({
      claim: { ...claim, depth: 'FULL', release_window: 'R20261016' },
      workerId: 'w1',
      client,
      db,
      storage: fakeStorage(),
      limits,
      logger: silentLogger,
    })
    expect(outcome.storiesSynced).toBe(2)
    expect(outcome.detailsSynced).toBe(1)
    expect(calls.details[0]?.issueId).toBe(ISSUE)
  })

  it('附件按允许列表与配额筛，超限记 SKIPPED 而不是中断整次同步', async () => {
    const { db, calls } = fakeDb({
      pending: [
        { id: 'p1', linky_attachment_id: 'a1', filename: 'ok.md', content_type: null, size_bytes: 5 },
        { id: 'p2', linky_attachment_id: 'a2', filename: 'evil.exe', content_type: null, size_bytes: 5 },
        { id: 'p3', linky_attachment_id: 'a3', filename: 'huge.md', content_type: null, size_bytes: 99999 },
      ],
    })
    const storage = fakeStorage()
    const outcome = await runLinkySync({
      claim: { ...claim, depth: 'FULL' },
      workerId: 'w1',
      client: fakeClient(),
      db,
      storage,
      limits,
      logger: silentLogger,
    })
    expect(outcome.attachmentsStored).toBe(1)
    expect(outcome.attachmentsSkipped).toBe(2)
    expect(storage.uploaded).toEqual([`catalog/${WORKSPACE}/a1.md`])
    expect(calls.attachments.map((entry) => entry.status)).toEqual(['STORED', 'SKIPPED', 'SKIPPED'])
  })

  it('附件下载失败记 FAILED，故事本身仍算同步成功', async () => {
    const { db, calls } = fakeDb({
      pending: [{ id: 'p1', linky_attachment_id: 'a1', filename: 'ok.md', content_type: null, size_bytes: 5 }],
    })
    const client = fakeClient({
      downloadAttachment: vi.fn(async () => {
        throw new LinkyApiError('LINKY_TIMEOUT', 'timeout')
      }),
    } as never)
    const outcome = await runLinkySync({
      claim: { ...claim, depth: 'FULL' },
      workerId: 'w1',
      client,
      db,
      storage: fakeStorage(),
      limits,
      logger: silentLogger,
    })
    expect(outcome.detailsSynced).toBe(1)
    expect(outcome.attachmentsFailed).toBe(1)
    expect(calls.attachments[0]?.status).toBe('FAILED')
    expect(calls.attachments[0]?.error).toContain('LINKY_TIMEOUT')
  })

  it('租约丢了立刻抛出，不继续往镜像里写', async () => {
    const { db } = fakeDb({ heartbeatOk: false })
    await expect(
      runLinkySync({
        claim,
        workerId: 'w1',
        client: fakeClient(),
        db,
        storage: fakeStorage(),
        limits,
        logger: silentLogger,
      }),
    ).rejects.toThrow('LINKY_SYNC_LEASE_LOST')
  })

  it('目标故事全部失败时整次同步失败，避免页面显示"成功"而正文一条没有', async () => {
    const { db } = fakeDb()
    const client = fakeClient({
      getStory: vi.fn(async () => {
        throw new LinkyApiError('LINKY_NOT_FOUND', 'gone', 404)
      }),
    } as never)
    await expect(
      runLinkySync({
        claim: { ...claim, depth: 'FULL' },
        workerId: 'w1',
        client,
        db,
        storage: fakeStorage(),
        limits,
        logger: silentLogger,
      }),
    ).rejects.toThrow('gone')
  })
})
