import { describe, expect, it } from 'vitest'
import type { CommitReviewInput } from '../ai/control/attempt-control-broker.js'
import type { WorkerConfig } from '../config.js'
import type { CompletedStoryTask, JobsDb, StoryTask } from '../db/jobs.js'
import { recordSetupFailure, toAgentResultRow } from '../index.js'
import { aggregateCompletedResults } from '../pipeline/finalize-job.js'
import { DISABLED_LINKY_CONFIG } from './helpers/worker-config.js'

const TASK_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const CLAIM_TOKEN = '99999999-8888-4777-8666-555555555555'
const SHA = 'a'.repeat(40)

function fakeJobsDb() {
  const calls: Array<Record<string, unknown>> = []
  const db = {
    failAgentReview: async (input: Record<string, unknown>) => {
      calls.push(input)
    },
  } as unknown as JobsDb
  return { db, calls }
}

function config(): WorkerConfig {
  return {
    supabaseUrl: 'https://p.supabase.co',
    supabaseServiceRoleKey: 'k',
    gitAuthMode: 'local',
    gitlabBaseUrl: 'https://git.example.com',
    gitlabDeployUser: null,
    gitlabDeployToken: null,
    gitlabApiToken: null,
    workerId: 'w1',
    workspaceRoot: '/tmp/jobs',
    codeCacheRoot: '/tmp/cache',
    pollIntervalMs: 5000,
    storyTaskLeaseSeconds: 900,
    heartbeatIntervalMs: 30000,
    workerStoryConcurrency: 2,
    modelConnectivityTestLeaseSeconds: 90,
    gitEmailDiscoveryLeaseSeconds: 90,
    modelConnectivityProxy: null,
    linky: DISABLED_LINKY_CONFIG,
    agentAttemptsRoot: '/tmp/attempts',
    skillCacheRoot: '/tmp/skill-cache',
    skillCacheMaxBytes: 4 * 1024 * 1024 * 1024,
    modelImageInputEnabled: false,
    sessionRoot: '/tmp/sessions',
  sessionRetentionDays: 7,
    sessionVolumeMaxBytes: 20 * 1024 * 1024 * 1024,
    orphanWorkspaceMaxAgeMs: 6 * 60 * 60 * 1000,
    // V1.23：问答轮询开关。测试里关掉 —— 这些用例验证的是评审链路。
    codeQa: { enabled: false, leaseSeconds: 600, turnTimeoutMs: 900000 },
    runtimeEvents: {
      enabled: false,
      flushMs: 800,
      queueMax: 512,
      batchMax: 64,
      retentionDays: 30,
    },
  }
}

function task(): StoryTask {
  return {
    id: TASK_ID,
    job_id: 'job-1',
    worker_id: 'w1',
    lease_expires_at: '2026-01-01T00:15:00.000Z',
    agent_status: 'RUNNING',
    agent_attempt: 2,
    claim_token: CLAIM_TOKEN,
    // V4：能力策略 snapshot 与身份/fencing 字段随 task 一起下发；空 policy 表示"用默认全能力"。
    capability_policy: {},
    policy_version: 4,
    policy_hash: null,
    agent_run_id: null,
    session_revision: 1,
    job: {
      id: 'job-1',
      batch_id: 'b',
      model_config_id: 'm',
      requested_branch: 'feature_dev',
      total_stories: 1,
    },
    model: {
      model_config_id: 'm',
      display_name: 'DeepSeek',
      base_url: 'https://model.invalid/v1',
      model_name: 'deepseek-chat',
    },
    snapshots: [
      {
        repository_name: 'kdmanage-backend',
        requested_branch: 'feature_dev',
        commit_sha: SHA,
        commit_subject: null,
      },
    ],
    story: {
      story_id: 's',
      story_code: 'PRJ-001',
      story_name: 'demo',
      description: null,
      acceptance_criteria: null,
      project_name: null,
      application_name: null,
      source_data: {},
    },
    story_id: 's',
    story_code: 'PRJ-001',
    story_name: 'demo',
    description: null,
    acceptance_criteria: null,
    project_name: null,
    application_name: null,
    source_data: {},
  }
}

function submission(): CommitReviewInput {
  return {
    submission: {
      verdict: 'PARTIAL',
      confidence: 61,
      summary: '部分实现',
      implementedItems: ['已实现下单'],
      missingItems: ['缺少退款'],
      riskItems: ['并发风险'],
      testPointItems: ['并发下单'],
      remarkItems: ['备注'],
      evidence: [],
    },
    evidence: [],
    usage: {
      modelRequests: 0,
      // V4：BrokerUsageSnapshot 分层记账，root/child/token 各自可辨；这里给出零态的完整形状。
      rootModelRequests: 0,
      childModelRequests: 0,
      retryRequests: 0,
      compactionRequests: 0,
      ralphRounds: 0,
      inputTokens: null,
      outputTokens: null,
      toolCalls: 5,
      evidenceShown: 1,
      searchesRun: 2,
      webRequests: 0,
      webBytes: 0,
      toolCallsByName: {
        search_snapshot_code: 2,
        read_snapshot_code: 2,
        submit_review_result: 1,
      },
      deniedModelRequests: 0,
      rejectedSubmissions: [],
      rejectedSubmissionTotal: 0,
      perAgent: [],
    },
    configHash: 'cfg',
    // V4：提交携带由 Worker 观测（非模型自报）的身份与 fencing，用于 root-only 与 fencing 校验。
    identity: {
      rootAgentId: 'root-abc',
      rootSessionId: 'session-abc',
      treeDigest: 'digest-abc',
      sessionRevision: 1,
      policyHash: 'policy-abc',
    },
    scopeIdentity: null,
  }
}

describe('recordSetupFailure', () => {
  it('always records setup failures through failAgentReview with the active claim', async () => {
    const { db, calls } = fakeJobsDb()

    await recordSetupFailure(
      db,
      config(),
      task(),
      'SNAPSHOT_COMMIT_MISSING',
      'commit not present',
    )

    expect(calls).toEqual([
      {
        taskId: TASK_ID,
        workerId: 'w1',
        claimToken: CLAIM_TOKEN,
        code: 'SNAPSHOT_COMMIT_MISSING',
        message: 'commit not present',
      },
    ])
  })
})

describe('Agent result mapping', () => {
  it('maps a verified submission to the camelCase agent_output vocabulary', () => {
    expect(toAgentResultRow(submission())).toEqual({
      verdict: 'PARTIAL',
      confidence: 61,
      summary: '部分实现',
      implementedContent: '已实现下单',
      missingContent: '缺少退款',
      risks: '并发风险',
      testPoints: '并发下单',
      aiRemark: '备注',
      analysisDetailItems: {
        implemented_content: ['已实现下单'],
        missing_content: ['缺少退款'],
        risks: ['并发风险'],
        test_points: ['并发下单'],
        ai_remark: ['备注'],
      },
      evidenceSummaries: {},
    })
  })

  it('maps the committed Agent output to final result columns without losing fields', () => {
    const completed: CompletedStoryTask = {
      id: TASK_ID,
      job_id: 'job-1',
      story_id: 's',
      story_code: 'PRJ-001',
      agent_status: 'SUCCEEDED',
      output: toAgentResultRow(submission()),
      verified_evidence: [],
    }

    expect(aggregateCompletedResults([completed]).results).toEqual([
      {
        story_code: 'PRJ-001',
        verdict: 'PARTIAL',
        confidence: 61,
        summary: '部分实现',
        implemented_content: '已实现下单',
        missing_content: '缺少退款',
        risks: '并发风险',
        test_points: '并发下单',
        ai_remark: '备注',
        analysis_detail_items: {
          implemented_content: ['已实现下单'],
          missing_content: ['缺少退款'],
          risks: ['并发风险'],
          test_points: ['并发下单'],
          ai_remark: ['备注'],
        },
      },
    ])
  })
})
