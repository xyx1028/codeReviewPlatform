import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchLinkyStories } from '../linky-live'

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
