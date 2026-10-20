import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchLinkyStories, fetchLinkyStoryPage } from '../linky-live'

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
  it('看板请求指定的一页后立即返回，不因上游总数大而接着拉其他页', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      items: [{ id: 'issue-3', code: 'US-3', workspace_id: 'group', workspace_name: '工具开发组' }],
      total: 9402,
      scopes: 33,
    })))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchLinkyStoryPage({ page: 3, pageSize: 20 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(url.searchParams.get('page')).toBe('3')
    expect(url.searchParams.get('page_size')).toBe('20')
    expect(result.total).toBe(9402)
    expect(result.stories.map((story) => story.storyCode)).toEqual(['US-3'])
  })

  it('远程分页保持项目组和负责人条件，限制上游每页最多 200 条', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [], total: 0, scopes: 1 })))
    vi.stubGlobal('fetch', fetchMock)
    await fetchLinkyStoryPage({ page: -1, pageSize: 999, workspaceName: '工具开发组', assigneeName: '负责人甲' })
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(url.searchParams.get('page')).toBe('1')
    expect(url.searchParams.get('page_size')).toBe('200')
    expect(url.searchParams.get('workspace_name')).toBe('工具开发组')
    expect(url.searchParams.get('assignee_name')).toBe('负责人甲')
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
