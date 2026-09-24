import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildDeepSeekHarnessReview } from '../ai/runtime/factory.js'
import { toAgentResultRow } from '../index.js'
import { buildRuntimeEventReporter, type RuntimeEventReporterLike } from '../monitoring/runtime-event-reporter.js'
import { startMockModelServer } from './helpers/acp-mock-model.js'
import type { WorkerConfig } from '../config.js'
import type { DbClient, RpcOptions } from '../db/client.js'
import { JobsDb } from '../db/jobs.js'
import { collectRepositoryHistory } from '../git/story-history.js'
import { runCommand } from '../git/run.js'
import { Logger } from '../logger.js'
import { prepareJob } from '../pipeline/prepare-job.js'
import { DISABLED_LINKY_CONFIG } from './helpers/worker-config.js'

const runPreparationOnly = process.env.RUN_LOCAL_SUPABASE_INTEGRATION === '1'
const runFullE2e = process.env.RUN_V111_FULL_E2E === '1'
const localIt = runPreparationOnly ? it : it.skip
const fullIt = runFullE2e ? it : it.skip
const DB_CONTAINER = process.env.LOCAL_SUPABASE_DB_CONTAINER ?? 'supabase_db_codeReviewPlatform'
const JOB_ID = '91e20000-5000-4000-a000-000000000001'
const TASK_ID = '91e20000-6000-4000-a000-000000000001'
const WORKER_ID = 'v111-local-identity-e2e'
const RAW_EMAIL = 'v111.raw.owner@example.invalid'
const RAW_MODEL_TOKEN = 'v111-local-raw-model-token-not-a-real-secret'
const RAW_DIFF_MARKER = 'V111_RAW_DIFF_BODY_MUST_NOT_REACH_ORDINARY_TELEMETRY'
const TEST_PEPPER = 'v111-local-transaction-pepper-not-a-real-secret'
const REPOSITORIES = [
  'kdmanage-backend',
  'kdmanage-frontend',
  'tmanage-backend',
  'tmanage-frontend',
] as const
const silentLogger = new Logger({ sink: () => undefined, minLevel: 'error' })

function quoteSql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function sqlValue(value: unknown, parameterName?: string): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return quoteSql(value)
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    if (parameterName === 'p_reason_codes') {
      return `array[${value.map((item) => quoteSql(item)).join(',')}]::text[]`
    }
    if (parameterName === 'p_diff_access_ids') {
      return value.length === 0
        ? 'array[]::uuid[]'
        : `array[${value.map((item) => `${quoteSql(item)}::uuid`).join(',')}]::uuid[]`
    }
  }
  return `${quoteSql(JSON.stringify(value))}::jsonb`
}

class TransactionPsqlDbClient implements DbClient {
  private readonly child: ChildProcessWithoutNullStreams
  private active: {
    id: string
    started: boolean
    lines: string[]
    resolve: (value: string) => void
    reject: (error: Error) => void
  } | null = null
  private queue: Promise<void> = Promise.resolve()
  private stderr = ''
  private fatalError: Error | null = null
  private sequence = 0

  constructor() {
    this.child = spawn('docker', [
      'exec', '-i', DB_CONTAINER,
      'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres',
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    createInterface({ input: this.child.stdout }).on('line', (line) => this.acceptLine(line))
    this.child.stderr.on('data', (chunk: Buffer) => { this.stderr += chunk.toString('utf8') })
    this.child.once('exit', (code) => {
      this.fatalError = new Error(`local psql exited with ${code}: ${this.stderr.slice(-2000)}`)
      if (this.active) {
        const pending = this.active
        this.active = null
        pending.reject(this.fatalError)
      }
    })
  }

  private acceptLine(line: string): void {
    const active = this.active
    if (!active) return
    if (line === `__BEGIN_${active.id}__`) {
      active.started = true
      return
    }
    if (line === `__END_${active.id}__`) {
      this.active = null
      active.resolve(active.lines.join('\n'))
      return
    }
    if (active.started) active.lines.push(line)
  }

  private request(sql: string): Promise<string> {
    let result!: Promise<string>
    const scheduled = this.queue.then(() => {
      if (this.fatalError) throw this.fatalError
      result = new Promise<string>((resolve, reject) => {
        const id = `${process.pid}_${++this.sequence}`
        this.active = { id, started: false, lines: [], resolve, reject }
        this.child.stdin.write(
          `select ${quoteSql(`__BEGIN_${id}__`)};\n${sql}\nselect ${quoteSql(`__END_${id}__`)};\n`,
        )
      })
      return result.then(() => undefined)
    })
    this.queue = scheduled.catch(() => undefined)
    return scheduled.then(() => result)
  }

  async execute(sql: string): Promise<string> {
    return this.request(sql)
  }

  async rpc<T = unknown>(fn: string, params: Record<string, unknown>, _options?: RpcOptions): Promise<T> {
    if (!/^[a-z][a-z0-9_]*$/.test(fn)) throw new Error(`unsafe RPC name: ${fn}`)
    const args = Object.entries(params).map(([key, value]) => {
      if (!/^p_[a-z0-9_]+$/.test(key)) throw new Error(`unsafe RPC parameter: ${key}`)
      return `${key}=>${sqlValue(value, key)}`
    })
    const text = await this.request(
      `select coalesce(to_jsonb(public.${fn}(${args.join(',')}))::text,'null');`,
    )
    return JSON.parse(text || 'null') as T
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    this.child.stdin.end('\\q\n')
    await new Promise<void>((resolve) => this.child.once('exit', () => resolve()))
  }
}

function workerConfig(root: string): WorkerConfig {
  return {
    supabaseUrl: 'http://127.0.0.1:54321',
    supabaseServiceRoleKey: 'local-test-not-used-by-psql-adapter',
    gitAuthMode: 'local',
    gitlabBaseUrl: 'https://not-contacted.example.invalid',
    gitlabDeployUser: null,
    gitlabDeployToken: null,
    gitlabApiToken: null,
    workerId: WORKER_ID,
    workspaceRoot: join(root, 'jobs'),
    codeCacheRoot: join(root, 'cache'),
    pollIntervalMs: 1000,
    storyTaskLeaseSeconds: 900,
    heartbeatIntervalMs: 30_000,
    workerStoryConcurrency: 1,
    modelConnectivityTestLeaseSeconds: 90,
    gitEmailDiscoveryLeaseSeconds: 90,
    modelConnectivityProxy: null,
    linky: DISABLED_LINKY_CONFIG,
    agentAttemptsRoot: join(root, 'attempts'),
    skillCacheRoot: join(root, 'skills'),
    skillCacheMaxBytes: 256 * 1024 * 1024,
    modelImageInputEnabled: false,
    sessionRoot: join(root, 'sessions'),
    sessionRetentionDays: 7,
    sessionVolumeMaxBytes: 64 * 1024 * 1024,
    orphanWorkspaceMaxAgeMs: 60_000,
    runtimeEvents: { enabled: false, flushMs: 800, queueMax: 512, batchMax: 64, retentionDays: 30 },
  }
}

async function createBareFixture(root: string): Promise<{ remote: string; work: string; head: string }> {
  const remote = join(root, 'fixture.git')
  const work = join(root, 'work')
  mkdirSync(work)
  await runCommand('git', ['init', '--bare', remote])
  await runCommand('git', ['init'], { cwd: work })
  await runCommand('git', ['checkout', '-b', 'feature_dev'], { cwd: work })
  await runCommand('git', ['config', 'user.name', 'V1.11 Raw Owner'], { cwd: work })
  await runCommand('git', ['config', 'user.email', RAW_EMAIL], { cwd: work })
  const commit = async (content: string, date: string, args: string[]) => {
    writeFileSync(join(work, 'scope.txt'), content)
    await runCommand('git', ['add', 'scope.txt'], { cwd: work })
    await runCommand('git', ['commit', ...args], {
      cwd: work,
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    })
  }
  await commit('baseline', new Date(Date.now() - 30 * 86_400_000).toISOString(), ['-m', 'baseline'])
  await commit('implementation', new Date(Date.now() - 86_400_000).toISOString(), [
    '-m', 'Implement V111-E2E-001', '-m', 'Story-Id: V111-E2E-001',
  ])
  await runCommand('git', ['remote', 'add', 'origin', `file://${remote}`], { cwd: work })
  await runCommand('git', ['push', 'origin', 'feature_dev'], { cwd: work })
  const head = (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: work })).stdout.trim()
  return { remote, work, head }
}

function setupSql(modelBaseUrl = 'https://model-not-contacted.example.invalid'): string {
  return `
begin;
set local request.jwt.claim.sub = '91e20000-1000-4000-a000-000000000001';
set local request.jwt.claims = '{"sub":"91e20000-1000-4000-a000-000000000001","role":"authenticated"}';
do $fixture$
declare
  v_admin uuid:='91e20000-1000-4000-a000-000000000001';
  v_model uuid:='91e20000-2000-4000-a000-000000000001';
  v_batch uuid:='91e20000-3000-4000-a000-000000000001';
  v_story uuid:='91e20000-4000-4000-a000-000000000001';
  v_task uuid:='91e20000-6000-4000-a000-000000000001';
  v_developer uuid:='91e20000-7000-4000-a000-000000000001';
  v_git_identity uuid:='91e20000-7000-4000-a000-000000000002';
  v_model_secret uuid;
  v_pepper_secret uuid;
  v_rule_version uuid;
  v_rule_hash text;
  v_fingerprint text;
begin
  insert into auth.users(id,email) values(v_admin,'v111-local-admin@example.invalid');
  insert into public.user_profile(id,role,display_name) values(v_admin,'ADMIN','V1.11 local e2e admin')
  on conflict(id) do update set role='ADMIN',display_name=excluded.display_name;

  v_model_secret:=public.admin_vault_create_secret(
    ${quoteSql(RAW_MODEL_TOKEN)},'v111_local_identity_e2e_model_key');
  select vault.create_secret(${quoteSql(TEST_PEPPER)},'analysis_identity_pepper') into v_pepper_secret;
  v_fingerprint:=encode(extensions.hmac(
    convert_to(${quoteSql(RAW_EMAIL)},'UTF8'),convert_to(${quoteSql(TEST_PEPPER)},'UTF8'),'sha256'),'hex');

  insert into public.developer_identity(
    id,display_name,employee_code,status,created_by,updated_by
  ) values(v_developer,'V1.11 Raw Owner','V111-E2E','VERIFIED',v_admin,v_admin);
  insert into public.developer_git_identity(
    id,developer_identity_id,provider,email_fingerprint,masked_email,email_domain,
    author_name_aliases,verification_status,created_by,updated_by
  ) values(
    v_git_identity,v_developer,'gitlab',v_fingerprint,'v***@example.invalid','example.invalid',
    array['V1.11 Raw Owner'],'VERIFIED',v_admin,v_admin
  );

  insert into public.ai_model_config(
    id,display_name,base_url,model_name,api_key_secret_id,enabled,max_parallel_tasks,
    request_timeout_ms,context_window,max_output_tokens,agent_max_model_requests,
    agent_max_retry_requests,agent_max_compaction_requests,created_by
  ) values(
    v_model,'V1.11 local e2e model',${quoteSql(modelBaseUrl)},'poc-model',
    v_model_secret,true,1,30000,131072,8192,20,2,1,v_admin
  );
  insert into public.review_batch(id,name,week_code,default_branch,ai_model_config_id,created_by)
  values(v_batch,'V1.11 local identity e2e','V111-LOCAL-E2E','feature_dev',v_model,v_admin);
  insert into public.review_story(
    id,batch_id,story_code,story_name,owners_text,project_name,application_name,release_window,source_data
  ) values(
    v_story,v_batch,'V111-E2E-001','local identity matcher smoke','V1.11 Raw Owner（V111-E2E）',
    'scope','scope','2026-W38',jsonb_build_object('详细描述','transaction-only local smoke')
  );

  select version.id,version.ruleset_hash into v_rule_version,v_rule_hash
  from public.analysis_attribution_rule_set rule_set
  join public.analysis_attribution_rule_version version on version.id=rule_set.current_published_version_id
  where rule_set.rule_set_code='STORY_COMMIT_ATTRIBUTION';

  insert into public.analysis_job(
    id,batch_id,model_config_id,model_snapshot,requested_branch,status,requested_by,total_stories,
    execution_engine,policy_version,capability_policy_snapshot,policy_hash,harness_version,
    capability_contract_hash,analysis_context_version,commit_window_days,scope_status,
    required_worker_scope_version,attribution_algorithm_version,attribution_rule_version_id,
    ruleset_hash,skill_catalog_hash,skill_snapshot_version,created_at
  ) values(
    ${quoteSql(JOB_ID)}::uuid,v_batch,v_model,jsonb_build_object(
      'model_config_id',v_model,'display_name','local e2e frozen model',
      'base_url',${quoteSql(modelBaseUrl)},'model_name','poc-model',
      'network_access_mode','DIRECT','request_timeout_ms',60000,
      'context_window',131072,'max_output_tokens',8192,'max_parallel_tasks',1,
      'agent_max_model_requests',20,'agent_max_retry_requests',2,'agent_max_compaction_requests',1
    ),'feature_dev','QUEUED',v_admin,1,'deepseek-harness-acp',4,
    public.build_v4_capability_policy(v_model),null,null,null,
    2,21,'PREPARING',2,'story-attribution-v2',v_rule_version,v_rule_hash,
    public.empty_skill_catalog_hash(),1,now()
  );
  insert into public.analysis_story_task(id,job_id,story_id) values(v_task,${quoteSql(JOB_ID)}::uuid,v_story);
  insert into public.analysis_worker_heartbeat(worker_id,slots,current_tasks,capabilities)
  values(${quoteSql(WORKER_ID)},1,0,jsonb_build_object('storyCommitScopeVersion',2));
end;
$fixture$;
select jsonb_build_object('transaction','ready')::text;
`
}

describe('V1.11 local Supabase identity preparation smoke', () => {
  let root = ''
  let db: TransactionPsqlDbClient

  beforeAll(async () => {
    if (!runPreparationOnly) return
    root = mkdtempSync(join(tmpdir(), 'v111-local-supabase-'))
    db = new TransactionPsqlDbClient()
    await db.execute(setupSql())
  }, 60_000)

  afterAll(async () => {
    if (!runPreparationOnly) return
    try {
      await db.execute("rollback; select jsonb_build_object('rolled_back',true)::text;")
      const rollbackState = JSON.parse(await db.execute(`
        select jsonb_build_object(
          'job_rows',(select count(*) from public.analysis_job where id=${quoteSql(JOB_ID)}::uuid),
          'pepper_rows',(select count(*) from vault.decrypted_secrets where name='analysis_identity_pepper' and decrypted_secret=${quoteSql(TEST_PEPPER)})
        )::text;
      `))
      expect(rollbackState).toEqual({ job_rows: 0, pepper_rows: 0 })
    } finally {
      await db.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, 30_000)

  localIt('runs real JobsDb freeze -> manifest -> scope -> finalize to PROCESSING and rolls back', async () => {
    const fixture = await createBareFixture(root)
    const jobsDb = new JobsDb(db)
    const claim = await jobsDb.claimJobForPreparation(WORKER_ID)
    expect(claim?.job.id).toBe(JOB_ID)

    const repositoryPreparer = async (repository: string, branch: string) => ({
      repository,
      branch,
      commitSha: fixture.head,
      commitSubject: 'Implement V111-E2E-001',
      path: fixture.work,
      cached: true,
    })
    const historyCollector: typeof collectRepositoryHistory = (input) => collectRepositoryHistory({
      ...input,
      remoteUrl: `file://${fixture.remote}`,
      deepenStep: 8,
      deepenLimit: 64,
    })

    await prepareJob(
      jobsDb,
      workerConfig(root),
      claim!,
      silentLogger,
      repositoryPreparer as never,
      undefined,
      historyCollector,
    )

    const state = JSON.parse(await db.execute(`
      select jsonb_build_object(
        'status',job.status,
        'scope_status',job.scope_status,
        'snapshots',(select count(*) from public.analysis_repository_snapshot where job_id=job.id),
        'manifests',(select count(*) from public.analysis_repository_snapshot where job_id=job.id and commit_manifest_hash is not null),
        'scopes',(select count(*) from public.analysis_story_scope scope join public.analysis_story_task task on task.id=scope.task_id where task.job_id=job.id and scope.frozen_at is not null),
        'matched_commits',(select count(*) from public.analysis_repository_commit commit_row join public.analysis_repository_snapshot snapshot on snapshot.id=commit_row.snapshot_id where snapshot.job_id=job.id and commit_row.author_email_fingerprint is not null and commit_row.author_email_masked='v***@example.invalid'),
        'mr_unavailable',(select count(*) from public.analysis_repository_snapshot snapshot where snapshot.job_id=job.id and snapshot.mr_enrichment_status='UNAVAILABLE' and snapshot.mr_enrichment_error_code='MR_METADATA_UNAVAILABLE'),
        'mr_rows',(select count(*) from public.analysis_repository_merge_request mr join public.analysis_repository_snapshot snapshot on snapshot.id=mr.snapshot_id where snapshot.job_id=job.id),
        'raw_email_rows',(select count(*) from public.analysis_repository_commit commit_row join public.analysis_repository_snapshot snapshot on snapshot.id=commit_row.snapshot_id where snapshot.job_id=job.id and to_jsonb(commit_row)::text ilike '%${RAW_EMAIL}%'),
        'strong_candidates',(select count(*) from public.analysis_story_commit_candidate candidate join public.analysis_story_task task on task.id=candidate.task_id where task.job_id=job.id and candidate.tier='STRONG')
      )::text
      from public.analysis_job job where job.id=${quoteSql(JOB_ID)}::uuid;
    `))
    expect(state).toEqual({
      status: 'PROCESSING',
      scope_status: 'READY',
      snapshots: 4,
      manifests: 4,
      scopes: 1,
      matched_commits: 4,
      mr_unavailable: 4,
      mr_rows: 0,
      raw_email_rows: 0,
      strong_candidates: 4,
    })
  }, 120_000)
})

type FourRepoFixture = Record<(typeof REPOSITORIES)[number], { remote: string; work: string; head: string }>

async function createFourBareFixtures(root: string): Promise<FourRepoFixture> {
  const result = {} as FourRepoFixture
  const oldDate = new Date(Date.now() - 40 * 86_400_000).toISOString()
  const recentDate = new Date(Date.now() - 86_400_000).toISOString()

  for (const repository of REPOSITORIES) {
    const repositoryRoot = join(root, repository)
    const remote = join(repositoryRoot, 'remote.git')
    const work = join(repositoryRoot, 'work')
    mkdirSync(repositoryRoot, { recursive: true })
    mkdirSync(work, { recursive: true })
    await runCommand('git', ['init', '--bare', remote])
    await runCommand('git', ['init'], { cwd: work })
    await runCommand('git', ['checkout', '-b', 'feature_dev'], { cwd: work })
    const isOwnerRepository = repository === 'kdmanage-backend'
    await runCommand('git', ['config', 'user.name', isOwnerRepository ? 'V1.11 Raw Owner' : 'Fixture Contributor'], { cwd: work })
    await runCommand('git', ['config', 'user.email', isOwnerRepository ? RAW_EMAIL : `${repository}@example.invalid`], { cwd: work })
    mkdirSync(join(work, 'src'), { recursive: true })
    const path = repository === 'tmanage-backend' ? 'src/global.ts' : `src/${repository}.ts`
    writeFileSync(join(work, path), `export const baseline = '${repository}'\n`)
    if (repository === 'tmanage-backend') {
      mkdirSync(join(work, '%73rc'), { recursive: true })
      writeFileSync(join(work, '%73rc', 'global.ts'), "export const encodedLiteral = 'UNSELECTED_ENCODED_LITERAL'\n")
    }
    await runCommand('git', ['add', '--all'], { cwd: work })
    await runCommand('git', ['commit', '-m', `baseline ${repository}`], {
      cwd: work,
      env: { ...process.env, GIT_AUTHOR_DATE: oldDate, GIT_COMMITTER_DATE: oldDate },
    })

    if (repository === 'kdmanage-backend') {
      writeFileSync(join(work, path), `export const primary = '${RAW_DIFF_MARKER}'\n`)
      await runCommand('git', ['add', '--all'], { cwd: work })
      await runCommand('git', ['commit', '-m', 'Implement V111-E2E-001', '-m', 'Story-Id: V111-E2E-001'], {
        cwd: work,
        env: { ...process.env, GIT_AUTHOR_DATE: recentDate, GIT_COMMITTER_DATE: recentDate },
      })
    } else if (repository === 'kdmanage-frontend') {
      writeFileSync(join(work, path), `export const candidate = '${RAW_DIFF_MARKER}'\n`)
      await runCommand('git', ['add', '--all'], { cwd: work })
      await runCommand('git', ['commit', '-m', 'Potential V111-E2E-001 implementation candidate'], {
        cwd: work,
        env: { ...process.env, GIT_AUTHOR_DATE: recentDate, GIT_COMMITTER_DATE: recentDate },
      })
    }

    await runCommand('git', ['remote', 'add', 'origin', `file://${remote}`], { cwd: work })
    await runCommand('git', ['push', 'origin', 'feature_dev'], { cwd: work })
    const head = (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: work })).stdout.trim()
    result[repository] = { remote, work, head }
  }
  return result
}


describe('V1.11 full local transaction E2E', () => {
  let root = ''
  let db: TransactionPsqlDbClient
  let fixtures: FourRepoFixture
  let model: Awaited<ReturnType<typeof startMockModelServer>>
  let runtimeEvents: RuntimeEventReporterLike | null = null
  let aiCandidateId = ''
  const logLines: string[] = []

  beforeAll(async () => {
    if (!runFullE2e) return
    root = mkdtempSync(join(tmpdir(), 'v111-full-e2e-'))
    fixtures = await createFourBareFixtures(root)
    model = await startMockModelServer([
      {
        name: 'read',
        args: { file_path: 'repos/tmanage-backend/%73rc/global.ts' },
      },
      (conversation) => {
        if ((conversation.match(/SNAPSHOT_SCOPE_DENIED/g) ?? []).length < 1) {
          throw new Error('native encoded-literal read was not scope-denied before the next model turn')
        }
        return { name: 'grep', args: { pattern: 'baseline', path: 'repos/tmanage-backend' } }
      },
      (conversation) => {
        if ((conversation.match(/SNAPSHOT_SCOPE_DENIED/g) ?? []).length < 2) {
          throw new Error('native grep was not scope-denied before the next model turn')
        }
        return { name: 'glob', args: { pattern: '**/*.ts', path: 'repos/tmanage-backend' } }
      },
      (conversation) => {
        if ((conversation.match(/SNAPSHOT_SCOPE_DENIED/g) ?? []).length < 3) {
          throw new Error('native glob was not scope-denied before the next model turn')
        }
        return {
          name: 'bash',
          args: {
            command: 'cat repos/tmanage-backend/src/global.ts',
            description: 'Read repository outside primary scope',
          },
        }
      },
      (conversation) => {
        if ((conversation.match(/SNAPSHOT_SCOPE_DENIED/g) ?? []).length < 4) {
          throw new Error('native bash was not scope-denied before platform triage continued')
        }
        return { name: 'list_story_commits', args: { tier: 'AI_CANDIDATE', limit: 10 } }
      },
      () => {
        if (!aiCandidateId) throw new Error('real preparation did not produce an AI candidate id')
        return { name: 'read_story_commit_diff', args: { candidateId: aiCandidateId } }
      },
      (conversation) => {
        const accessId = conversation.match(/accessId[=:"\\\s]+([0-9a-f-]{36})/i)?.[1]
        if (!aiCandidateId || !accessId) throw new Error('script did not observe the real candidate/access ids')
        return {
          name: 'submit_commit_relevance_verdict',
          args: {
            candidateId: aiCandidateId,
            verdict: 'RELATED',
            reasonCodes: ['CODE_SEMANTIC_MATCH'],
            confidence: 0.95,
            diffAccessIds: [accessId],
            summary: 'The real candidate diff implements the story contract.',
          },
        }
      },
      {
        name: 'expand_analysis_scope',
        args: { targetLevel: 'GLOBAL', reasonCode: 'CROSS_REPOSITORY_CONTRACT' },
      },
      {
        name: 'read',
        args: { file_path: 'repos/tmanage-backend/src/global.ts' },
      },
      (conversation) => {
        if (!conversation.includes("export const baseline = 'tmanage-backend'")) {
          throw new Error('native read did not execute after GLOBAL scope expansion')
        }
        return {
          name: 'read_snapshot_code',
          args: { repository: 'tmanage-backend', path: 'src/global.ts', startLine: 1, endLine: 10 },
        }
      },
      (conversation) => {
        const evidenceId = conversation.match(/ev_[0-9a-f-]{36}/i)?.[0]
        if (!evidenceId) throw new Error('script did not observe a real evidenceId')
        return {
          name: 'submit_review_result',
          args: {
            verdict: 'IMPLEMENTED',
            confidence: 93,
            summary: 'V1.11 full E2E verified the implementation and cross-repository contract.',
            implementedContent: 'The pinned snapshots contain the required implementation.',
            evidence: [{
              evidenceId,
              repository: 'tmanage-backend',
              filePath: 'src/global.ts',
              startLine: 1,
              endLine: 1,
              evidenceType: '现有实现',
              description: 'Evidence read only after GLOBAL scope expansion.',
            }],
          },
        }
      },
    ])
    db = new TransactionPsqlDbClient()
    await db.execute(setupSql(model.baseUrl))
  }, 120_000)

  afterAll(async () => {
    if (!runFullE2e) return
    try {
      await runtimeEvents?.close()
      if (db) {
        await db.execute("rollback; select jsonb_build_object('rolled_back',true)::text;")
        const rollbackState = JSON.parse(await db.execute(`
        select jsonb_build_object(
          'job_rows',(select count(*) from public.analysis_job where id=${quoteSql(JOB_ID)}::uuid),
          'pepper_rows',(select count(*) from vault.decrypted_secrets where name='analysis_identity_pepper' and decrypted_secret=${quoteSql(TEST_PEPPER)}),
          'run_rows',(select count(*) from public.analysis_agent_run where task_id=${quoteSql(TASK_ID)}::uuid),
          'result_rows',(select count(*) from public.analysis_agent_evidence evidence join public.analysis_agent_run run on run.id=evidence.agent_run_id where run.task_id=${quoteSql(TASK_ID)}::uuid)
        )::text;
      `))
        expect(rollbackState).toEqual({ job_rows: 0, pepper_rows: 0, run_rows: 0, result_rows: 0 })
      }
    } finally {
      if (db) await db.close()
      if (model) await model.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, 60_000)

  fullIt('runs prepare -> claim -> real dsh/broker/engine -> committed result and rolls everything back', async () => {
    const jobsDb = new JobsDb(db)
    const claim = await jobsDb.claimJobForPreparation(WORKER_ID)
    expect(claim?.job.id).toBe(JOB_ID)

    const repositoryPreparer = async (repository: (typeof REPOSITORIES)[number], branch: string) => ({
      repository,
      branch,
      commitSha: fixtures[repository].head,
      commitSubject: repository === 'kdmanage-backend'
        ? 'Implement V111-E2E-001'
        : repository === 'kdmanage-frontend'
          ? 'Potential V111-E2E-001 implementation candidate'
          : `baseline ${repository}`,
      path: fixtures[repository].work,
      cached: true,
    })
    const historyCollector: typeof collectRepositoryHistory = (input) => collectRepositoryHistory({
      ...input,
      remoteUrl: `file://${fixtures[input.prepared.repository].remote}`,
      deepenStep: 8,
      deepenLimit: 64,
    })

    await prepareJob(
      jobsDb,
      workerConfig(root),
      claim!,
      new Logger({ sink: (line) => logLines.push(line), minLevel: 'debug' }),
      repositoryPreparer as never,
      undefined,
      historyCollector,
    )

    const preparedState = JSON.parse(await db.execute(`
      select jsonb_build_object(
        'status',job.status,
        'snapshots',(select count(*) from public.analysis_repository_snapshot where job_id=job.id),
        'strong',(select count(*) from public.analysis_story_commit_candidate candidate join public.analysis_story_task task on task.id=candidate.task_id where task.job_id=job.id and candidate.tier='STRONG'),
        'ai_candidates',(select count(*) from public.analysis_story_commit_candidate candidate join public.analysis_story_task task on task.id=candidate.task_id where task.job_id=job.id and candidate.tier='AI_CANDIDATE'),
        'ai_candidate_id',(select candidate.id from public.analysis_story_commit_candidate candidate join public.analysis_story_task task on task.id=candidate.task_id where task.job_id=job.id and candidate.tier='AI_CANDIDATE' limit 1)
      )::text from public.analysis_job job where job.id=${quoteSql(JOB_ID)}::uuid;
    `))
    expect(preparedState).toMatchObject({ status: 'PROCESSING', snapshots: 4, strong: 1, ai_candidates: 1 })
    expect(preparedState.ai_candidate_id).toMatch(/^[0-9a-f-]{36}$/)
    aiCandidateId = preparedState.ai_candidate_id

    const task = await jobsDb.claimNextStoryTask(WORKER_ID, 900)
    expect(task?.id).toBe(TASK_ID)
    expect(task?.snapshots).toHaveLength(4)
    const logger = new Logger({ sink: (line) => logLines.push(line), minLevel: 'debug' })
    const eventTarget = {
      workerId: WORKER_ID,
      jobId: JOB_ID,
      taskId: task!.id,
      claimToken: task!.claim_token,
      agentAttempt: task!.agent_attempt,
      sessionRevision: task!.session_revision,
    }
    const recordedRuntimeEvents: Array<Parameters<RuntimeEventReporterLike['report']>[0]> = []
    let recordedSessionRevision = task!.session_revision
    runtimeEvents = {
      enabled: true,
      report: (event) => { recordedRuntimeEvents.push(event) },
      flush: async () => undefined,
      close: async () => undefined,
      newCorrelationId: () => `v111-e2e-${recordedRuntimeEvents.length + 1}`,
      setSessionRevision: (revision) => { recordedSessionRevision = revision },
      snapshot: () => ({
        reported: recordedRuntimeEvents.length,
        duplicated: 0,
        dropped: 0,
        droppedUnresolvedAgent: 0,
        droppedInvalid: 0,
        collapsed: 0,
        flushFailures: 0,
        queueDepth: recordedRuntimeEvents.length,
        silenced: false,
        maxEventId: null,
      }),
    }

    const engine = await buildDeepSeekHarnessReview({
      jobsDb,
      task: task!,
      workerId: WORKER_ID,
      branch: 'feature_dev',
      repositories: REPOSITORIES.map((repository) => ({
        repository,
        branch: 'feature_dev',
        commitSha: fixtures[repository].head,
        commitSubject: '',
        path: fixtures[repository].work,
        cached: true,
      })),
      agentAttemptsRoot: join(root, 'attempts'),
      sessionRoot: join(root, 'sessions'),
      forbiddenRoots: [join(root, 'cache'), join(root, 'attempts'), join(root, 'sessions')],
      infrastructure: { supabaseUrl: 'http://127.0.0.1:54321' },
      logger,
      isLeaseValid: () => true,
      runtimeEvents,
      commitReview: (input) => jobsDb.saveAgentReviewResult({
        taskId: task!.id,
        workerId: WORKER_ID,
        claimToken: task!.claim_token,
        agentAttempt: task!.agent_attempt,
        result: toAgentResultRow(input),
        evidence: input.evidence.map((item) => ({
          evidence_id: item.evidenceId,
          repository_name: item.repository,
          commit_sha: item.commitSha,
          file_path: item.filePath,
          blob_sha: item.blobSha,
          start_line: item.startLine,
          end_line: item.endLine,
          content_hash: item.contentHash,
          evidence_type: item.evidenceType,
          description: item.description,
          producer_agent_id: item.producer.agentId,
          producer_session_id: item.producer.sessionId,
          tool_call_id: item.producer.toolCallId,
          evidence_origin: 'PINNED_SNAPSHOT',
        })),
        usage: {
          tool_calls: input.usage.toolCalls,
          evidence_shown: input.usage.evidenceShown,
          searches_run: input.usage.searchesRun,
          retry_requests: input.usage.retryRequests,
          compaction_requests: input.usage.compactionRequests,
          model_requests: input.usage.modelRequests,
          root_model_requests: input.usage.rootModelRequests,
          child_model_requests: input.usage.childModelRequests,
          web_requests: input.usage.webRequests,
          web_bytes: input.usage.webBytes,
          input_tokens: input.usage.inputTokens,
          output_tokens: input.usage.outputTokens,
          root_agent_id: input.identity.rootAgentId,
          root_session_id: input.identity.rootSessionId,
          tree_digest: input.identity.treeDigest,
          session_revision: input.identity.sessionRevision,
          policy_hash: input.identity.policyHash,
        },
        configHash: input.configHash ?? null,
        promptVersion: 'agent-review-v2',
        modelLabel: 'V1.11 local e2e model / poc-model',
        scopeGeneration: input.scopeIdentity?.generation ?? null,
        triageRevision: input.scopeIdentity?.triageRevision ?? null,
        candidateManifestHash: input.scopeIdentity?.candidateManifestHash ?? null,
        analysisScopeHash: input.scopeIdentity?.analysisScopeHash ?? null,
        attributionRulesetHash: input.scopeIdentity?.rulesetHash ?? null,
      }).then((receipt) => ({ runId: receipt.run_id, committedAt: receipt.committed_at })),
    })

    const outcome = await engine.runReview({ signal: new AbortController().signal, logger })
    const persistedRuntimeEvents = buildRuntimeEventReporter({
      settings: { enabled: true, flushMs: 0, queueMax: 2048, batchMax: 2048 },
      target: { ...eventTarget, sessionRevision: recordedSessionRevision },
      sink: jobsDb,
      logger,
    })
    for (const event of recordedRuntimeEvents) persistedRuntimeEvents.report(event)
    await persistedRuntimeEvents.close()
    runtimeEvents = null
    expect(outcome.ok, `${outcome.errorCode}: ${outcome.errorMessage}`).toBe(true)
    expect(model.servedToolNames()).toEqual([
      'read',
      'grep',
      'glob',
      'bash',
      'list_story_commits',
      'read_story_commit_diff',
      'submit_commit_relevance_verdict',
      'expand_analysis_scope',
      'read',
      'read_snapshot_code',
      'submit_review_result',
    ])

    const finalState = JSON.parse(await db.execute(`
      select jsonb_build_object(
        'task_status',task.agent_status,
        'task_verdict',task.agent_output->>'verdict',
        'run_status',run.status,
        'run_attempt',run.agent_attempt,
        'triage_completed',scope.triage_completed_count,
        'triage_required',scope.triage_required_count,
        'triage_complete',scope.triage_complete,
        'scope_level',scope.current_scope_level,
        'access_rows',(select count(*) from public.analysis_story_commit_access access where access.agent_run_id=run.id),
        'expansion_rows',(select count(*) from public.analysis_scope_expansion expansion where expansion.agent_run_id=run.id and expansion.from_level='PRIMARY' and expansion.to_level='GLOBAL'),
        'scope_denials',(select count(*) from public.analysis_permission_decision decision where decision.agent_run_id=run.id and decision.reason_code='SNAPSHOT_SCOPE_DENIED'),
        'scope_denial_audits',(select count(*) from public.analysis_tool_audit audit where audit.agent_run_id=run.id and audit.error_code='SNAPSHOT_SCOPE_DENIED' and audit.resource_relative_path is null),
        'evidence_rows',(select count(*) from public.analysis_agent_evidence evidence where evidence.agent_run_id=run.id and evidence.repository_name='tmanage-backend' and evidence.file_path='src/global.ts'),
        'event_rows',(select count(*) from public.analysis_runtime_event event where event.agent_run_id=run.id),
        'event_leaks',(select count(*) from public.analysis_runtime_event event where event.agent_run_id=run.id and (to_jsonb(event)::text like '%'||${quoteSql(RAW_EMAIL)}||'%' or to_jsonb(event)::text like '%'||${quoteSql(RAW_MODEL_TOKEN)}||'%' or to_jsonb(event)::text like '%'||${quoteSql(RAW_DIFF_MARKER)}||'%' or to_jsonb(event)::text like '%'||${quoteSql(task!.claim_token)}||'%'))
      )::text
      from public.analysis_story_task task
      join public.analysis_agent_run run on run.task_id=task.id and run.agent_attempt=task.agent_attempt
      join public.analysis_story_scope scope on scope.task_id=task.id and scope.generation=run.scope_generation
      where task.id=${quoteSql(TASK_ID)}::uuid;
    `))
    expect(finalState).toEqual({
      task_status: 'SUCCEEDED',
      task_verdict: 'IMPLEMENTED',
      run_status: 'COMMITTED',
      run_attempt: 1,
      triage_completed: 1,
      triage_required: 1,
      triage_complete: true,
      scope_level: 'GLOBAL',
      access_rows: 1,
      expansion_rows: 1,
      scope_denials: 4,
      scope_denial_audits: 4,
      evidence_rows: 1,
      event_rows: expect.any(Number),
      event_leaks: 0,
    })
    expect(finalState.event_rows).toBeGreaterThan(0)
    const ordinaryLogs = logLines.join('\n')
    for (const sensitive of [RAW_EMAIL, RAW_MODEL_TOKEN, RAW_DIFF_MARKER, task!.claim_token]) {
      expect(ordinaryLogs).not.toContain(sensitive)
    }
  }, 180_000)
})
