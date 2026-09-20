import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitLabReadonlyClient } from '../git/gitlab-readonly-client.js'
import { buildStoryScopes } from '../pipeline/story-scope.js'
import type { CollectedRepositoryHistory } from '../git/story-history.js'

const TOKEN = 'mr-api-token-that-must-never-leak'
const COMMIT_SHA = 'a'.repeat(40)
const MERGE_SHA = 'b'.repeat(40)
const SQUASH_SHA = 'c'.repeat(40)
const servers: ReturnType<typeof createServer>[] = []

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: ReturnType<typeof createServer>; baseUrl: string }> {
  const server = createServer(handler)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

function json(response: ServerResponse, value: unknown, nextPage = ''): void {
  const body = JSON.stringify(value)
  response.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'x-next-page': nextPage,
  })
  response.end(body)
}

function mr(iid: number) {
  return {
    iid,
    title: iid === 17 ? 'Story-Id: REQ-0010' : 'Ordinary MR',
    description: iid === 17 ? 'Story-Id: REQ-001\nMentions REQ-0010-extra only as prose' : null,
    source_branch: iid === 17 ? 'feature/REQ-001-demo' : 'feature/other',
    target_branch: 'feature_dev',
    author: { id: 77, username: 'developer', name: 'Developer' },
    created_at: '2026-09-18T00:00:00Z',
    updated_at: '2026-09-19T00:00:00Z',
    merged_at: '2026-09-19T00:01:00Z',
    merge_commit_sha: iid === 17 ? MERGE_SHA : null,
    squash_commit_sha: iid === 17 ? SQUASH_SHA : null,
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections?.()
  })))
})

describe('GitLabReadonlyClient local HTTP boundary', () => {
  it('paginates MR and commit endpoints with PRIVATE-TOKEN and maps merge/squash membership', async () => {
    const requests: Array<{ url: string; token: string | undefined }> = []
    const { baseUrl } = await listen((request, response) => {
      requests.push({
        url: request.url ?? '',
        token: request.headers['private-token'] as string | undefined,
      })
      const url = new URL(request.url ?? '/', 'http://localhost')
      const page = url.searchParams.get('page')
      if (url.pathname.endsWith('/merge_requests')) {
        json(response, page === '1' ? [mr(17)] : [mr(18)], page === '1' ? '2' : '')
        return
      }
      if (url.pathname.endsWith('/merge_requests/17/commits')) {
        json(response, page === '1' ? [{ id: COMMIT_SHA }] : [{ id: MERGE_SHA }], page === '1' ? '2' : '')
        return
      }
      if (url.pathname.endsWith('/merge_requests/18/commits')) {
        json(response, [])
        return
      }
      response.writeHead(404).end()
    })

    const result = await new GitLabReadonlyClient({
      baseUrl,
      apiToken: TOKEN,
      now: () => new Date('2026-09-19T01:00:00Z'),
    }).collectRepositoryMergeRequests({
      repository: 'kdmanage-backend',
      targetBranch: 'feature_dev',
      rangeStartAt: '2026-09-18T00:00:00Z',
      rangeEndAt: '2026-09-20T00:00:00Z',
      storyCodes: ['REQ-001', 'REQ-0010'],
    })

    expect(result).toMatchObject({ status: 'COMPLETE', errorCode: null })
    expect(result.mergeRequests).toHaveLength(2)
    expect(result.mergeRequests[0]).toMatchObject({
      provider_project_id: 'kwork/manage/kdmanage-backend',
      merge_request_iid: 17,
      author_username: 'developer',
      author_provider_id: '77',
      structured_story_ids: ['REQ-001', 'REQ-0010'],
      merge_commit_sha: MERGE_SHA,
      squash_commit_sha: SQUASH_SHA,
      metadata_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })
    expect(result.mergeRequests[0]!.commits).toEqual([
      { sha: COMMIT_SHA, membership_type: 'COMMIT' },
      { sha: MERGE_SHA, membership_type: 'COMMIT' },
      { sha: MERGE_SHA, membership_type: 'MERGE_COMMIT' },
      { sha: SQUASH_SHA, membership_type: 'SQUASH_COMMIT' },
    ])
    expect(requests).toHaveLength(5)
    expect(requests.every((request) => request.token === TOKEN)).toBe(true)
    expect(requests.every((request) => !request.url.includes(TOKEN))).toBe(true)
    expect(requests[0]!.url).toContain('target_branch=feature_dev')
    expect(requests[0]!.url).toContain('updated_after=')
  })

  it('returns unavailable without making any network request when token is blank', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const result = await new GitLabReadonlyClient({
      baseUrl: 'https://git.example.com',
      apiToken: '   ',
      fetchImpl,
    }).collectRepositoryMergeRequests({
      repository: 'tmanage-backend',
      targetBranch: 'release',
      rangeStartAt: '2026-09-01T00:00:00Z',
      rangeEndAt: '2026-09-20T00:00:00Z',
      storyCodes: ['REQ-001'],
    })

    expect(result).toEqual({
      repository: 'tmanage-backend',
      status: 'UNAVAILABLE',
      errorCode: 'MR_METADATA_UNAVAILABLE',
      mergeRequests: [],
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not follow redirects and therefore never forwards PRIVATE-TOKEN to another origin', async () => {
    const leakedHeaders: Array<string | undefined> = []
    const sink = await listen((request, response) => {
      leakedHeaders.push(request.headers['private-token'] as string | undefined)
      response.writeHead(200, { 'content-type': 'application/json' }).end('[]')
    })
    const source = await listen((_request, response) => {
      response.writeHead(302, { location: `${sink.baseUrl}/stolen` }).end()
    })

    const result = await new GitLabReadonlyClient({
      baseUrl: source.baseUrl,
      apiToken: TOKEN,
    }).collectRepositoryMergeRequests({
      repository: 'kdmanage-frontend',
      targetBranch: 'feature_sit',
      rangeStartAt: '2026-09-18T00:00:00Z',
      rangeEndAt: '2026-09-20T00:00:00Z',
      storyCodes: ['REQ-001'],
    })

    expect(result.status).toBe('FAILED')
    expect(result.errorCode).toBe('MR_METADATA_REQUEST_FAILED')
    expect(leakedHeaders).toEqual([])
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  it('fails closed when the configured pagination ceiling would be exceeded', async () => {
    const { baseUrl } = await listen((_request, response) => json(response, [mr(17)], '2'))
    const result = await new GitLabReadonlyClient({
      baseUrl,
      apiToken: TOKEN,
      maxPages: 1,
    }).collectRepositoryMergeRequests({
      repository: 'kdmanage-backend',
      targetBranch: 'feature_dev',
      rangeStartAt: '2026-09-18T00:00:00Z',
      rangeEndAt: '2026-09-20T00:00:00Z',
      storyCodes: ['REQ-001'],
    })
    expect(result).toMatchObject({ status: 'FAILED', errorCode: 'MR_METADATA_PAGE_LIMIT' })
  })

  it('enforces request timeout without including the token in the result', async () => {
    const { baseUrl } = await listen(() => undefined)
    const result = await new GitLabReadonlyClient({
      baseUrl,
      apiToken: TOKEN,
      timeoutMs: 100,
    }).collectRepositoryMergeRequests({
      repository: 'tmanage-frontend',
      targetBranch: 'release',
      rangeStartAt: '2026-09-18T00:00:00Z',
      rangeEndAt: '2026-09-20T00:00:00Z',
      storyCodes: [],
    })
    expect(result).toMatchObject({ status: 'FAILED', errorCode: 'MR_METADATA_TIMEOUT' })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  it('keeps valid MR metadata and reports PARTIAL when one commits endpoint fails', async () => {
    const { baseUrl } = await listen((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname.endsWith('/merge_requests')) return json(response, [mr(17), mr(18)])
      if (url.pathname.endsWith('/merge_requests/17/commits')) return json(response, [{ id: COMMIT_SHA }])
      response.writeHead(403, { 'content-type': 'application/json' }).end('{}')
    })
    const result = await new GitLabReadonlyClient({ baseUrl, apiToken: TOKEN })
      .collectRepositoryMergeRequests({
        repository: 'kdmanage-backend',
        targetBranch: 'feature_dev',
        rangeStartAt: '2026-09-18T00:00:00Z',
        rangeEndAt: '2026-09-20T00:00:00Z',
        storyCodes: ['REQ-001'],
      })
    expect(result).toMatchObject({
      status: 'PARTIAL',
      errorCode: 'MR_METADATA_PERMISSION_DENIED',
    })
    expect(result.mergeRequests).toHaveLength(2)
    expect(result.mergeRequests[0]!.commits).toContainEqual({
      sha: COMMIT_SHA,
      membership_type: 'COMMIT',
    })
  })

  it('rejects a project outside the four-repository whitelist before fetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = new GitLabReadonlyClient({
      baseUrl: 'https://git.example.com',
      apiToken: TOKEN,
      fetchImpl,
    })
    await expect(client.collectRepositoryMergeRequests({
      repository: 'outside-project' as never,
      targetBranch: 'feature_dev',
      rangeStartAt: '2026-09-18T00:00:00Z',
      rangeEndAt: '2026-09-20T00:00:00Z',
      storyCodes: [],
    })).rejects.toThrow('repository not in whitelist')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('MR enrichment attribution integration', () => {
  it('turns a structured MR Story-Id into a strong candidate using the shared parser boundary', () => {
    const history: CollectedRepositoryHistory = {
      manifest: {
        schema_version: 1,
        repository: 'kdmanage-backend',
        base_sha: 'f'.repeat(40),
        head_sha: COMMIT_SHA,
        head_subject: 'ordinary commit',
        range_source: 'TIME_DERIVED',
        range_fallback_reason: null,
        range_start_at: '2026-09-18T00:00:00Z',
        range_end_at: '2026-09-20T00:00:00Z',
        head_resolved_at: '2026-09-20T00:00:00Z',
        ancestry_status: 'VERIFIED',
        enumeration_status: 'COMPLETE',
        commit_count: 1,
        commits: [{
          sha: COMMIT_SHA,
          subject: 'ordinary commit',
          message_body: '',
          author_name: 'Unknown',
          author_identity_status: 'UNAVAILABLE',
          files: [],
          effective_status: 'EFFECTIVE',
          is_revert: false,
        }],
      },
      manifestHash: `sha256:${'1'.repeat(64)}`,
      canonicalManifest: null,
      historyPath: '/tmp/not-used',
      deepenCount: 0,
    }
    const mergeRequest = {
      provider_project_id: 'kwork/manage/kdmanage-backend',
      merge_request_iid: 17,
      title: 'Story-Id: REQ-001',
      description: null,
      source_branch: 'feature/REQ-001-demo',
      target_branch: 'feature_dev',
      author_username: 'developer',
      author_provider_id: '77',
      author_display_name: 'Developer',
      provider_created_at: '2026-09-18T00:00:00.000Z',
      provider_updated_at: '2026-09-19T00:00:00.000Z',
      merged_at: '2026-09-19T00:00:00.000Z',
      merge_commit_sha: null,
      squash_commit_sha: null,
      structured_story_ids: ['REQ-001'],
      metadata_hash: `sha256:${'2'.repeat(64)}`,
      collected_at: '2026-09-19T01:00:00.000Z',
      commits: [{ sha: COMMIT_SHA, membership_type: 'COMMIT' as const }],
    }
    const built = buildStoryScopes({
      stories: [{
        task_id: '11111111-2222-4333-8444-555555555555',
        story_id: '66666666-7777-4888-8999-aaaaaaaaaaaa',
        story_code: 'REQ-001',
        story_name: 'MR-linked story',
        owners_text: 'Developer',
        normalized_developer_ids: [],
        project_name: null,
        application_name: null,
        release_window: null,
        requirement_context: {},
        input_hash: '3'.repeat(64),
      }],
      identities: [],
      histories: [history],
      mergeRequests: [{
        repository: 'kdmanage-backend',
        status: 'COMPLETE',
        errorCode: null,
        mergeRequests: [mergeRequest],
      }],
      rulesetHash: '4'.repeat(64),
    })

    expect(built.scopes[0]).toMatchObject({
      scope_mode: 'EXACT_STORY_COMMITS',
      status: 'READY',
      candidates: [expect.objectContaining({
        sha: COMMIT_SHA,
        tier: 'STRONG',
        story_match_location: 'MR',
        rule_code: 'ATTR_EXPLICIT_MR_STORY_ID',
        reason_codes: expect.arrayContaining(['EXPLICIT_MR_STORY_ID']),
      })],
    })
  })
})
