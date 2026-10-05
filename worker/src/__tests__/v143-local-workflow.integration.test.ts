import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDeepSeekHarnessReview } from '../ai/runtime/factory.js'
import { JobsDb } from '../db/jobs.js'
import { REPOSITORY_NAMES } from '../git/repositories.js'
import { runCommand } from '../git/run.js'
import { Logger } from '../logger.js'
import { toAgentResultRow } from '../index.js'
import { aggregateCompletedResults } from '../pipeline/finalize-job.js'
import { startMockModelServer } from './helpers/acp-mock-model.js'
import { TransactionPsqlDbClient, quoteSql } from './helpers/local-supabase-transaction.js'

const ENABLED = process.env.RUN_V143_LOCAL_E2E === '1'
const JOB = '91430000-0000-4000-a000-000000000001'
const TASK = '91430000-0000-4000-b000-000000000001'
const WORKER = 'v143-local-e2e'
const q = quoteSql

describe.skipIf(!ENABLED)('V1.43 real local database + factory + DSH + finalizer', () => {
  it.each([
    { name: 'agreement', verdict: 'IMPLEMENTED' as const, rounds: 0, phases: 3, roots: 2 },
    { name: 'unresolved disagreement after one supplement', verdict: 'PARTIAL' as const, rounds: 1, phases: 5, roots: 3 },
  ])('$name: persists independent phases and publishes bound criteria/risks/evidence once, then rolls back', async ({ verdict, rounds, phases, roots }) => {
    const root = mkdtempSync(join(tmpdir(), 'v143-local-e2e-'))
    const repo = join(root, 'fixture')
    mkdirSync(join(repo, 'src'), { recursive: true })
    await runCommand('git', ['init', '--quiet', '--initial-branch=feature_dev'], { cwd: repo })
    await runCommand('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo })
    await runCommand('git', ['config', 'user.name', 'V143 Test'], { cwd: repo })
    writeFileSync(join(repo, 'src/Order.java'), 'public class Order {\n  public void createOrder() {}\n}\n')
    await runCommand('git', ['add', '--all'], { cwd: repo })
    await runCommand('git', ['commit', '--quiet', '-m', 'temporary workflow test fixture'], { cwd: repo })
    const sha = (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()
    const criteria = [{ id: 'C1', description: '下单接口', needsClarification: false, sources: [{ sourceId: 'title', quote: '下单接口验收测试' }] }]
    const read = { name: 'read_snapshot_code', args: { repository: 'kdmanage-backend', path: 'src/Order.java', startLine: 1, endLine: 3 } }
    const submit = (judgement: 'IMPLEMENTED' | 'PARTIAL') => (body: string) => {
      const id = [...body.matchAll(/ev_[0-9a-f-]{36}/g)].at(-1)?.[0]
      if (!id) throw new Error('phase lacks an independent code receipt')
      return { name: 'submit_review_result', args: {
        criterionReviews: [{ criterionId: 'C1', verdict: judgement, reason: judgement === 'IMPLEMENTED' ? '下单接口入口已存在' : '入口存在但业务实现需要补充', evidenceIds: [id] }],
        reviewRisks: [{ id: 'R1', criterionIds: ['C1'], title: '下单业务逻辑可能缺失', trigger: '调用下单接口', impact: '可能没有产生订单', certainty: 'SUSPECTED', origin: 'UNKNOWN', evidenceIds: [id] }],
        evidence: [{ evidenceId: id, repository: 'kdmanage-backend', filePath: 'src/Order.java', startLine: 1, endLine: 3, evidenceType: '现有实现', evidenceSummary: '订单服务下单入口实现证据', description: 'createOrder 下单入口' }],
      } }
    }
    const model = await startMockModelServer([
      { name: 'submit_review_result', args: { acceptancePoints: criteria, evidence: [] } }, read, submit('IMPLEMENTED'), read, submit(verdict),
      ...(rounds ? [read, submit('IMPLEMENTED'), read, submit(verdict)] : []),
    ])
    const db = new TransactionPsqlDbClient()
    const events: string[] = []
    const logger = new Logger({ sink: (line) => { events.push(line) }, minLevel: 'info' })
    try {
      await db.execute(`begin;
        do $fixture$ declare
          v_user uuid:=gen_random_uuid(); v_model uuid:=gen_random_uuid(); v_secret uuid;
          v_batch uuid:=gen_random_uuid(); v_story uuid:=gen_random_uuid(); v_policy jsonb;
        begin
          insert into auth.users(id,email) values(v_user,v_user::text||'@example.invalid');
          insert into public.user_profile(id,role) values(v_user,'ADMIN') on conflict(id) do update set role='ADMIN';
          perform set_config('request.jwt.claims',json_build_object('sub',v_user::text,'role','service_role')::text,true);
          select vault.create_secret('v143-local-fake-model-key',v_user::text) into v_secret;
          insert into public.ai_model_config(id,display_name,base_url,model_name,api_key_secret_id,created_by)
          values(v_model,'V143 local E2E',${q(model.baseUrl)},'poc-model',v_secret,v_user);
          v_policy:=public.build_v4_capability_policy(v_model);
          insert into public.review_batch(id,name,week_code,default_branch,created_by,ai_model_config_id)
          values(v_batch,'V143 local E2E','V143-E2E','feature_dev',v_user,v_model);
          insert into public.review_story(id,batch_id,story_code,story_name,owners_text,source_data)
          values(v_story,v_batch,'V143-E2E','下单接口验收测试','tester','{"详细描述":"实现下单接口"}');
          insert into public.analysis_job(id,batch_id,model_config_id,model_snapshot,requested_branch,status,requested_by,total_stories,
            capability_policy_snapshot,policy_hash,harness_version,capability_contract_hash)
          select ${q(JOB)}::uuid,v_batch,v_model,jsonb_build_object('model_config_id',v_model,'display_name','V143 frozen model',
            'base_url',${q(model.baseUrl)},'model_name','poc-model','network_access_mode','DIRECT','context_window',131072,'max_output_tokens',4096),
            'feature_dev','PROCESSING',v_user,1,v_policy,public.v4_policy_hash(v_policy),harness_version,manifest_hash
          from public.v4_harness_manifest where is_active;
          insert into public.analysis_story_task(id,job_id,story_id,retrieval_status)
          values(${q(TASK)}::uuid,${q(JOB)}::uuid,v_story,'SUCCEEDED');
          insert into public.analysis_repository_snapshot(job_id,repository_name,requested_branch,commit_sha)
          select ${q(JOB)}::uuid,name,'feature_dev',${q(sha)} from unnest(array[${REPOSITORY_NAMES.map(q).join(',')}]) names(name);
          insert into public.analysis_worker_heartbeat(worker_id,slots,current_tasks,capabilities)
          values(${q(WORKER)},1,0,'{"storyCommitScopeVersion":2,"acceptanceReviewWorkflowVersion":1}');
        end; $fixture$;
        select 'ready';`)
      const jobs = new JobsDb(db)
      const task = await jobs.claimNextStoryTask(WORKER, 900)
      expect(task?.id).toBe(TASK)
      expect(task?.job.review_workflow_version).toBe(1)
      const engine = await buildDeepSeekHarnessReview({ jobsDb: jobs, task: task!, workerId: WORKER, branch: 'feature_dev',
        repositories: REPOSITORY_NAMES.map((repository) => ({ repository, branch: 'feature_dev', commitSha: sha, commitSubject: '', path: repo, cached: true })),
        agentAttemptsRoot: join(root, 'attempts'), sessionRoot: join(root, 'sessions'), forbiddenRoots: [], infrastructure: {}, logger, isLeaseValid: () => true,
        commitReview: (input) => jobs.saveAgentReviewResult({ taskId: task!.id, workerId: WORKER, claimToken: task!.claim_token, agentAttempt: task!.agent_attempt,
          result: toAgentResultRow(input), configHash: input.configHash, promptVersion: 'v143-e2e', modelLabel: 'local fake model',
          evidence: input.evidence.map((item) => ({ evidence_id: item.evidenceId, repository_name: item.repository, commit_sha: item.commitSha, file_path: item.filePath, blob_sha: item.blobSha,
            start_line: item.startLine, end_line: item.endLine, content_hash: item.contentHash, evidence_type: item.evidenceType, description: item.description,
            producer_agent_id: item.producer.agentId, producer_session_id: item.producer.sessionId, tool_call_id: item.producer.toolCallId, evidence_origin: 'PINNED_SNAPSHOT' })),
          usage: { tool_calls: input.usage.toolCalls, evidence_shown: input.usage.evidenceShown, searches_run: input.usage.searchesRun, retry_requests: input.usage.retryRequests, compaction_requests: input.usage.compactionRequests,
            model_requests: input.usage.modelRequests, root_model_requests: input.usage.rootModelRequests, child_model_requests: input.usage.childModelRequests,
            root_agent_id: input.identity.rootAgentId, root_session_id: input.identity.rootSessionId, tree_digest: input.identity.treeDigest, session_revision: input.identity.sessionRevision, policy_hash: input.identity.policyHash },
        }).then((receipt) => ({ runId: receipt.run_id, committedAt: receipt.committed_at })),
      })
      const outcome = await engine.runReview({ signal: new AbortController().signal, logger })
      expect(outcome.ok, `${outcome.errorCode}: ${outcome.errorMessage}; ${events.filter((line) => line.includes('phase_') || line.includes('attempt_rollup')).slice(-8).join('\n')}`).toBe(true)
      const tasks = await jobs.listCompletedStoryTasks(JOB)
      expect(tasks).toHaveLength(1)
      const aggregated = aggregateCompletedResults(tasks)
      await db.execute(`update public.analysis_job set status='FINALIZING',finalizer_worker_id=${q(WORKER)},finalize_lease_expires_at=now()+interval '5 minutes' where id=${q(JOB)}::uuid; select 'finalizing';`)
      await jobs.completeAnalysisJob({ jobId: JOB, workerId: WORKER, ...aggregated })
      const persisted = JSON.parse(await db.execute(`select jsonb_build_object(
        'phase_count',(select count(*) from public.analysis_review_phase p join public.analysis_agent_run r on r.id=p.agent_run_id where r.task_id=${q(TASK)}::uuid and p.completed_at is not null),
        'root_count',(select count(*) from public.analysis_agent_node n join public.analysis_agent_run r on r.id=n.agent_run_id where r.task_id=${q(TASK)}::uuid and n.provider='root'),
        'report_count',(select count(*) from public.ai_review_result a join public.analysis_story_task t on t.story_id=a.story_id where t.id=${q(TASK)}::uuid),
        'report',(select acceptance_review from public.ai_review_result a join public.analysis_story_task t on t.story_id=a.story_id where t.id=${q(TASK)}::uuid),
        'evidence_ids',(select jsonb_agg(e.evidence_id order by e.evidence_id) from public.ai_code_evidence e join public.ai_review_result a on a.id=e.ai_review_result_id join public.analysis_story_task t on t.story_id=a.story_id where t.id=${q(TASK)}::uuid)
      )::text;`))
      expect(persisted.phase_count).toBe(phases)
      expect(persisted.root_count).toBe(roots)
      expect(persisted.report_count).toBe(1)
      expect(persisted.report.criteria).toEqual(criteria)
      expect([...persisted.report.findings[0].evidenceIds].sort()).toEqual(persisted.evidence_ids)
      expect(persisted.report.findings[0].verdict).toBe(rounds ? 'UNCERTAIN' : 'IMPLEMENTED')
      expect(persisted.report.supplementRounds).toBe(rounds)
      expect(persisted.report.verification.status).toBe(rounds ? 'DISAGREEMENT' : 'CONFIRMED')
      expect(persisted.report.risks[0].id).toBe('R1')
      expect(persisted.report.risks[0].evidenceIds).toHaveLength(1)
      if (rounds) {
        expect(persisted.report.findings[0].disagreement.investigationVerdict).toBe('IMPLEMENTED')
        expect(persisted.report.findings[0].disagreement.reviewVerdict).toBe('PARTIAL')
      }
      await db.execute("rollback; select 'rolled-back';")
      expect(await db.execute(`select count(*) from public.analysis_job where id=${q(JOB)}::uuid;`)).toBe('0')
    } finally {
      await db.close()
      await model.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, 180000)
})
