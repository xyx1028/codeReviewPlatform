/**
 * V1.20：Linky 映射与「批次需求导入」执行器。
 *
 * 用例都对着实测数据写（2026-09-24 对 feature.kingdee.com:2055 的探测）：
 * 正文在 field_values.gf_description、详情没有可读迭代名、附件列表 content_type 不可信、
 * team 为 null 时不许编人名。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  assertCatalogAttachmentKey,
  batchAttachmentObjectKey,
  catalogAttachmentObjectKey,
  isAllowedAttachment,
  sanitizeAttachmentFileName,
  toAttachmentPayloads,
  toCatalogDetailPayload,
  toCatalogItemPayload,
} from '../linky/mapping.js'
import {
  runLinkyBatchImport,
  type CommittedAttachment,
  type LinkyBatchImportClaim,
  type LinkyBatchImportDb,
} from '../linky/batch-import-runner.js'
import { LinkyApiError, type LinkyClient } from '../linky/client.js'
import type { StoryAttachmentStorage } from '../linky/attachment-storage.js'
import { Logger } from '../logger.js'

const silentLogger = new Logger({ sink: () => undefined, minLevel: 'error' })
const WORKSPACE = '3bb2fffc-1b01-49a5-8e01-f1890d687894'
const BATCH = '9f1d0c2a-1111-4c2a-8d3e-000000000001'
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
  it('把列表项映射成结构化字段，可读的迭代与发布窗口只能来自这里', () => {
    const payload = toCatalogItemPayload(listItem())
    expect(payload?.story_code).toBe('US-2026-012147')
    expect(payload?.iteration).toBe('202610-1（0928-1016）')
    expect(payload?.release_window).toBe('R20261016')
    expect(payload?.status_label).toBe('需求编写完成')
    expect(payload?.subject_name).toBe('【MCP】能力增强与体验优化')
    expect(payload?.story_url).toBeNull()
  })

  it('缺少 issue_id / code / workspace_id 的条目返回 null', () => {
    expect(toCatalogItemPayload(listItem({ id: null }))).toBeNull()
    expect(toCatalogItemPayload(listItem({ code: '   ' }))).toBeNull()
    expect(toCatalogItemPayload(listItem({ workspace_id: 'not-a-uuid' }))).toBeNull()
  })

  it('配了 web base 才产出回链，否则不猜 URL', () => {
    const payload = toCatalogItemPayload(listItem(), { webBaseUrl: 'https://linky.example.com/' })
    expect(payload?.story_url).toBe(
      `https://linky.example.com/workspaces/${WORKSPACE}/issues/${ISSUE}`,
    )
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
  })

  it('gf_description 缺失时退到 description；两个都空就是 null', () => {
    expect(
      toCatalogDetailPayload({ field_values: {}, description: '兜底正文' }).requirement_detail,
    ).toBe('兜底正文')
    expect(
      toCatalogDetailPayload({ field_values: {}, description: '  ' }).requirement_detail,
    ).toBeNull()
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

  it('对象 key 按批次组织且只含 ASCII，真实文件名留在数据库里', () => {
    const key = batchAttachmentObjectKey(BATCH, '01a08f41-08cb-7940-9a40-05e931d46aa0', '需求说明.md')
    expect(key).toBe(`batch/${BATCH}/01a08f41-08cb-7940-9a40-05e931d46aa0.md`)
    expect(assertCatalogAttachmentKey(key)).toBe(key)
  })

  it('仍然接受 V1.20 首版镜像层写下的 catalog/ key（历史批次还指向它们）', () => {
    const legacy = catalogAttachmentObjectKey(WORKSPACE, 'att-1', 'a.md')
    expect(legacy).toBe(`catalog/${WORKSPACE}/att-1.md`)
    expect(assertCatalogAttachmentKey(legacy)).toBe(legacy)
  })

  it('key 形状闸门拒绝路径穿越与陌生前缀', () => {
    expect(() => assertCatalogAttachmentKey('batch/../secrets.md')).toThrow(
      'LINKY_ATTACHMENT_KEY_INVALID',
    )
    expect(() => assertCatalogAttachmentKey('other/x.md')).toThrow('LINKY_ATTACHMENT_KEY_INVALID')
  })

  it('文件名清洗保留中文，拒绝空名与路径', () => {
    expect(sanitizeAttachmentFileName(' 需求 说明.md ')).toBe('需求 说明.md')
    expect(sanitizeAttachmentFileName('a/b/c.md')).toBe('c.md')
    expect(() => sanitizeAttachmentFileName('..')).toThrow('LINKY_ATTACHMENT_FILENAME_INVALID')
  })
})

interface FakeCalls {
  committed: Array<{ storyCode: string; attachments: CommittedAttachment[] }>
  failures: Array<{ storyCode: string; errorCode: string; attachmentsFailed: number }>
}

function fakeDb(options: { heartbeatOk?: boolean } = {}) {
  const calls: FakeCalls = { committed: [], failures: [] }
  const db: LinkyBatchImportDb = {
    heartbeatLinkyBatchImport: async () => options.heartbeatOk ?? true,
    commitLinkyBatchStory: async ({ story, attachments }) => {
      calls.committed.push({ storyCode: String(story.story_code), attachments })
      return 'story-id'
    },
    recordLinkyBatchStoryFailure: async ({ storyCode, errorCode, attachmentsFailed }) => {
      calls.failures.push({ storyCode, errorCode, attachmentsFailed })
      return true
    },
  }
  return { db, calls }
}

function fakeClient(overrides: Record<string, unknown> = {}): LinkyClient {
  return {
    listAllStories: vi.fn(async () => ({ items: [listItem()], total: 1, scopes: 1, pages: 1 })),
    getStory: vi.fn(async () => ({
      id: ISSUE,
      workspace_id: WORKSPACE,
      field_values: { gf_description: '正文' },
      team: { req: [], dev: [{ name: '王鹏程' }], test: [] },
    })),
    listAttachments: vi.fn(async () => []),
    downloadAttachment: vi.fn(async () => ({
      body: Buffer.from('hello'),
      contentType: 'text/plain',
    })),
    ...overrides,
  } as unknown as LinkyClient
}

function fakeStorage(): StoryAttachmentStorage & { uploaded: string[]; removed: string[] } {
  const uploaded: string[] = []
  const removed: string[] = []
  return {
    uploaded,
    removed,
    upload: async (key: string) => {
      uploaded.push(key)
    },
    download: async () => Buffer.from(''),
    remove: async (keys: string[]) => {
      removed.push(...keys)
    },
  }
}

const claim: LinkyBatchImportClaim = {
  id: '11111111-1111-4111-8111-111111111111',
  batch_id: BATCH,
  workspace_id: WORKSPACE,
  workspace_name: '工具开发组',
  release_window: 'R20261016',
  story_codes: ['US-2026-012147'],
  claim_token: '22222222-2222-4222-8222-222222222222',
  attempt: 1,
}

const limits = {
  attachmentMaxBytes: 1024,
  storyAttachmentMaxBytes: 2048,
  leaseSeconds: 900,
}

describe('runLinkyBatchImport', () => {
  it('把列表的可读字段与详情的正文合并后逐条提交', async () => {
    const { db, calls } = fakeDb()
    const outcome = await runLinkyBatchImport({
      claim,
      workerId: 'w1',
      client: fakeClient(),
      db,
      storage: fakeStorage(),
      limits,
      logger: silentLogger,
    })
    expect(outcome.storiesCommitted).toBe(1)
    expect(calls.committed).toHaveLength(1)
    expect(calls.committed[0]?.storyCode).toBe('US-2026-012147')
  })

  it('项目组在上游解析不到时，报的是项目组问题而不是网络错误', async () => {
    // 上游契约：指定的工作区不存在时返回空列表（total=0），而**不是**报错。
    // 所以"列表整个是空的"这件事只有一个含义 —— 项目组名没对上。此前这里会退化成
    // 逐条 LINKY_NOT_FOUND，最后整单以 LINKY_NETWORK_ERROR 收场，让人去查代理和 VPN。
    const { db, calls } = fakeDb()
    const client = fakeClient({
      listAllStories: vi.fn(async () => ({ items: [], total: 0, scopes: 1, pages: 1 })),
    })
    await expect(
      runLinkyBatchImport({
        claim,
        workerId: 'w1',
        client,
        db,
        storage: fakeStorage(),
        limits,
        logger: silentLogger,
      }),
    ).rejects.toMatchObject({ code: 'LINKY_WORKSPACE_NOT_FOUND' })
    // 提前整单失败，不逐条试 —— 每条都注定找不到，试一遍只是把同一句话说 N 遍。
    expect(calls.failures).toHaveLength(0)
  })

  it('项目组对但勾选的编号不在列表里时，报编号找不到并带上项目组名', async () => {
    const { db, calls } = fakeDb()
    const client = fakeClient({
      // 列表有别的需求，说明项目组是解析到了的 —— 那就是这个编号的问题。
      listAllStories: vi.fn(async () => ({
        items: [listItem({ code: 'US-2026-099999', id: ISSUE })],
        total: 1,
        scopes: 1,
        pages: 1,
      })),
    })
    await expect(
      runLinkyBatchImport({
        claim,
        workerId: 'w1',
        client,
        db,
        storage: fakeStorage(),
        limits,
        logger: silentLogger,
      }),
    ).rejects.toMatchObject({ code: 'LINKY_NOT_FOUND' })
    expect(calls.failures[0]?.errorCode).toBe('LINKY_NOT_FOUND')
  })

  it('整单失败时上报主导原因码，不再一律 LINKY_NETWORK_ERROR', async () => {
    const { db } = fakeDb()
    const client = fakeClient({
      getStory: vi.fn(async () => {
        throw new LinkyApiError(
          'LINKY_UPSTREAM_AUTH_FAILED',
          'Linky 取数接口拒绝了平台侧凭据（HTTP 400：invalid token）',
          400,
        )
      }),
    })
    await expect(
      runLinkyBatchImport({
        claim,
        workerId: 'w1',
        client,
        db,
        storage: fakeStorage(),
        limits,
        logger: silentLogger,
      }),
    ).rejects.toMatchObject({ code: 'LINKY_UPSTREAM_AUTH_FAILED' })
  })

  it('附件按允许列表与配额筛，超限跳过而不是中断', async () => {
    const { db, calls } = fakeDb()
    const client = fakeClient({
      listAttachments: vi.fn(async () => [
        { id: 'a1', filename: 'ok.md', size_bytes: 5 },
        { id: 'a2', filename: 'evil.exe', size_bytes: 5 },
        { id: 'a3', filename: 'huge.md', size_bytes: 99999 },
      ]),
    })
    const storage = fakeStorage()
    const outcome = await runLinkyBatchImport({
      claim,
      workerId: 'w1',
      client,
      db,
      storage,
      limits,
      logger: silentLogger,
    })
    expect(outcome.attachmentsStored).toBe(1)
    expect(outcome.attachmentsSkipped).toBe(2)
    expect(storage.uploaded).toEqual([`batch/${BATCH}/a1.md`])
    const committed = calls.committed[0]?.attachments ?? []
    expect(committed).toHaveLength(1)
    expect(committed[0]?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(committed[0]?.size_bytes).toBe(5)
  })

  it('附件下载失败不影响故事本身入库，但计数与故事失败原因都要留痕', async () => {
    const { db, calls } = fakeDb()
    const client = fakeClient({
      listAttachments: vi.fn(async () => [{ id: 'a1', filename: 'ok.md', size_bytes: 5 }]),
      downloadAttachment: vi.fn(async () => {
        throw new LinkyApiError('LINKY_TIMEOUT', 'timeout')
      }),
    })
    const outcome = await runLinkyBatchImport({
      claim,
      workerId: 'w1',
      client,
      db,
      storage: fakeStorage(),
      limits,
      logger: silentLogger,
    })
    expect(outcome.storiesCommitted).toBe(1)
    expect(outcome.attachmentsFailed).toBe(1)
    expect(calls.committed[0]?.attachments).toHaveLength(0)
  })

  it('故事提交失败时回滚本条已上传的附件字节，不留孤儿对象', async () => {
    const calls: string[] = []
    const db: LinkyBatchImportDb = {
      heartbeatLinkyBatchImport: async () => true,
      commitLinkyBatchStory: async () => {
        throw new Error('LINKY_IMPORT_STORY_TEXT_REQUIRED')
      },
      recordLinkyBatchStoryFailure: async ({ errorCode }) => {
        calls.push(errorCode)
        return true
      },
    }
    const storage = fakeStorage()
    const client = fakeClient({
      listAttachments: vi.fn(async () => [{ id: 'a1', filename: 'ok.md', size_bytes: 5 }]),
    })
    await expect(
      runLinkyBatchImport({
        claim,
        workerId: 'w1',
        client,
        db,
        storage,
        limits,
        logger: silentLogger,
      }),
    ).rejects.toThrow('全部导入失败')
    expect(storage.uploaded).toEqual([`batch/${BATCH}/a1.md`])
    expect(storage.removed).toEqual([`batch/${BATCH}/a1.md`])
    expect(calls).toEqual(['LINKY_IMPORT_STORY_FAILED'])
  })

  it('租约丢了立刻抛出，不继续提交', async () => {
    const { db } = fakeDb({ heartbeatOk: false })
    await expect(
      runLinkyBatchImport({
        claim,
        workerId: 'w1',
        client: fakeClient(),
        db,
        storage: fakeStorage(),
        limits,
        logger: silentLogger,
      }),
    ).rejects.toThrow('LINKY_IMPORT_LEASE_LOST')
  })

  it('一条都没成功时整单失败，避免页面显示"导入完成"而批次是空的', async () => {
    const { db } = fakeDb()
    const client = fakeClient({
      getStory: vi.fn(async () => {
        throw new LinkyApiError('LINKY_NOT_FOUND', 'gone', 404)
      }),
    })
    await expect(
      runLinkyBatchImport({
        claim,
        workerId: 'w1',
        client,
        db,
        storage: fakeStorage(),
        limits,
        logger: silentLogger,
      }),
      // 整单失败仍然要抛，但文案按主导原因给：这里全是"找不到编号"，就说清是编号的事，
      // 而不是笼统的"全部导入失败"（更不是网络错误）。
    ).rejects.toMatchObject({ code: 'LINKY_NOT_FOUND' })
  })
})
