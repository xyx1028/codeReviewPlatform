import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeConfigHash, resolveProfileTemplateDir } from '../ai/acp/profile-materializer.js'
import { buildAgentReviewPrompt } from '../ai/prompts/agent-review.js'
import { buildScopedStoryDescription } from '../ai/runtime/factory.js'
import type { WorkerConfig } from '../config.js'
import type { JobsDb, PreparationClaim } from '../db/jobs.js'
import { collectRepositoryHistory, type CollectedRepositoryHistory } from '../git/story-history.js'
import { runCommand } from '../git/run.js'
import type { RepositoryName } from '../git/repositories.js'
import { Logger } from '../logger.js'
import { REPOSITORY_NAMES } from '../git/repositories.js'
import { prepareJob } from '../pipeline/prepare-job.js'
import { buildStoryScopes } from '../pipeline/story-scope.js'
import { DISABLED_LINKY_CONFIG } from './helpers/worker-config.js'

const roots: string[] = []
const silentLogger = new Logger({ sink: () => undefined, minLevel: 'error' })

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'v111-worker-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function config(root: string): WorkerConfig {
  return {
    supabaseUrl: 'https://project.supabase.co',
    supabaseServiceRoleKey: 'service-role-test-value',
    gitAuthMode: 'local',
    gitlabBaseUrl: 'https://git.example.com',
    gitlabDeployUser: null,
    gitlabDeployToken: null,
    gitlabApiToken: null,
    workerId: 'worker-v111',
    workspaceRoot: join(root, 'jobs'),
    codeCacheRoot: join(root, 'cache'),
    codeCacheMaxBytes: 1024 * 1024 * 1024,
    pollIntervalMs: 1000,
    storyTaskLeaseSeconds: 900,
    heartbeatIntervalMs: 30000,
    workerStoryConcurrency: 2,
    modelConnectivityTestLeaseSeconds: 90,
    gitEmailDiscoveryLeaseSeconds: 90,
    modelConnectivityProxy: null,
    linky: DISABLED_LINKY_CONFIG,
    agentAttemptsRoot: join(root, 'attempts'),
    skillCacheRoot: join(root, 'skills'),
    skillCacheMaxBytes: 1024 * 1024,
    modelImageInputEnabled: false,
    sessionRoot: join(root, 'sessions'),
    sessionRetentionDays: 7,
    sessionVolumeMaxBytes: 1024 * 1024,
    orphanWorkspaceMaxAgeMs: 60_000,
    // V1.23：问答轮询开关。测试里关掉 —— 这些用例验证的是评审链路。
    codeQa: { enabled: false, leaseSeconds: 600, turnTimeoutMs: 900000 },
    runtimeEvents: { enabled: false, flushMs: 800, queueMax: 512, batchMax: 64, retentionDays: 30 },
  }
}

function history(repository: string, sha: string): CollectedRepositoryHistory {
  return {
    manifest: {
      schema_version: 1,
      repository,
      base_sha: '0'.repeat(40),
      head_sha: sha,
      head_subject: 'Story implementation',
      range_source: 'TIME_DERIVED',
      range_fallback_reason: null,
      range_start_at: '2026-09-01T00:00:00.000Z',
      range_end_at: '2026-09-19T00:00:00.000Z',
      head_resolved_at: '2026-09-19T00:00:00.000Z',
      ancestry_status: 'VERIFIED',
      enumeration_status: 'COMPLETE',
      commit_count: 1,
      commits: [{
        sha,
        sequence_no: 0,
        parent_shas: ['0'.repeat(40)],
        tree_sha: '1'.repeat(40),
        author_name: 'Developer',
        author_email_fingerprint: '2'.repeat(64),
        author_email_masked: 'd***@example.com',
        authored_at: '2026-09-18T00:00:00.000Z',
        committer_name: 'Developer',
        committer_email_fingerprint: '2'.repeat(64),
        committer_email_masked: 'd***@example.com',
        committed_at: '2026-09-18T00:00:00.000Z',
        subject: 'Implement PRJ-001',
        message_body: 'Story-Id: PRJ-001',
        trailers: { 'Story-Id': ['PRJ-001'] },
        is_merge: false,
        is_revert: false,
        effective_status: 'EFFECTIVE',
        files: [],
      }],
    },
    manifestHash: `sha256:${'3'.repeat(64)}`,
    canonicalManifest: null,
    historyPath: '/local/history',
    deepenCount: 256,
  }
}

describe('V1.11 preparation integration', () => {
  it('keeps v1 on the canonical snapshot RPC and runs the complete v2 sequence only for v2', async () => {
    const root = tempRoot()
    const calls: string[] = []
    const taskId = '11111111-2222-4333-8444-555555555555'
    const jobsDb = {
      saveRepositorySnapshots: vi.fn(async () => { calls.push('legacy-snapshots') }),
      freezeAnalysisJobScopeInputs: vi.fn(async () => {
        calls.push('freeze-inputs')
        return {
          story_input_catalog_hash: '4'.repeat(64),
          identity_snapshot_hash: '5'.repeat(64),
          rule_version_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          ruleset_hash: '6'.repeat(64),
          idempotent: false,
          stories: [{
            task_id: taskId,
            story_id: '77777777-8888-4999-8aaa-bbbbbbbbbbbb',
            story_code: 'PRJ-001',
            story_name: 'Demo',
            owners_text: 'Developer',
            normalized_developer_ids: [],
            project_name: null,
            application_name: null,
            release_window: null,
            requirement_context: {},
            input_hash: '7'.repeat(64),
          }],
          identities: [],
        }
      }),
      saveAnalysisRepositoryCommitManifest: vi.fn(async () => { calls.push('manifest'); return {} }),
      saveAnalysisRepositoryMergeRequests: vi.fn(async () => { calls.push('persist-mr'); return {} }),
      saveAnalysisStoryScopes: vi.fn(async () => { calls.push('scopes'); return {} }),
      finalizeAnalysisStoryScope: vi.fn(async () => { calls.push('finalize'); return {} }),
      failClaimedAnalysisJob: vi.fn(async () => undefined),
    } as unknown as JobsDb
    const repositoryPreparer = vi.fn(async (repository: string, branch: string) => ({
      repository,
      branch,
      commitSha: 'a'.repeat(40),
      commitSubject: 'head',
      path: join(root, repository),
      cached: true,
    })) as never
    const historyCollector = vi.fn(async (input: { prepared: { repository: string; commitSha: string } }) => {
      calls.push(`history:${input.prepared.repository}`)
      return history(input.prepared.repository, input.prepared.commitSha)
    }) as never
    const gitlabClient = {
      collectRepositoryMergeRequests: vi.fn(async (input: { repository: RepositoryName }) => {
        calls.push(`mr:${input.repository}`)
        return {
          repository: input.repository,
          status: 'FAILED' as const,
          errorCode: 'MR_METADATA_PERMISSION_DENIED',
          mergeRequests: [],
        }
      }),
    }
    const base: PreparationClaim = {
      job: {
        id: 'job-v111', batch_id: 'batch-v111', model_config_id: 'model-v111',
        requested_branch: 'feature_dev', total_stories: 1,
      },
      model: {
        model_config_id: 'model-v111', display_name: 'Model', base_url: 'https://model.example/v1',
        model_name: 'model', request_timeout_ms: 1000,
      },
    }

    await prepareJob(jobsDb, config(root), base, silentLogger, repositoryPreparer)
    expect(calls).toEqual(['legacy-snapshots'])

    calls.length = 0
    await prepareJob(
      jobsDb,
      config(root),
      { ...base, job: { ...base.job, analysis_context_version: 2, required_worker_scope_version: 2, commit_window_days: 21 } },
      silentLogger,
      repositoryPreparer,
      undefined,
      historyCollector,
      gitlabClient,
    )
    // 每个受评审仓库一轮 history → manifest → mr → persist-mr，顺序按白名单。
    expect(calls).toEqual([
      'legacy-snapshots', 'freeze-inputs',
      ...REPOSITORY_NAMES.flatMap((repository) => [
        `history:${repository}`, 'manifest', `mr:${repository}`, 'persist-mr',
      ]),
      'scopes', 'finalize',
    ])
    expect(jobsDb.saveRepositorySnapshots).toHaveBeenCalledTimes(2)
    expect(jobsDb.saveAnalysisRepositoryMergeRequests).toHaveBeenCalledTimes(REPOSITORY_NAMES.length)
    expect(vi.mocked(jobsDb.saveAnalysisRepositoryMergeRequests).mock.calls.every(
      ([input]) => input.status === 'FAILED'
        && input.errorCode === 'MR_METADATA_PERMISSION_DENIED'
        && input.mergeRequests.length === 0,
    )).toBe(true)
    expect(jobsDb.failClaimedAnalysisJob).not.toHaveBeenCalled()
    const scopeCall = vi.mocked(jobsDb.saveAnalysisStoryScopes).mock.calls[0]![0]
    expect(scopeCall.scopes[0]).toMatchObject({
      task_id: taskId,
      scope_mode: 'EXACT_STORY_COMMITS',
      status: 'READY',
    })
  })

  it('fails closed when foundation freeze does not return frozen Story details', async () => {
    const root = tempRoot()
    const jobsDb = {
      saveRepositorySnapshots: vi.fn(async () => undefined),
      freezeAnalysisJobScopeInputs: vi.fn(async () => ({
        story_input_catalog_hash: 'a'.repeat(64), identity_snapshot_hash: 'b'.repeat(64),
        rule_version_id: 'id', ruleset_hash: 'c'.repeat(64), idempotent: false,
      })),
      failClaimedAnalysisJob: vi.fn(async () => undefined),
    } as unknown as JobsDb
    const claim: PreparationClaim = {
      job: { id: 'job', batch_id: 'batch', model_config_id: 'model', requested_branch: 'feature_dev', total_stories: 1, analysis_context_version: 2 },
      model: { model_config_id: 'model', display_name: 'Model', base_url: 'https://model.example', model_name: 'model' },
    }
    const prepare = vi.fn(async (repository: string, branch: string) => ({ repository, branch, commitSha: 'a'.repeat(40), commitSubject: '', path: root, cached: true })) as never
    await expect(prepareJob(jobsDb, config(root), claim, silentLogger, prepare)).rejects.toMatchObject({ code: 'ANALYSIS_SCOPE_INPUTS_MISSING' })
    expect(jobsDb.failClaimedAnalysisJob).toHaveBeenCalled()
  })

describe('V1.11 identity match status projection', () => {
  it('maps MATCHED, UNMATCHED, and CONFLICT without guessing identity strength', () => {
    const taskId = '12111111-2222-4333-8444-555555555555'
    const matched = history('kdmanage-backend', 'a'.repeat(40))
    const unmatched = history('kdmanage-frontend', 'b'.repeat(40))
    const conflict = history('tmanage-backend', 'c'.repeat(40))
    Object.assign(matched.manifest.commits[0]!, {
      author_identity_status: 'MATCHED',
      author_developer_id: 'developer-1',
      author_email_fingerprint: '2'.repeat(64),
    })
    Object.assign(unmatched.manifest.commits[0]!, {
      author_name: 'Unknown Author',
      author_identity_status: 'UNMATCHED',
      author_developer_id: null,
      author_email_fingerprint: '3'.repeat(64),
    })
    Object.assign(conflict.manifest.commits[0]!, {
      author_identity_status: 'CONFLICT',
      author_developer_id: null,
      author_email_fingerprint: '4'.repeat(64),
    })

    const built = buildStoryScopes({
      stories: [{
        task_id: taskId,
        story_id: '77777777-8888-4999-8aaa-bbbbbbbbbbbb',
        story_code: 'PRJ-001',
        story_name: 'Identity projection',
        owners_text: 'Developer',
        normalized_developer_ids: ['developer-1'],
        project_name: null,
        application_name: null,
        release_window: null,
        requirement_context: {},
        input_hash: '7'.repeat(64),
      }],
      identities: [{
        developer_id: 'developer-1',
        display_name: 'Developer',
        email_fingerprint: '2'.repeat(64),
        author_name_aliases: ['Developer'],
        verification_status: 'VERIFIED',
      }],
      histories: [matched, unmatched, conflict],
      rulesetHash: '6'.repeat(64),
    })

    const candidates = built.scopes[0]!.candidates
    expect(candidates.find((candidate) => candidate.sha === 'a'.repeat(40))?.identity_match_type).toBe('VERIFIED_EMAIL')
    expect(candidates.find((candidate) => candidate.sha === 'b'.repeat(40))?.identity_match_type).toBe('NONE')
    expect(candidates.find((candidate) => candidate.sha === 'c'.repeat(40))?.identity_match_type).toBe('AMBIGUOUS')
  })
})
})

describe('local Git history collection', () => {
  it('explicitly deepens a depth-1 local object cache and returns a complete range', async () => {
    const root = tempRoot()
    const remote = join(root, 'remote.git')
    const work = join(root, 'work')
    mkdirSync(work)
    await runCommand('git', ['init', '--bare', remote])
    await runCommand('git', ['init'], { cwd: work })
    await runCommand('git', ['config', 'user.name', 'Developer'], { cwd: work })
    await runCommand('git', ['config', 'user.email', 'developer@example.com'], { cwd: work })
    await runCommand('git', ['checkout', '-b', 'feature_dev'], { cwd: work })
    const commit = async (content: string, date: string, message: string) => {
      writeFileSync(join(work, 'story.txt'), content)
      await runCommand('git', ['add', 'story.txt'], { cwd: work })
      await runCommand('git', ['commit', '-m', message], { cwd: work, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } })
    }
    await commit('one', '2026-09-10T00:00:00Z', 'baseline')
    await commit('two', '2026-09-17T00:00:00Z', 'older base')
    await commit('three', '2026-09-19T12:00:00Z', 'Implement story\n\nStory-Id: PRJ-001')
    await runCommand('git', ['remote', 'add', 'origin', `file://${remote}`], { cwd: work })
    await runCommand('git', ['push', 'origin', 'feature_dev'], { cwd: work })
    const head = (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: work })).stdout.trim()

    const identityMatcher = vi.fn(async (authors: ReadonlyArray<{ inputId: string }>) => authors.map((author) => ({
      input_id: author.inputId,
      email_fingerprint: '9'.repeat(64),
      masked_email: 'd***@example.com',
      match_status: 'MATCHED' as const,
      developer_id: 'developer-1',
    })))
    const result = await collectRepositoryHistory({
      prepared: { repository: 'kdmanage-backend', branch: 'feature_dev', commitSha: head, commitSubject: 'Implement story', path: work, cached: false },
      cacheRoot: join(root, 'cache'),
      branch: 'feature_dev',
      headResolvedAt: '2026-09-19T15:00:00.000Z',
      windowDays: 1,
      identityMatcher,
      prepareOptions: { cacheRoot: join(root, 'cache'), authMode: 'local', timeoutMs: 30_000 },
      remoteUrl: `file://${remote}`,
      deepenStep: 1,
      deepenLimit: 10,
    })

    expect(identityMatcher).toHaveBeenCalledTimes(1)
    expect(result.deepenCount).toBeGreaterThan(0)
    expect(result.manifest.enumeration_status).toBe('COMPLETE')
    expect(result.manifest.commit_count).toBe(1)
    expect(result.manifest.commits[0]).toMatchObject({
      sha: head,
      author_email_fingerprint: '9'.repeat(64),
      author_email_masked: 'd***@example.com',
      author_identity_status: 'MATCHED',
      author_developer_id: 'developer-1',
    })
    expect(JSON.stringify(result.manifest)).not.toContain('developer@example.com')
    expect(result.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/)

    const unavailable = await collectRepositoryHistory({
      prepared: { repository: 'kdmanage-backend', branch: 'feature_dev', commitSha: head, commitSubject: 'Implement story', path: work, cached: false },
      cacheRoot: join(root, 'cache-unavailable'),
      branch: 'feature_dev',
      headResolvedAt: '2026-09-19T15:00:00.000Z',
      windowDays: 1,
      identityMatcher: async () => { throw Object.assign(new Error('matcher unavailable'), { code: 'IDENTITY_PEPPER_MISSING' }) },
      prepareOptions: { cacheRoot: join(root, 'cache-unavailable'), authMode: 'local', timeoutMs: 30_000 },
      remoteUrl: `file://${remote}`,
      deepenStep: 1,
      deepenLimit: 10,
    })
    expect(unavailable.manifest.commits[0]).toMatchObject({
      author_email_fingerprint: null,
      author_email_masked: null,
      author_identity_status: 'UNAVAILABLE',
      committer_identity_status: 'UNAVAILABLE',
    })
    expect(JSON.stringify(unavailable.manifest)).not.toContain('developer@example.com')

    const scopes = buildStoryScopes({
      stories: [{
        task_id: '11111111-2222-4333-8444-555555555555',
        story_id: '66666666-7777-4888-8999-aaaaaaaaaaaa',
        story_code: 'PRJ-001',
        story_name: 'Demo',
        owners_text: 'Developer',
        normalized_developer_ids: ['developer-1'],
        project_name: null,
        application_name: null,
        release_window: null,
        requirement_context: {},
        input_hash: '8'.repeat(64),
      }],
      identities: [],
      histories: [unavailable],
      rulesetHash: '7'.repeat(64),
    })
    expect(scopes.scopes[0]).toMatchObject({
      scope_mode: 'EXACT_STORY_COMMITS',
      status: 'READY',
      candidates: [expect.objectContaining({
        tier: 'STRONG',
        identity_match_type: 'NONE',
        reason_codes: expect.arrayContaining(['EXPLICIT_STORY_ID']),
      })],
    })
  })
})

describe('agent-review-v2 context', () => {
  it('renders the frozen scope and only uses the controlled requirement context', () => {
    const task = {
      story_name: 'Demo story', project_name: 'Project', application_name: 'Application',
      source_data: { secret_unlisted_column: 'must-not-leak' },
    } as never
    const description = buildScopedStoryDescription(task, {
      requirement_context: { detailed_description: 'controlled detail', ignored: 'must-not-leak' },
    })
    const prompt = buildAgentReviewPrompt({
      story: { code: 'PRJ-001', name: 'Demo story', description },
      branch: 'feature_dev',
      pins: [{ repository: 'kdmanage-backend', commitSha: 'a'.repeat(40) }],
      maxModelRequests: 20,
      scope: {
        task_id: '11111111-2222-4333-8444-555555555555', generation: 1,
        scope_mode: 'EXACT_STORY_COMMITS', status: 'READY', current_scope_level: 'PRIMARY',
        algorithm_version: 'story-attribution-v2', ruleset_hash: 'b'.repeat(64),
        candidate_manifest_hash: 'c'.repeat(64), scope_error_code: null,
        degradation_reasons: [], candidate_count: 0, strong_count: 0,
        ai_candidate_count: 0, triage_revision: 1, triage_required_count: 0,
        triage_completed_count: 0, triage_complete: true, candidates: [],
      },
    })
    expect(prompt).toContain('V1.11 范围规则')
    expect(prompt).toContain('scope=EXACT_STORY_COMMITS/PRIMARY')
    expect(prompt).toContain('controlled detail')
    expect(prompt).not.toContain('must-not-leak')
  })
})

describe('scope continuity identity', () => {
  it('changes the profile hash when the frozen scope changes and preserves legacy stability', () => {
    const template = resolveProfileTemplateDir()
    const legacy = computeConfigHash(template, [], {}, 'skill-hash')
    const first = computeConfigHash(template, [], {}, 'skill-hash', 'scope-a')
    const second = computeConfigHash(template, [], {}, 'skill-hash', 'scope-b')
    expect(first).not.toBe(second)
    expect(first).not.toBe(legacy)
    expect(computeConfigHash(template, [], {}, 'skill-hash')).toBe(legacy)
  })
})


describe('V1.11 two-phase Revert and generated-path pipeline attribution', () => {
  it('keeps only Reverts of already-associated commits strong and downranks mainly generated changes', () => {
    const currentSha = 'a'.repeat(40)
    const otherSha = 'b'.repeat(40)
    const relatedRevertSha = 'c'.repeat(40)
    const unrelatedRevertSha = 'd'.repeat(40)
    const generatedSha = 'e'.repeat(40)
    const sourceSha = 'f'.repeat(40)
    const repositoryHistory = history('kdmanage-backend', currentSha)
    const baseEntry = repositoryHistory.manifest.commits[0]!
    repositoryHistory.manifest.commits = [
      { ...baseEntry, sha: currentSha, subject: 'Implement story', message_body: 'Story-Id: PRJ-001', is_revert: false, reverted_sha: null, files: [{ path: 'src/order.ts' }] },
      { ...baseEntry, sha: otherSha, subject: 'Unrelated foundation', message_body: '', is_revert: false, reverted_sha: null, files: [{ path: 'src/other.ts' }] },
      { ...baseEntry, sha: relatedRevertSha, subject: 'Revert related', message_body: `This reverts commit ${currentSha}.`, is_revert: true, reverted_sha: currentSha, files: [{ path: 'src/order.ts' }] },
      { ...baseEntry, sha: unrelatedRevertSha, subject: 'Revert unrelated', message_body: `This reverts commit ${otherSha}.`, is_revert: true, reverted_sha: otherSha, files: [{ path: 'src/other.ts' }] },
      { ...baseEntry, sha: generatedSha, subject: 'Generated story output', message_body: 'Story-Id: PRJ-001', is_revert: false, reverted_sha: null, files: [{ path: 'dist/order.generated.js' }, { path: 'src/order.ts' }] },
      { ...baseEntry, sha: sourceSha, subject: 'Source story output', message_body: 'Story-Id: PRJ-001', is_revert: false, reverted_sha: null, files: [{ path: 'src/order.ts' }, { path: 'src/order.test.ts' }] },
    ]
    repositoryHistory.manifest.commit_count = repositoryHistory.manifest.commits.length

    const built = buildStoryScopes({
      stories: [{
        task_id: '13111111-2222-4333-8444-555555555555',
        story_id: '14111111-2222-4333-8444-555555555555',
        story_code: 'PRJ-001',
        story_name: 'Revert attribution',
        owners_text: '',
        normalized_developer_ids: [],
        project_name: null,
        application_name: null,
        release_window: null,
        requirement_context: {},
        input_hash: '1'.repeat(64),
      }],
      identities: [],
      histories: [repositoryHistory],
      rulesetHash: '2'.repeat(64),
    })

    const candidates = built.scopes[0]!.candidates
    expect(candidates.find((candidate) => candidate.sha === relatedRevertSha)).toMatchObject({
      tier: 'STRONG',
      reason_codes: expect.arrayContaining(['REVERT_OF_RELATED_COMMIT']),
    })
    expect(candidates.find((candidate) => candidate.sha === unrelatedRevertSha)?.tier).not.toBe('STRONG')
    expect(candidates.find((candidate) => candidate.sha === unrelatedRevertSha)?.reason_codes ?? []).not.toContain('REVERT_OF_RELATED_COMMIT')

    const generated = candidates.find((candidate) => candidate.sha === generatedSha)!
    const source = candidates.find((candidate) => candidate.sha === sourceSha)!
    expect(generated.reason_codes).toContain('BOT_OR_GENERATED')
    expect(generated.rank_score).toBeLessThan(source.rank_score)
  })
})


describe('previous successful Job baseline across per-head bare repositories', () => {
  it('fetches the previous head into a new bare cache, verifies ancestry, and records force-push fallback', async () => {
    const root = tempRoot()
    const remote = join(root, 'previous-remote.git')
    const work = join(root, 'previous-work')
    mkdirSync(work)
    await runCommand('git', ['init', '--bare', remote])
    await runCommand('git', ['init'], { cwd: work })
    await runCommand('git', ['config', 'user.name', 'History Test'], { cwd: work })
    await runCommand('git', ['config', 'user.email', 'history@example.invalid'], { cwd: work })
    await runCommand('git', ['checkout', '-b', 'feature_dev'], { cwd: work })
    const commit = async (content: string, date: string, message: string): Promise<string> => {
      writeFileSync(join(work, 'history.txt'), `${content}\n`)
      await runCommand('git', ['add', 'history.txt'], { cwd: work })
      await runCommand('git', ['commit', '-m', message], {
        cwd: work,
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      })
      return (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: work })).stdout.trim()
    }
    await commit('base', '2026-09-10T00:00:00Z', 'base')
    const firstHead = await commit('first job', '2026-09-18T00:00:00Z', 'first job')
    await runCommand('git', ['remote', 'add', 'origin', `file://${remote}`], { cwd: work })
    await runCommand('git', ['push', 'origin', 'feature_dev'], { cwd: work })

    const cacheRoot = join(root, 'cross-job-cache')
    const common = {
      cacheRoot,
      branch: 'feature_dev',
      windowDays: 1,
      prepareOptions: { cacheRoot, authMode: 'local' as const, timeoutMs: 30_000 },
      remoteUrl: `file://${remote}`,
      deepenStep: 1,
      deepenLimit: 20,
    }
    const first = await collectRepositoryHistory({
      ...common,
      prepared: { repository: 'kdmanage-backend', branch: 'feature_dev', commitSha: firstHead, commitSubject: 'first job', path: work, cached: false },
      headResolvedAt: '2026-09-18T12:00:00.000Z',
    })
    expect(first.manifest.range_source).toBe('TIME_DERIVED')

    const secondHead = await commit('second job', '2026-09-19T00:00:00Z', 'second job')
    await runCommand('git', ['push', 'origin', 'feature_dev'], { cwd: work })
    const second = await collectRepositoryHistory({
      ...common,
      prepared: { repository: 'kdmanage-backend', branch: 'feature_dev', commitSha: secondHead, commitSubject: 'second job', path: work, cached: false },
      headResolvedAt: '2026-09-19T12:00:00.000Z',
      previousBaseSha: firstHead,
    })
    expect(second.historyPath).not.toBe(first.historyPath)
    expect(second.manifest).toMatchObject({
      base_sha: firstHead,
      range_source: 'PREVIOUS_SUCCESSFUL_JOB',
      range_fallback_reason: null,
      ancestry_status: 'VERIFIED',
      enumeration_status: 'COMPLETE',
      commit_count: 1,
    })
    expect(second.manifest.commits[0]).toMatchObject({ sha: secondHead })

    await runCommand('git', ['checkout', '--orphan', 'unrelated'], { cwd: work })
    await runCommand('git', ['rm', '-rf', '.'], { cwd: work })
    const unrelatedHead = await commit('unrelated', '2026-09-17T00:00:00Z', 'unrelated previous job')
    await runCommand('git', ['push', 'origin', 'unrelated'], { cwd: work })
    const fallbackCache = join(root, 'force-push-cache')
    const fallback = await collectRepositoryHistory({
      ...common,
      cacheRoot: fallbackCache,
      prepareOptions: { ...common.prepareOptions, cacheRoot: fallbackCache },
      prepared: { repository: 'kdmanage-backend', branch: 'feature_dev', commitSha: secondHead, commitSubject: 'second job', path: work, cached: false },
      headResolvedAt: '2026-09-19T12:00:00.000Z',
      previousBaseSha: unrelatedHead,
      deepenLimit: 20,
    })
    expect(fallback.manifest).toMatchObject({
      range_source: 'TIME_DERIVED',
      range_fallback_reason: 'PREVIOUS_BASE_NOT_ANCESTOR',
      ancestry_status: 'VERIFIED',
      enumeration_status: 'COMPLETE',
    })
  })
})
