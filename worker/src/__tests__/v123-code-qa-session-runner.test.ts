/**
 * V1.23：问答 runner 的代码基线解析与错误分类。
 *
 * 这两块是 runner 里唯一不需要真实 dsh / Broker / profile 模板就能验证的部分，
 * 同时也是最容易悄悄出错的部分：
 *
 *   - 基线解析错了 → 多轮对话里"你刚才说的那个方法"指向另一个版本的代码，而模型不会
 *     告诉你它换了版本；
 *   - 错误分类错了 → 产品看到"回答失败，请重试"，而真正要做的是找管理员配模型，
 *     或者新建会话。重试一百次都不会好。
 */

import { describe, expect, it, vi } from 'vitest'

import {
  classifyCodeQaError,
  CODE_QA_ERROR_CODES,
  CODE_QA_MODEL_API_KEY_ENV,
  resolveCodeQaSnapshots,
  type CodeQaSessionDeps,
} from '../ai/code-qa/qa-session-runner.js'
import { SessionResumeUnsupportedError } from '../ai/acp/acp-client.js'
import { ModelNetworkRouteError } from '../model-connectivity/network-mode.js'
import type { CodeQaTurnClaim } from '../db/jobs.js'
import type { Logger } from '../logger.js'

/** 本地静音 logger：这些用例断言行为，不断言日志。 */
function silentLogger(): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  } as unknown as Logger
  return logger
}

const FROZEN_SHA = 'a'.repeat(40)
const HEAD_SHA = 'b'.repeat(40)
const OTHER_SHA = 'c'.repeat(40)

function claimOf(overrides: Partial<CodeQaTurnClaim> = {}): CodeQaTurnClaim {
  return {
    turn_id: 'turn-1',
    claim_token: 'token-1',
    conversation_id: 'conv-1',
    question: '转派后待办怎么处理？',
    repositories: ['kdmanage-backend'],
    branch: 'release',
    commit_shas: {},
    dsh_session_id: null,
    skill_catalog_hash: null,
    owner_id: 'owner-1',
    base_url_snapshot: 'https://example.invalid/v1',
    model_name_snapshot: 'test-model',
    request_timeout_ms_snapshot: 120000,
    network_access_mode_snapshot: 'DIRECT',
    max_output_tokens_snapshot: 8192,
    ...overrides,
  }
}

function preparedOf(commitSha: string) {
  return {
    repository: 'kdmanage-backend' as const,
    branch: 'release' as const,
    commitSha,
    commitSubject: 'subject',
    path: `/cache/kdmanage-backend/${commitSha}`,
    cached: false,
  }
}

function depsOf(overrides: Partial<CodeQaSessionDeps> = {}): CodeQaSessionDeps {
  return {
    // 只有 bindCodeQaConversationSnapshot 会被这两个用例走到。
    jobsDb: {
      bindCodeQaConversationSnapshot: vi.fn().mockResolvedValue(HEAD_SHA),
    } as unknown as CodeQaSessionDeps['jobsDb'],
    workerId: 'worker-1',
    paths: {
      codeCacheRoot: '/cache',
      agentAttemptsRoot: '/attempts',
      sessionRoot: '/sessions',
      socketRoot: '/sockets',
    },
    git: {
      authMode: 'local',
      gitlabBaseUrl: 'https://git.example.invalid',
      deployUser: null,
      deployToken: null,
    },
    modelProxy: null,
    logger: silentLogger(),
    ...overrides,
  }
}

const claimRef = { turnId: 'turn-1', workerId: 'worker-1', claimToken: 'token-1' }

describe('resolveCodeQaSnapshot', () => {
  it('首轮解析分支头，并把结果冻结到会话', async () => {
    const atBranchHead = vi.fn().mockResolvedValue(preparedOf(HEAD_SHA))
    const atSnapshot = vi.fn()
    const bind = vi.fn().mockResolvedValue(HEAD_SHA)
    const deps = depsOf({
      prepareAtBranchHead: atBranchHead,
      prepareAtSnapshot: atSnapshot,
      jobsDb: { bindCodeQaConversationSnapshot: bind } as unknown as CodeQaSessionDeps['jobsDb'],
    })

    const prepared = await resolveCodeQaSnapshots(claimOf(), claimRef, deps)

    expect(atBranchHead).toHaveBeenCalledOnce()
    expect(bind).toHaveBeenCalledWith({
      ...claimRef,
      repository: 'kdmanage-backend',
      commitSha: HEAD_SHA,
    })
    expect(prepared).toHaveLength(1)
    expect(prepared[0]!.commitSha).toBe(HEAD_SHA)
    // 冻结值与解析值一致时不必再取一次。
    expect(atSnapshot).not.toHaveBeenCalled()
  })

  it('后续轮直接用会话冻结的 SHA，绝不重新解析分支头', async () => {
    const atBranchHead = vi.fn()
    const atSnapshot = vi.fn().mockResolvedValue(preparedOf(FROZEN_SHA))
    const bind = vi.fn()
    const deps = depsOf({
      prepareAtBranchHead: atBranchHead,
      prepareAtSnapshot: atSnapshot,
      jobsDb: { bindCodeQaConversationSnapshot: bind } as unknown as CodeQaSessionDeps['jobsDb'],
    })

    const prepared = await resolveCodeQaSnapshots(
      claimOf({ commit_shas: { 'kdmanage-backend': FROZEN_SHA } }),
      claimRef,
      deps,
    )

    expect(prepared[0]!.commitSha).toBe(FROZEN_SHA)
    // 这一条是整个多轮一致性的关键：重新解析会让上一轮的文件引用悄悄失效。
    expect(atBranchHead).not.toHaveBeenCalled()
    expect(bind).not.toHaveBeenCalled()
    expect(atSnapshot).toHaveBeenCalledWith(
      'kdmanage-backend',
      'release',
      FROZEN_SHA,
      expect.objectContaining({ cacheRoot: '/cache' }),
    )
  })

  it('另一个 Worker 抢先冻结了别的 SHA 时服从数据库，重新取那一版', async () => {
    const atBranchHead = vi.fn().mockResolvedValue(preparedOf(HEAD_SHA))
    const atSnapshot = vi.fn().mockResolvedValue(preparedOf(OTHER_SHA))
    // 数据库返回的不是我们解析出来的那个 —— 会话早已基于 OTHER_SHA 回答过几轮了。
    const bind = vi.fn().mockResolvedValue(OTHER_SHA)
    const deps = depsOf({
      prepareAtBranchHead: atBranchHead,
      prepareAtSnapshot: atSnapshot,
      jobsDb: { bindCodeQaConversationSnapshot: bind } as unknown as CodeQaSessionDeps['jobsDb'],
    })

    const prepared = await resolveCodeQaSnapshots(claimOf(), claimRef, deps)

    expect(prepared[0]!.commitSha).toBe(OTHER_SHA)
    expect(atSnapshot).toHaveBeenCalledWith(
      'kdmanage-backend',
      'release',
      OTHER_SHA,
      expect.anything(),
    )
  })

  it('白名单外的仓库被拒（不信数据库侧的 CHECK，自己再断言一次）', async () => {
    const deps = depsOf({ prepareAtBranchHead: vi.fn(), prepareAtSnapshot: vi.fn() })
    await expect(
      resolveCodeQaSnapshots(claimOf({ repositories: ['not-a-repo'] }), claimRef, deps),
    ).rejects.toThrow(/repository not in whitelist/)
  })

  it('白名单外的分支被拒', async () => {
    const deps = depsOf({ prepareAtBranchHead: vi.fn(), prepareAtSnapshot: vi.fn() })
    await expect(
      resolveCodeQaSnapshots(claimOf({ branch: 'main' }), claimRef, deps),
    ).rejects.toThrow(/branch not allowed/)
  })
})

describe('classifyCodeQaError', () => {
  it('会话无法续跑有独立错误码（产品要做的是新建会话，不是重试）', () => {
    expect(classifyCodeQaError(new SessionResumeUnsupportedError('no resume'))).toBe(
      CODE_QA_ERROR_CODES.SESSION_RESUME_FAILED,
    )
  })

  it('网络路由错误原样透出它自己的码', () => {
    const error = new ModelNetworkRouteError(
      'MODEL_PROXY_NOT_CONFIGURED',
      'proxy missing',
    )
    expect(classifyCodeQaError(error)).toBe('MODEL_PROXY_NOT_CONFIGURED')
  })

  it('带 CODE_QA_ 前缀的 code 属性优先', () => {
    const error = Object.assign(new Error('空回答'), {
      code: CODE_QA_ERROR_CODES.ANSWER_EMPTY,
    })
    expect(classifyCodeQaError(error)).toBe(CODE_QA_ERROR_CODES.ANSWER_EMPTY)
  })

  it('Git 侧的失败归到 SNAPSHOT_FAILED（产品能自己改分支）', () => {
    expect(classifyCodeQaError(new Error('GIT_SHA_MISMATCH: no such commit'))).toBe(
      CODE_QA_ERROR_CODES.SNAPSHOT_FAILED,
    )
    expect(classifyCodeQaError(new Error('GIT_BRANCH_MISSING'))).toBe(
      CODE_QA_ERROR_CODES.SNAPSHOT_FAILED,
    )
  })

  it('租约丢失单独识别（不该回灌一次注定被拒的写入）', () => {
    expect(classifyCodeQaError(new Error('TASK_LEASE_LOST'))).toBe('TASK_LEASE_LOST')
  })

  it('模型配置类错误原样透出（要找管理员，不是重试）', () => {
    expect(classifyCodeQaError(new Error('MODEL_SECRET_MISSING'))).toBe('MODEL_SECRET_MISSING')
    expect(classifyCodeQaError(new Error('MODEL_CONFIG_NOT_FOUND'))).toBe('MODEL_CONFIG_NOT_FOUND')
  })

  it('只读工具面被破坏时有独立错误码', () => {
    expect(
      classifyCodeQaError(new Error('CODE_QA_TOOL_SURFACE_NOT_READ_ONLY: got write')),
    ).toBe('CODE_QA_TOOL_SURFACE_NOT_READ_ONLY')
  })

  it('认不出的错误落到通用码，但不吞掉（原因由调用方单独落库）', () => {
    expect(classifyCodeQaError(new Error('something odd'))).toBe(CODE_QA_ERROR_CODES.FAILED)
    expect(classifyCodeQaError('a string')).toBe(CODE_QA_ERROR_CODES.FAILED)
    expect(classifyCodeQaError(null)).toBe(CODE_QA_ERROR_CODES.FAILED)
  })
})

describe('CODE_QA_MODEL_API_KEY_ENV', () => {
  it('变量名必须命中 Harness 的敏感变量正则，否则 Key 会被带进 Shell', () => {
    // Harness 的 SENSITIVE_ENV_PATTERN 是 /KEY|PASSWORD|SECRET|TOKEN/i。
    expect(CODE_QA_MODEL_API_KEY_ENV).toMatch(/KEY|PASSWORD|SECRET|TOKEN/i)
  })
})
