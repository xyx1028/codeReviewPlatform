import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpcMock = vi.hoisted(() => vi.fn())

vi.mock('../supabase', () => ({ requireSupabase: () => ({ rpc: rpcMock }) }))

import {
  adaptAttributionRuleCatalog,
  adaptRuntimeAnalysisScopeCommitPage,
  adaptRuntimeAnalysisScopeSummary,
  attributionRulesApi,
  adminListDeveloperGitIdentities,
  adminSaveDeveloperGitIdentity,
  enqueueAnalysisJob,
  getAnalysisStoryScopeCommits,
  getAnalysisStoryScopeSummary,
} from '../api'

describe('V1.11 归属规则可信 API 适配', () => {
  beforeEach(() => rpcMock.mockReset())

  it('读取完整 catalog，暴露版本/草稿与固定数据库安全契约', () => {
    const catalog = adaptAttributionRuleCatalog({
      rule_set_id: 'set-1',
      rule_set_name: '需求提交归属规则',
      current_published_version_id: 'version-1',
      mr_enhanced_available: false,
      sample_sets: [{
        id: 'SYSTEM_SAFETY_CONTRACT_V1',
        label: '系统安全契约 V1（非效果/召回率评估）',
        frozen_at: '2026-09-19T08:55:02Z',
        story_count: 0,
        commit_count: 0,
        evaluation_kind: 'SYSTEM_SAFETY_CONTRACT',
        description: '只检查数据库安全契约',
      }],
      versions: [{
        id: 'draft-1',
        version: 2,
        status: 'DRAFT',
        revision: 3,
        ruleset_hash: null,
        source_version_id: 'version-1',
        rules: [{
          id: 'rule-1',
          rule_code: 'ATTR_EXPLICIT_STORY',
          display_name: '需求号精确命中',
          description: '只读系统规则',
          priority: 900,
          enabled: true,
          capability: 'MR_ENHANCED',
          match: 'ALL',
          conditions: [{ id: 'condition-1', field: 'commit.structured_story_ids', operator: 'EXACT_CURRENT_STORY_TOKEN' }],
          action: { type: 'SELECT_STRONG', reason_code: 'EXPLICIT_STORY_ID' },
          system_locked: true,
        }],
        validation: null,
        latest_simulation: null,
        created_by_name: '管理员',
        created_at: '2026-09-19T08:56:00Z',
        published_by_name: null,
        published_at: null,
        publish_reason: null,
        referenced_job_count: 0,
      }],
    })

    expect(catalog.versions[0]).toMatchObject({ id: 'draft-1', status: 'DRAFT', revision: 3 })
    expect(catalog.versions[0]?.rules[0]).toMatchObject({
      rule_code: 'ATTR_EXPLICIT_STORY',
      capability: 'MR_ENHANCED',
      system_locked: true,
    })
    expect(catalog.sample_sets[0]).toMatchObject({
      id: 'SYSTEM_SAFETY_CONTRACT_V1',
      evaluation_kind: 'SYSTEM_SAFETY_CONTRACT',
      story_count: 0,
      commit_count: 0,
    })
    expect(attributionRulesApi.draftManagementAvailable).toBe(true)
    expect(attributionRulesApi.trustedSimulationAvailable).toBe(true)
  })

  it('真实 simulate RPC 只发送草稿、revision 和固定 sample id', async () => {
    rpcMock.mockResolvedValue({
      data: {
        passed: true,
        evaluation_kind: 'SYSTEM_SAFETY_CONTRACT',
        contract_version: 'SYSTEM_SAFETY_CONTRACT_V1',
        assessment_note: '仅检查数据库安全契约，不评估规则效果、准确率或召回率。',
        sample_set_id: 'SYSTEM_SAFETY_CONTRACT_V1',
        sample_set_label: '系统安全契约 V1（非效果/召回率评估）',
        simulated_revision: 3,
        simulated_ruleset_hash: 'abc',
        simulated_at: '2026-09-19T08:57:00Z',
        metrics: {
          effect_metrics_available: false,
          system_rule_expected_count: 13,
          system_rule_count: 13,
          custom_rule_count: 1,
          condition_count: 14,
          failed_check_count: 0,
        },
        contract_checks: {
          system_rule_expected_count: 13,
          system_rule_count: 13,
          custom_rule_count: 1,
          condition_count: 14,
          failed_check_count: 0,
        },
        blocking_reasons: [],
      },
      error: null,
    })

    const result = await attributionRulesApi.simulateDraft({
      draftVersionId: 'draft-1',
      expectedRevision: 3,
      sampleSetId: 'SYSTEM_SAFETY_CONTRACT_V1',
    })

    expect(rpcMock).toHaveBeenCalledWith('admin_simulate_attribution_rule_draft', {
      p_draft_version_id: 'draft-1',
      p_expected_revision: 3,
      p_sample_set_id: 'SYSTEM_SAFETY_CONTRACT_V1',
    })
    const sent = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>
    expect(sent).not.toHaveProperty('passed')
    expect(sent).not.toHaveProperty('metrics')
    expect(result).toMatchObject({
      passed: true,
      evaluation_kind: 'SYSTEM_SAFETY_CONTRACT',
      simulated_revision: 3,
      contract_checks: { failed_check_count: 0 },
      metrics: { effect_metrics_available: false },
    })
  })
  it('创建草稿后从 catalog 读取服务端版本，保存时不伪造条件 value', async () => {
    const draftCatalog = {
      rule_set_id: 'set-1',
      rule_set_name: '需求提交归属规则',
      current_published_version_id: 'version-1',
      mr_enhanced_available: false,
      sample_sets: [],
      versions: [{
        id: 'draft-1', version: 2, status: 'DRAFT', revision: 1,
        ruleset_hash: null, source_version_id: 'version-1',
        rules: [{
          id: 'rule-1', rule_code: 'ATTR_SYSTEM_RULE', display_name: '系统规则', description: '锁定',
          priority: 900, enabled: true, capability: 'GIT_BASE', match: 'ALL',
          conditions: [{ id: 'condition-1', field: 'commit.structured_story_ids', operator: 'EXACT_CURRENT_STORY_TOKEN' }],
          action: { type: 'SELECT_STRONG', reason_code: 'EXPLICIT_STORY_ID' }, system_locked: true,
        }],
        validation: null, latest_simulation: null, created_by_name: '管理员',
        created_at: '2026-09-19T08:56:00Z', published_by_name: null, published_at: null,
        publish_reason: null, referenced_job_count: 0,
      }],
    }
    rpcMock
      .mockResolvedValueOnce({ data: 'draft-1', error: null })
      .mockResolvedValueOnce({ data: draftCatalog, error: null })

    const draft = await attributionRulesApi.createDraft('version-1')
    expect(draft).toMatchObject({ id: 'draft-1', status: 'DRAFT', revision: 1 })
    expect(rpcMock.mock.calls.map((call) => call[0])).toEqual([
      'admin_create_attribution_rule_draft',
      'admin_get_attribution_rule_catalog',
    ])

    rpcMock.mockReset()
    rpcMock
      .mockResolvedValueOnce({ data: 2, error: null })
      .mockResolvedValueOnce({ data: {
        ...draftCatalog,
        versions: [{ ...draftCatalog.versions[0], revision: 2 }],
      }, error: null })
    const saved = await attributionRulesApi.saveDraft({
      draftVersionId: draft.id,
      expectedRevision: draft.revision,
      rules: draft.rules,
    })
    expect(saved.revision).toBe(2)
    const savePayload = rpcMock.mock.calls[0]?.[1] as { p_rules: Array<{ when: { all: Array<Record<string, unknown>> } }> }
    expect(savePayload.p_rules[0]?.when.all[0]).not.toHaveProperty('value')
  })
})

describe('V1.11 最终 scope API 适配', () => {
  beforeEach(() => rpcMock.mockReset())

  it('消费最终摘要字段及 repositories/expansions', async () => {
    rpcMock.mockResolvedValue({
      data: {
        task_id: 'task-1',
        generation: 2,
        mode: 'HYBRID_CANDIDATES',
        status: 'DEGRADED',
        error_code: 'RANGE_INCOMPLETE',
        window_days: 14,
        current_scope_level: 'RELATED',
        candidate_count: 5,
        strong_count: 2,
        ai_candidate_count: 3,
        ai_related_count: 1,
        ai_uncertain_count: 2,
        read_count: 2,
        reverted_count: 1,
        algorithm_version: 'story-attribution-v2',
        manifest_hash: 'hash-1',
        degradation_reasons: ['RANGE_INCOMPLETE'],
        frozen_at: '2026-09-19T00:00:00Z',
        repositories: [{
          repository_name: 'fin',
          base_sha: 'base-sha',
          head_sha: 'head-sha',
          range_source: 'MERGE_BASE',
          commit_count: 8,
          enumeration_status: 'COMPLETE',
          range_start_at: '2026-09-05T00:00:00Z',
          range_end_at: '2026-09-19T00:00:00Z',
          resolved_at: '2026-09-19T00:01:00Z',
        }],
        expansions: [{
          id: 'expansion-1',
          attempt: 3,
          agent_label: 'critic',
          from_level: 'PRIMARY',
          to_level: 'RELATED',
          reason_code: 'NEEDS_RELATED_CONTEXT',
          occurred_at: '2026-09-19T00:02:00Z',
        }],
      },
      error: null,
    })

    const summary = await getAnalysisStoryScopeSummary('task-1')

    expect(rpcMock).toHaveBeenCalledWith('get_analysis_story_scope_summary', { p_task_id: 'task-1' })
    expect(summary).toMatchObject({
      task_id: 'task-1',
      generation: 2,
      status: 'DEGRADED',
      mode: 'HYBRID_CANDIDATES',
      error_code: 'RANGE_INCOMPLETE',
      window_days: 14,
      repositories: [{ repository_name: 'fin', base_sha: 'base-sha', head_sha: 'head-sha', commit_count: 8 }],
      expansions: [{ id: 'expansion-1', attempt: 3, from_level: 'PRIMARY', to_level: 'RELATED' }],
    })
  })

  it('adapter 对缺失摘要返回 null', () => {
    expect(adaptRuntimeAnalysisScopeSummary(null)).toBeNull()
  })

  it('用 generation/view/cursor 五参数分页并直接消费服务端提交投影', async () => {
    rpcMock.mockResolvedValue({
      data: {
        task_id: 'task-1',
        generation: 4,
        total: 1,
        next_cursor: '30',
        items: [{
          candidate_id: 'candidate-1',
          generation: 4,
          view: 'CANDIDATE',
          relation_status: 'AI_UNRELATED',
          effective_status: 'REVERTED',
          repository_name: 'fin',
          short_sha: '333333333333',
          committed_at: '2026-09-18T00:00:00Z',
          author_display_name: '开发人员',
          author_email_masked: 'd***@example.com',
          subject: '修复范围判定',
          files_changed: 2,
          additions: 6,
          deletions: 3,
          reason_codes: ['AI_CLASSIFIED'],
          actually_read: true,
          read_count: 3,
        }],
      },
      error: null,
    })

    const page = await getAnalysisStoryScopeCommits({
      taskId: 'task-1',
      generation: 4,
      view: 'CANDIDATE',
      cursor: '20',
      limit: 10,
    })

    expect(rpcMock).toHaveBeenCalledWith('get_analysis_story_scope_commits', {
      p_task_id: 'task-1',
      p_generation: 4,
      p_view: 'CANDIDATE',
      p_cursor: '20',
      p_limit: 10,
    })
    expect(page).toMatchObject({
      task_id: 'task-1',
      generation: 4,
      next_cursor: '30',
      total: 1,
      items: [{
        view: 'CANDIDATE',
        relation_status: 'AI_UNRELATED',
        repository_name: 'fin',
        author_display_name: '开发人员',
        actually_read: true,
        read_count: 3,
      }],
    })
  })

  it('commit page adapter 不再按旧 tier/ai_verdict 做客户端过滤', () => {
    const page = adaptRuntimeAnalysisScopeCommitPage({
      task_id: 'task-1',
      generation: 5,
      total: 1,
      next_cursor: null,
      items: [{
        candidate_id: 'server-selected',
        generation: 5,
        view: 'SELECTED',
        relation_status: 'AI_UNCERTAIN',
        effective_status: 'EFFECTIVE',
        repository_name: 'kwork-server',
        author_display_name: '研发同学',
        actually_read: false,
        read_count: 0,
      }],
    })

    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      candidate_id: 'server-selected',
      generation: 5,
      view: 'SELECTED',
      relation_status: 'AI_UNCERTAIN',
      repository_name: 'kwork-server',
      author_display_name: '研发同学',
      actually_read: false,
      read_count: 0,
    })
  })
})


describe('V1.11 分析任务入队', () => {
  beforeEach(() => rpcMock.mockReset())

  it('精准模式调用V2 RPC并冻结选择的辅助窗口', async () => {
    rpcMock.mockResolvedValue({ data: 'job-v2', error: null })

    await expect(enqueueAnalysisJob('batch-1', {
      analysisContextVersion: 2,
      commitWindowDays: 28,
    })).resolves.toBe('job-v2')

    expect(rpcMock).toHaveBeenCalledWith('enqueue_analysis_job_with_context', {
      p_batch_id: 'batch-1',
      p_analysis_context_version: 2,
      p_commit_window_days: 28,
    })
  })

  it('未传新配置时保留旧V1 RPC兼容行为', async () => {
    rpcMock.mockResolvedValue({ data: 'job-v1', error: null })

    await expect(enqueueAnalysisJob('batch-1')).resolves.toBe('job-v1')
    expect(rpcMock).toHaveBeenCalledWith('enqueue_analysis_job', { p_batch_id: 'batch-1' })
  })
})


describe('V1.11 Git 身份管理 API', () => {
  beforeEach(() => rpcMock.mockReset())

  it('读取身份列表：明文与掩码同时可用', async () => {
    rpcMock.mockResolvedValue({ data: [{
      developer_id: 'developer-1', display_name: '开发人员', employee_code: 'E-1',
      status: 'VERIFIED', revision: 1, git_identity_id: 'git-1', provider: 'gitlab',
      author_email: 'developer@example.com',
      masked_email: 'd***@example.com', email_domain: 'example.com', author_name_aliases: [],
      gitlab_username: null, gitlab_user_id: null, verification_status: 'VERIFIED',
      git_revision: 1, updated_at: '2026-09-19T00:00:00Z',
    }], error: null })

    const rows = await adminListDeveloperGitIdentities()
    expect(rows[0]?.author_email).toBe('developer@example.com')
    expect(rows[0]?.masked_email).toBe('d***@example.com')
    expect(rpcMock).toHaveBeenCalledWith('admin_list_developer_git_identities')
  })

  it('历史行没有明文时 author_email 为 null，界面据此回落到掩码', async () => {
    rpcMock.mockResolvedValue({ data: [{
      developer_id: 'developer-2', display_name: '老记录', employee_code: null,
      status: 'VERIFIED', revision: 1, git_identity_id: 'git-2', provider: 'gitlab',
      author_email: null,
      masked_email: 'o***@example.com', email_domain: 'example.com', author_name_aliases: [],
      gitlab_username: null, gitlab_user_id: null, verification_status: 'VERIFIED',
      git_revision: 1, updated_at: '2026-09-19T00:00:00Z',
    }], error: null })

    const rows = await adminListDeveloperGitIdentities()
    expect(rows[0]?.author_email).toBeNull()
    expect(rows[0]?.masked_email).toBe('o***@example.com')
  })

  it('只把原始邮箱交给数据库HMAC包装RPC，不由浏览器计算或提交fingerprint', async () => {
    rpcMock.mockResolvedValue({ data: {
      developer_id: 'developer-1', git_identity_id: 'git-1', masked_email: 'd***@example.com',
      author_email: 'developer@example.com',
    }, error: null })

    await adminSaveDeveloperGitIdentity({
      displayName: '开发人员', employeeCode: 'E-1', email: 'Developer@Example.com',
      authorNameAliases: ['Dev'], developerStatus: 'VERIFIED', verificationStatus: 'VERIFIED',
    })

    expect(rpcMock).toHaveBeenCalledWith('admin_upsert_developer_git_identity_from_email', expect.objectContaining({
      p_email: 'Developer@Example.com',
      p_display_name: '开发人员',
      p_author_name_aliases: ['Dev'],
    }))
    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>
    expect(params).not.toHaveProperty('p_email_fingerprint')
    expect(params).not.toHaveProperty('p_masked_email')
  })
})
