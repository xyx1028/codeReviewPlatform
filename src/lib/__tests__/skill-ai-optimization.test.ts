/**
 * V1.19 技能 AI 优化的前端纯逻辑契约。
 *
 * 只测三件能测准的事：diff 行模型、状态机文案映射、错误码说明。渲染层（antd Modal/Table）
 * 不在这里测 —— 对它做断言只能证明"它渲染了"，而真正会出错的是行号算错、折叠把改动块吃掉、
 * 以及一个未登记的错误码被编成一句友好但错误的建议。
 */

import { describe, expect, it } from 'vitest'

import {
  canOptimizeFromEvidence,
  collapseUnchanged,
  describeEvidenceUnavailable,
  describeOptimizationError,
  fileChangeKind,
  FILE_CHANGE_LABELS,
  groupEvidenceBatches,
  isOptimizationInFlight,
  optimizationStepIndex,
  renderFileDiff,
  summarizeEvidence,
} from '../skill-ai-optimization'
import type { SkillReviewEvidence } from '../../types'

describe('renderFileDiff', () => {
  it('把改一行算成一删一增，并给出正确的双侧行号', () => {
    const rendered = renderFileDiff({
      path: 'SKILL.md',
      before: 'line one\nline two\nline three\n',
      after: 'line one\nline TWO\nline three\n',
    })
    expect(rendered.stats).toEqual({ added: 1, removed: 1 })
    expect(rendered.lines.map((line) => [line.kind, line.beforeLineNumber, line.afterLineNumber])).toEqual([
      ['CONTEXT', 1, 1],
      ['REMOVED', 2, null],
      ['ADDED', null, 2],
      ['CONTEXT', 3, 3],
    ])
  })

  it('末尾换行不产生一条看不出内容的空行', () => {
    const rendered = renderFileDiff({ path: 'a.md', before: 'a\n', after: 'a\n' })
    expect(rendered.lines).toHaveLength(1)
    expect(rendered.lines[0]!.text).toBe('a')
    expect(rendered.stats).toEqual({ added: 0, removed: 0 })
  })

  it('CRLF 与 LF 的同一份内容不显示成全删全增，但会明确标出「只有行尾符变了」', () => {
    const rendered = renderFileDiff({ path: 'a.md', before: 'a\r\nb\r\n', after: 'a\nb\n' })
    expect(rendered.stats).toEqual({ added: 0, removed: 0 })
    // 归一化藏起了一个真实的字节改动，所以必须显式报出来，不能留一个空 diff。
    expect(rendered.lineEndingChanged).toBe(true)
  })

  it('内容真的没变时不会误报行尾符变化', () => {
    expect(renderFileDiff({ path: 'a.md', before: 'a\nb\n', after: 'a\nb\n' }).lineEndingChanged).toBe(
      false,
    )
  })

  it('新增文件（before 为 null）整份算新增', () => {
    const rendered = renderFileDiff({ path: 'a.md', before: null, after: 'x\ny\n' })
    expect(rendered.stats).toEqual({ added: 2, removed: 0 })
    expect(rendered.lines.every((line) => line.kind === 'ADDED')).toBe(true)
    expect(rendered.lines.every((line) => line.beforeLineNumber === null)).toBe(true)
  })

  it('删除文件（after 为 null）整份算删除', () => {
    const rendered = renderFileDiff({ path: 'a.md', before: 'x\ny\n', after: null })
    expect(rendered.stats).toEqual({ added: 0, removed: 2 })
    expect(rendered.lines.every((line) => line.kind === 'REMOVED')).toBe(true)
  })

  it('多处改动各自独立计数，行号连续不跳号', () => {
    const before = Array.from({ length: 10 }, (_unused, index) => `line ${index + 1}`).join('\n')
    const after = before.replace('line 2', 'line two').replace('line 9', 'line nine')
    const rendered = renderFileDiff({ path: 'SKILL.md', before, after })
    expect(rendered.stats).toEqual({ added: 2, removed: 2 })
    const beforeNumbers = rendered.lines
      .filter((line) => line.beforeLineNumber !== null)
      .map((line) => line.beforeLineNumber)
    expect(beforeNumbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })
})

describe('collapseUnchanged', () => {
  it('保留改动块前后各 3 行，中间用一条折叠标记代替', () => {
    const before = Array.from({ length: 30 }, (_unused, index) => `line ${index + 1}`).join('\n')
    const after = before.replace('line 15', 'line fifteen')
    const rendered = renderFileDiff({ path: 'SKILL.md', before, after })
    const rows = collapseUnchanged(rendered.lines, 3)

    // 改动行必须一条都不能少 —— 折叠只允许吃掉未改动行。
    const keptChanges = rows.filter((row) => row !== null && row.kind !== 'CONTEXT')
    expect(keptChanges).toHaveLength(2)
    // 折叠后总行数必须明显小于原始行数，否则这个函数没有意义。
    expect(rows.length).toBeLessThan(rendered.lines.length)
    // 首尾各有一段被折叠。
    expect(rows[0]).toBeNull()
    expect(rows[rows.length - 1]).toBeNull()
  })

  it('全文都在改动附近时不折叠任何东西', () => {
    const rendered = renderFileDiff({ path: 'a.md', before: 'a\nb\n', after: 'a\nB\n' })
    const rows = collapseUnchanged(rendered.lines, 3)
    expect(rows.includes(null)).toBe(false)
    expect(rows).toHaveLength(rendered.lines.length)
  })
})

describe('optimizationStepIndex / isOptimizationInFlight', () => {
  it('三段进度与状态一一对应，失败停在第二段', () => {
    expect(optimizationStepIndex('QUEUED')).toBe(0)
    expect(optimizationStepIndex('RUNNING')).toBe(1)
    expect(optimizationStepIndex('SUCCEEDED')).toBe(2)
    // 失败跳到第三段会让人以为还有一份草稿等着确认。
    expect(optimizationStepIndex('FAILED')).toBe(1)
    expect(optimizationStepIndex(null)).toBe(0)
  })

  it('只有 QUEUED / RUNNING 算在飞（轮询据此停下）', () => {
    expect(isOptimizationInFlight('QUEUED')).toBe(true)
    expect(isOptimizationInFlight('RUNNING')).toBe(true)
    expect(isOptimizationInFlight('SUCCEEDED')).toBe(false)
    expect(isOptimizationInFlight('FAILED')).toBe(false)
    expect(isOptimizationInFlight(null)).toBe(false)
  })
})

describe('describeOptimizationError', () => {
  it('已登记的码给出处置建议，而不是复述码本身', () => {
    const text = describeOptimizationError('MODEL_CONFIG_NOT_FOUND', null)
    expect(text).toContain('模型配置')
    expect(text).not.toContain('MODEL_CONFIG_NOT_FOUND')
  })

  it('模型 HTTP 状态码按模式识别', () => {
    expect(describeOptimizationError('MODEL_HTTP_429', null)).toContain('HTTP 429')
  })

  it('未登记的码原样透出并说明需要看日志，绝不编一句友好的错话', () => {
    const text = describeOptimizationError('SOMETHING_NEW', '原始信息')
    expect(text).toContain('SOMETHING_NEW')
    expect(text).toContain('原始信息')
    expect(text).toContain('日志')
  })

  it('没有错误码时退回原始信息', () => {
    expect(describeOptimizationError(null, '底层报错')).toBe('底层报错')
    expect(describeOptimizationError(null, null)).toContain('没有返回错误码')
  })

  /*
   * V1.22：服务端原文必须显示。
   *
   * 线上真实失败原因是 "the model changed nothing"，而旧文案写的是"路径不合规、放错目录、
   * frontmatter name 被改、超容量之类"—— 四条猜测一条都没命中。罐头文案回答"该我做什么"，
   * 原文回答"到底发生了什么"，缺一个就会把人引到错误的排查方向。
   */
  it('已登记的码也要带上服务端原文', () => {
    const text = describeOptimizationError(
      'SKILL_OPTIMIZATION_MODEL_OUTPUT_INVALID',
      'the model changed nothing',
    )
    expect(text).toContain('结构检查')
    expect(text).toContain('the model changed nothing')
  })

  it('「不需要改」不被描述成写错了', () => {
    const text = describeOptimizationError(
      'SKILL_OPTIMIZATION_NO_CHANGE_NEEDED',
      '缺少人工复核意见，暂不改。',
    )
    expect(text).toContain('不是失败')
    expect(text).toContain('缺少人工复核意见')
  })

  it('原文过长时截断，不把整份模型输出灌进弹窗', () => {
    const text = describeOptimizationError('SKILL_OPTIMIZATION_FAILED', 'x'.repeat(900))
    expect(text).toContain('…')
    expect(text.length).toBeLessThan(600)
  })

  it('每一个 Worker 侧会产出的码都有对应文案（漏一个就会显示成「未登记」）', () => {
    const workerCodes = [
      'SKILL_OPTIMIZATION_NO_EVIDENCE',
      'SKILL_OPTIMIZATION_MODEL_OUTPUT_INVALID',
      'SKILL_OPTIMIZATION_NO_CHANGE_NEEDED',
      'SKILL_OPTIMIZATION_SOURCE_UNREADABLE',
      'SKILL_OPTIMIZATION_REPACK_REJECTED',
      'SKILL_OPTIMIZATION_UPLOAD_INVALID',
      'SKILL_OPTIMIZATION_ACTOR_MISSING',
      'SKILL_OPTIMIZATION_FAILED',
      'MODEL_CONFIG_NOT_FOUND',
      'MODEL_SECRET_MISSING',
      'MODEL_TIMEOUT',
      'MODEL_PROXY_NOT_CONFIGURED',
      'MODEL_PROXY_UNREACHABLE',
      'MODEL_NETWORK_ERROR',
      'MODEL_RESPONSE_INVALID',
      'MODEL_RESPONSE_TOO_LARGE',
      'TASK_LEASE_LOST',
      'SKILL_NOT_PUBLISHED',
      'SKILL_NOT_FOUND',
    ]
    for (const code of workerCodes) {
      expect(describeOptimizationError(code, null)).not.toContain('未登记')
    }
  })
})

function evidence(overrides: Partial<SkillReviewEvidence> = {}): SkillReviewEvidence {
  return {
    skill_id: 'skill-1',
    referenced_job_count: 2,
    referenced_batches: [
      {
        batch_id: 'b1',
        batch_name: '第 39 周评审',
        week_code: '2026-W39',
        job_id: 'j1',
        job_status: 'SUCCEEDED',
        job_created_at: '2026-09-20T02:00:00.000Z',
        skill_version: 1,
        result_count: 12,
      },
      {
        batch_id: 'b1',
        batch_name: '第 39 周评审',
        week_code: '2026-W39',
        job_id: 'j2',
        job_status: 'FAILED',
        job_created_at: '2026-09-21T02:00:00.000Z',
        skill_version: 2,
        result_count: 12,
      },
      {
        batch_id: 'b2',
        batch_name: '第 38 周评审',
        week_code: '2026-W38',
        job_id: 'j3',
        job_status: 'SUCCEEDED',
        job_created_at: '2026-09-14T02:00:00.000Z',
        skill_version: 1,
        result_count: 5,
      },
    ],
    verdict_counts: { IMPLEMENTED: 3, PARTIAL: 1, NOT_IMPLEMENTED: 0, UNCERTAIN: 2 },
    human_review_counts: {
      CORRECT: 2,
      PARTIALLY_CORRECT: 1,
      INCORRECT: 1,
      NEED_DISCUSSION: 0,
    },
    sample_findings: [],
    ...overrides,
  }
}

/*
 * V1.22：可用性判据从"被引用过"改成"有评审结论"。
 *
 * 旧判据放行过一个真实案例：被 1 个分析任务引用、0 条结论。页面把按钮点亮，模型对着一份
 * 全 0 的统计只能回答"不该改"，然后被结构检查判成输出不合规并重试三次。
 */
describe('canOptimizeFromEvidence', () => {
  it('有引用也有结论时可以优化', () => {
    expect(canOptimizeFromEvidence(evidence())).toBe(true)
  })

  it('引用过但 0 条结论时不可优化', () => {
    expect(
      canOptimizeFromEvidence(
        evidence({
          review_result_count: 0,
          verdict_counts: { IMPLEMENTED: 0, PARTIAL: 0, NOT_IMPLEMENTED: 0, UNCERTAIN: 0 },
        }),
      ),
    ).toBe(false)
  })

  it('后端还没升到 V1.22 时按结论分布求和判定', () => {
    const legacy = evidence()
    delete legacy.review_result_count
    expect(canOptimizeFromEvidence(legacy)).toBe(true)
    const legacyEmpty = evidence({
      verdict_counts: { IMPLEMENTED: 0, PARTIAL: 0, NOT_IMPLEMENTED: 0, UNCERTAIN: 0 },
    })
    delete legacyEmpty.review_result_count
    expect(canOptimizeFromEvidence(legacyEmpty)).toBe(false)
  })

  it('两种不可用原因给的下一步不同', () => {
    expect(describeEvidenceUnavailable(evidence({ referenced_job_count: 0 })).title).toContain(
      '还没有历史评审证据',
    )
    const referencedButEmpty = describeEvidenceUnavailable(
      evidence({
        referenced_job_count: 3,
        review_result_count: 0,
        verdict_counts: { IMPLEMENTED: 0, PARTIAL: 0, NOT_IMPLEMENTED: 0, UNCERTAIN: 0 },
      }),
    )
    expect(referencedButEmpty.title).toContain('还没有评审结论')
    expect(referencedButEmpty.detail).toContain('3 个分析任务')
  })
})

describe('groupEvidenceBatches', () => {
  it('同一批次的多次重跑归并成一行，按最近一次时间倒序', () => {
    const groups = groupEvidenceBatches(evidence())
    expect(groups).toHaveLength(2)
    expect(groups[0]!.batch_name).toBe('第 39 周评审')
    expect(groups[0]!.job_count).toBe(2)
    expect(groups[0]!.latest_job_at).toBe('2026-09-21T02:00:00.000Z')
    // 同一批次用过技能的两个版本，都要列出来。
    expect(groups[0]!.skill_versions).toEqual([1, 2])
    expect(groups[1]!.batch_name).toBe('第 38 周评审')
  })

  it('没有批次投影（历史数据）时返回空数组而不是抛错', () => {
    expect(groupEvidenceBatches(evidence({ referenced_batches: undefined }))).toEqual([])
    expect(groupEvidenceBatches(null)).toEqual([])
  })
})

describe('fileChangeKind', () => {
  it('按两侧是否存在与是否二进制判定改动性质', () => {
    expect(fileChangeKind({ before: 'a', after: 'b' })).toBe('MODIFIED')
    expect(fileChangeKind({ before: null, after: 'b' })).toBe('ADDED')
    expect(fileChangeKind({ before: 'a', after: null })).toBe('DELETED')
    // 二进制优先：一张被删掉的图片没有逐行 diff，标成 DELETED 会让人以为能展开看。
    expect(fileChangeKind({ before: null, after: null, binary: true })).toBe('BINARY')
    expect(FILE_CHANGE_LABELS.BINARY).toContain('二进制')
  })
})

describe('canOptimizeFromEvidence / summarizeEvidence', () => {
  it('被引用过就可以优化；不要求一定有人工复核', () => {
    expect(canOptimizeFromEvidence(evidence())).toBe(true)
    expect(
      canOptimizeFromEvidence(
        evidence({
          human_review_counts: {
            CORRECT: 0,
            PARTIALLY_CORRECT: 0,
            INCORRECT: 0,
            NEED_DISCUSSION: 0,
          },
        }),
      ),
    ).toBe(true)
  })

  it('从未被引用过时不能优化，并给出明确说明', () => {
    const none = evidence({ referenced_job_count: 0 })
    expect(canOptimizeFromEvidence(none)).toBe(false)
    expect(summarizeEvidence(none)).toContain('还没有历史评审证据')
    expect(canOptimizeFromEvidence(null)).toBe(false)
  })

  it('摘要用服务端口径计数，不重新加总人工复核里的「对」，并带上批次数量', () => {
    const text = summarizeEvidence(evidence())
    expect(text).toContain('来自 2 个评审批次')
    expect(text).toContain('被 2 个分析任务引用过')
    expect(text).toContain('共 6 条评审结论')
    // 错 1 + 部分对 1 + 需讨论 0 = 2
    expect(text).toContain('其中 2 条')
  })
})
