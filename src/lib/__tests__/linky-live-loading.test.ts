import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchLinkyAttachments, fetchLinkyStories, fetchLinkyStoryDetail } from '../linky-live'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function neverRespond(_url: unknown, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal
    const abort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

describe('Linky loading boundaries', () => {
  it('详情、附件及下载使用列表的 UUID，保留展示编号', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ field_values: { gf_description: '正文' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 'att/1', filename: 'prd.docx' }] })))
    vi.stubGlobal('fetch', fetchMock)
    const detail = await fetchLinkyStoryDetail('US-2026-045227', undefined, 'issue-uuid')
    const attachments = await fetchLinkyAttachments('US-2026-045227', undefined, 'issue-uuid')
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toMatch(/\/stories\/issue-uuid$/)
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).pathname).toMatch(/\/stories\/issue-uuid\/attachments$/)
    expect(attachments[0]?.downloadUrl).toMatch(/\/stories\/issue-uuid\/attachments\/att%2F1\/download$/)
    expect(detail).toMatchObject({ storyCode: 'US-2026-045227', requirementDetail: '正文' })
  })

  it('详情超过 15 秒仍能成功读取正文；无 UUID 的调用继续支持编号', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (_url: unknown) => new Response(JSON.stringify({ field_values: { gf_description: '正文' } })))
    // 响应头立即返回，模拟正文读取耗时 20 秒。
    fetchMock.mockImplementationOnce(async () => ({
      ok: true, status: 200,
      json: () => new Promise((resolve) => setTimeout(() => resolve({ description: '正文' }), 20_000)),
    }) as Response)
    vi.stubGlobal('fetch', fetchMock)
    const result = fetchLinkyStoryDetail('US-1')
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(result).resolves.toMatchObject({ storyCode: 'US-1', requirementDetail: '正文' })
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toMatch(/\/stories\/US-1$/)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['需求详情', fetchLinkyStoryDetail],
    ['附件列表', fetchLinkyAttachments],
  ] as const)('%s 等待 45 秒后超时，不再建议选择项目组', async (label, load) => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(neverRespond))
    const result = load('US-1', undefined, 'issue-uuid')
    const failure = expect(result).rejects.toMatchObject({
      kind: 'TIMEOUT', message: `Linky ${label}响应超过 45 秒，请稍后重新打开详情重试。`,
    })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    await failure
    expect(vi.getTimerCount()).toBe(0)
  })

  it('关闭详情时立即取消请求并释放超时计时器', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(neverRespond))
    const controller = new AbortController()
    const result = fetchLinkyStoryDetail('US-1', controller.signal, 'issue-uuid')
    const failure = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await failure
    expect(vi.getTimerCount()).toBe(0)
  })

  it('按组取数一次读满 200 条，让发布窗口等本地筛选拿到全组口径', async () => {
    const story = (code: string) => ({ id: code, code, workspace_id: 'group', workspace_name: '工具开发组' })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: Array.from({ length: 200 }, (_, index) => story(`US-${index + 1}`)),
        total: 275,
        scopes: 1,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: Array.from({ length: 75 }, (_, index) => story(`US-${index + 201}`)),
        total: 275,
        scopes: 1,
      })))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchLinkyStories({ workspaceName: '工具开发组' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('page_size')).toBe('200')
    expect(result.stories).toHaveLength(275)
    expect(result.total).toBe(275)
  })

  it('上游 total 虚高时按 maxPages 停下，并如实回报未取全', async () => {
    // 每次调用都要新建 Response：同一个实例的 body 只能读一次。
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      items: [{ id: 'issue-1', code: 'US-1', workspace_id: 'group', workspace_name: '工具开发组' }],
      total: 9402,
      scopes: 1,
    })))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchLinkyStories({ workspaceName: '工具开发组', maxPages: 3 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(result.stories).toHaveLength(3)
    // 已加载条数 < total 就是界面上那条「没取全」告警的判据，不能被抹平成相等。
    expect(result.stories.length).toBeLessThan(result.total)
  })

  it('上游一直不返回时 15 秒结束等待，释放计时器并给出按组查询指引', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(neverRespond))
    const result = fetchLinkyStories({ maxPages: 1 })
    const failure = expect(result).rejects.toMatchObject({ kind: 'TIMEOUT', message: expect.stringContaining('项目组') })
    await vi.advanceTimersByTimeAsync(15_000)
    await failure
    expect(vi.getTimerCount()).toBe(0)
  })

  it('离开页面取消查询时不误报超时或网络故障', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(neverRespond))
    const controller = new AbortController()
    const result = fetchLinkyStories({ signal: controller.signal })
    const failure = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await failure
    expect(vi.getTimerCount()).toBe(0)
  })

  it('响应头返回但正文挂住时同样超时', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: () => neverRespond(_url, init),
    })))
    const result = fetchLinkyStories({ maxPages: 1 })
    const failure = expect(result).rejects.toMatchObject({ kind: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(15_000)
    await failure
  })

  it('指定项目组的所有分页均携带同一名称，不请求跨组列表', async () => {
    const story = (code: string) => ({ id: code, code, workspace_id: 'group', workspace_name: '工具开发组' })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [story('US-1')], total: 2, scopes: 1 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [story('US-2')], total: 2, scopes: 1 })))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchLinkyStories({ workspaceName: '工具开发组' })
    expect(result.stories.map((entry) => entry.storyCode)).toEqual(['US-1', 'US-2'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [index, [url]] of fetchMock.mock.calls.entries()) {
      const parsed = new URL(String(url))
      expect(parsed.searchParams.get('workspace_name')).toBe('工具开发组')
      expect(parsed.searchParams.get('page')).toBe(String(index + 1))
    }
  })
})
