import { describe, expect, it } from 'vitest'
import { GitLabReadonlyClient, GitLabReadonlyError } from '../git/gitlab-readonly-client.js'

const BASE = 'https://git.example.com'

interface StubRoute {
  body: unknown
  nextPage?: string
}

/**
 * 按 path+query 精确匹配的 GitLab stub。
 *
 * 故意不做模糊匹配：这个测试要守住的正是"请求打到了哪个 endpoint、带了哪个 author_id"，
 * 模糊匹配会让 URL 拼错的回归悄悄通过。
 */
function stubFetch(routes: Record<string, StubRoute>, calls: string[] = []) {
  const impl = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input))
    const key = `${url.pathname}?${[...url.searchParams.entries()]
      .filter(([name]) => name !== 'per_page' && name !== 'page')
      .map(([name, value]) => `${name}=${value}`)
      .sort()
      .join('&')}`
    calls.push(key)
    const route = routes[key]
    if (route === undefined) {
      return new Response('[]', { status: 404, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify(route.body), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        ...(route.nextPage === undefined ? {} : { 'x-next-page': route.nextPage }),
      },
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const NOW = new Date('2026-09-20T00:00:00.000Z')
const UPDATED_AFTER = new Date(NOW.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString()

function mrListKey(project: string, authorId: string): string {
  return `/api/v4/projects/${encodeURIComponent(project)}/merge_requests`
    + `?author_id=${authorId}&order_by=updated_at&scope=all&sort=desc&state=all`
    + `&updated_after=${UPDATED_AFTER}`
}

function mrCommitsKey(project: string, iid: number): string {
  return `/api/v4/projects/${encodeURIComponent(project)}/merge_requests/${iid}/commits?`
}

describe('GitLabReadonlyClient.discoverAuthorCommitEmails', () => {
  it('用用户名换 id，再从他自己的 MR 里聚合出提交邮箱候选', async () => {
    const { impl, calls } = stubFetch({
      '/api/v4/users?username=yuxuan_xue': {
        body: [{ id: 1001, username: 'yuxuan_xue', name: '薛宇轩' }],
      },
      [mrListKey('kwork/manage/tmanage-backend', '1001')]: {
        body: [
          { iid: 3725, updated_at: '2026-09-19T02:00:00Z' },
          { iid: 3611, updated_at: '2026-09-15T02:00:00Z' },
        ],
      },
      [mrListKey('kwork/manage/kdmanage-backend', '1001')]: {
        body: [{ iid: 88, updated_at: '2026-09-10T02:00:00Z' }],
      },
      [mrListKey('kwork/manage/kdmanage-frontend', '1001')]: { body: [] },
      [mrListKey('kwork/manage/tmanage-frontend', '1001')]: { body: [] },
      [mrCommitsKey('kwork/manage/tmanage-backend', 3725)]: {
        body: [
          {
            id: 'a'.repeat(40),
            author_email: 'YuXuan.Xue@Kingdee.com',
            author_name: '薛宇轩',
            committed_date: '2026-09-18T10:00:00+08:00',
          },
          {
            // 同一封邮箱的第二条提交：计数要去重到 sha，而不是重复累加同一个 sha
            id: 'b'.repeat(40),
            author_email: 'yuxuan.xue@kingdee.com',
            author_name: 'yuxuan_xue',
            committed_date: '2026-09-19T11:00:00+08:00',
          },
          { id: 'b'.repeat(40), author_email: 'yuxuan.xue@kingdee.com', author_name: 'yuxuan_xue' },
        ],
      },
      [mrCommitsKey('kwork/manage/tmanage-backend', 3611)]: {
        body: [
          {
            id: 'c'.repeat(40),
            author_email: '17751361028@163.com',
            author_name: 'xyx',
            committed_date: '2026-09-11T09:00:00+08:00',
          },
          // 残缺记录：没有 sha 或邮箱形状不对的一律丢掉，不能让整次查找失败
          { id: 'd'.repeat(40), author_email: 'not-an-email' },
          { author_email: 'missing.sha@kingdee.com' },
        ],
      },
      [mrCommitsKey('kwork/manage/kdmanage-backend', 88)]: {
        body: [
          {
            id: 'e'.repeat(40),
            author_email: 'yuxuan.xue@kingdee.com',
            author_name: '薛宇轩',
            committed_date: '2026-09-09T09:00:00+08:00',
          },
        ],
      },
    })
    const client = new GitLabReadonlyClient({
      baseUrl: BASE,
      apiToken: 'test-token',
      fetchImpl: impl,
      now: () => NOW,
    })

    const result = await client.discoverAuthorCommitEmails({
      gitlabUsername: 'yuxuan_xue',
      lookbackDays: 365,
    })

    expect(result.gitlabUserId).toBe('1001')
    expect(result.gitlabDisplayName).toBe('薛宇轩')
    expect(result.mergeRequestCount).toBe(3)
    expect(result.partial).toBe(false)
    expect(result.candidates).toEqual([
      {
        email: 'yuxuan.xue@kingdee.com',
        author_names: ['yuxuan_xue', '薛宇轩'],
        commit_count: 3,
        last_committed_at: '2026-09-19T11:00:00+08:00',
        repositories: { 'kdmanage-backend': 1, 'tmanage-backend': 2 },
        merge_request_refs: ['kdmanage-backend!88', 'tmanage-backend!3725'],
      },
      {
        email: '17751361028@163.com',
        author_names: ['xyx'],
        commit_count: 1,
        last_committed_at: '2026-09-11T09:00:00+08:00',
        repositories: { 'tmanage-backend': 1 },
        merge_request_refs: ['tmanage-backend!3611'],
      },
    ])
    // 四个白名单仓库各问一次 MR 列表，且只问白名单
    expect(calls.filter((call) => call.includes('/merge_requests?')).length).toBe(4)
    expect(calls.some((call) => call.includes('not-in-whitelist'))).toBe(false)
  })

  it('大小写不同的用户名可以匹配，但必须是精确用户名而不是模糊命中', async () => {
    const { impl } = stubFetch({
      '/api/v4/users?username=YuXuan_Xue': {
        body: [
          { id: 7, username: 'yuxuan_xue_2', name: '同名的另一个人' },
          { id: 8, username: 'YUXUAN_XUE', name: '薛宇轩' },
        ],
      },
      [mrListKey('kwork/manage/kdmanage-backend', '8')]: { body: [] },
      [mrListKey('kwork/manage/kdmanage-frontend', '8')]: { body: [] },
      [mrListKey('kwork/manage/tmanage-backend', '8')]: { body: [] },
      [mrListKey('kwork/manage/tmanage-frontend', '8')]: { body: [] },
    })
    const client = new GitLabReadonlyClient({
      baseUrl: BASE, apiToken: 'test-token', fetchImpl: impl, now: () => NOW,
    })
    const result = await client.discoverAuthorCommitEmails({
      gitlabUsername: 'YuXuan_Xue',
      lookbackDays: 365,
    })
    expect(result.gitlabUserId).toBe('8')
    expect(result.candidates).toEqual([])
  })

  it('用户名查不到时以 GITLAB_USER_NOT_FOUND 失败', async () => {
    const { impl } = stubFetch({ '/api/v4/users?username=ghost': { body: [] } })
    const client = new GitLabReadonlyClient({
      baseUrl: BASE, apiToken: 'test-token', fetchImpl: impl, now: () => NOW,
    })
    await expect(client.discoverAuthorCommitEmails({
      gitlabUsername: 'ghost', lookbackDays: 365,
    })).rejects.toMatchObject({ code: 'GITLAB_USER_NOT_FOUND' })
  })

  it('没有配 API token 时立刻失败，而不是静默返回空候选', async () => {
    const client = new GitLabReadonlyClient({ baseUrl: BASE, apiToken: null })
    await expect(client.discoverAuthorCommitEmails({
      gitlabUsername: 'yuxuan_xue', lookbackDays: 365,
    })).rejects.toMatchObject({ code: 'GITLAB_API_TOKEN_MISSING' })
  })

  it('用户名形状不合法时不发任何请求', async () => {
    const { impl, calls } = stubFetch({})
    const client = new GitLabReadonlyClient({
      baseUrl: BASE, apiToken: 'test-token', fetchImpl: impl, now: () => NOW,
    })
    await expect(client.discoverAuthorCommitEmails({
      gitlabUsername: 'bad name!', lookbackDays: 365,
    })).rejects.toBeInstanceOf(GitLabReadonlyError)
    expect(calls).toEqual([])
  })

  it('单个仓库读失败只标 partial，其余仓库的候选照常返回', async () => {
    const { impl } = stubFetch({
      '/api/v4/users?username=yuxuan_xue': {
        body: [{ id: 1001, username: 'yuxuan_xue', name: '薛宇轩' }],
      },
      // kdmanage-* 两个仓库没有路由 → stub 返回 404 → 被计入 partial
      [mrListKey('kwork/manage/tmanage-backend', '1001')]: {
        body: [{ iid: 1, updated_at: '2026-09-19T02:00:00Z' }],
      },
      [mrListKey('kwork/manage/tmanage-frontend', '1001')]: { body: [] },
      [mrCommitsKey('kwork/manage/tmanage-backend', 1)]: {
        body: [{
          id: 'f'.repeat(40),
          author_email: 'yuxuan.xue@kingdee.com',
          author_name: '薛宇轩',
          committed_date: '2026-09-19T11:00:00+08:00',
        }],
      },
    })
    const client = new GitLabReadonlyClient({
      baseUrl: BASE, apiToken: 'test-token', fetchImpl: impl, now: () => NOW,
    })
    const result = await client.discoverAuthorCommitEmails({
      gitlabUsername: 'yuxuan_xue', lookbackDays: 365,
    })
    expect(result.partial).toBe(true)
    expect(result.candidates.map((candidate) => candidate.email)).toEqual(['yuxuan.xue@kingdee.com'])
  })

  it('MR 数超过上限时截断并标 partial，先取最近更新的', async () => {
    const many = Array.from({ length: 5 }, (_value, index) => ({
      iid: index + 1,
      updated_at: `2026-09-${String(10 + index).padStart(2, '0')}T02:00:00Z`,
    }))
    const routes: Record<string, StubRoute> = {
      '/api/v4/users?username=yuxuan_xue': {
        body: [{ id: 1001, username: 'yuxuan_xue' }],
      },
      [mrListKey('kwork/manage/tmanage-backend', '1001')]: { body: many },
      [mrListKey('kwork/manage/tmanage-frontend', '1001')]: { body: [] },
      [mrListKey('kwork/manage/kdmanage-backend', '1001')]: { body: [] },
      [mrListKey('kwork/manage/kdmanage-frontend', '1001')]: { body: [] },
    }
    // 只有最近两个 MR（iid 5、4）应该被读取
    routes[mrCommitsKey('kwork/manage/tmanage-backend', 5)] = {
      body: [{ id: '5'.repeat(40), author_email: 'newest@kingdee.com', committed_date: '2026-09-14T02:00:00Z' }],
    }
    routes[mrCommitsKey('kwork/manage/tmanage-backend', 4)] = {
      body: [{ id: '4'.repeat(40), author_email: 'newest@kingdee.com', committed_date: '2026-09-13T02:00:00Z' }],
    }
    const { impl, calls } = stubFetch(routes)
    const client = new GitLabReadonlyClient({
      baseUrl: BASE, apiToken: 'test-token', fetchImpl: impl, now: () => NOW,
    })
    const result = await client.discoverAuthorCommitEmails({
      gitlabUsername: 'yuxuan_xue', lookbackDays: 365, maxMergeRequests: 2,
    })
    expect(result.mergeRequestCount).toBe(2)
    expect(result.partial).toBe(true)
    expect(result.candidates).toEqual([{
      email: 'newest@kingdee.com',
      author_names: [],
      commit_count: 2,
      last_committed_at: '2026-09-14T02:00:00Z',
      repositories: { 'tmanage-backend': 2 },
      merge_request_refs: ['tmanage-backend!4', 'tmanage-backend!5'],
    }])
    expect(calls.filter((call) => call.includes('/commits?'))).toEqual([
      mrCommitsKey('kwork/manage/tmanage-backend', 5),
      mrCommitsKey('kwork/manage/tmanage-backend', 4),
    ])
  })
})
