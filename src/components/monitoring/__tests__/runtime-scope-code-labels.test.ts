/**
 * 范围卡片上的码必须有中文。
 *
 * 之前界面直接显示 `WEAK_CANDIDATES_CAPPED` 这样的原始码，使用者看不懂发生了什么
 * （2026-09-24 线上反馈）。这里把「Worker 会写出哪些码」与「界面翻了哪些码」对齐：
 * 断言读的是 Worker 源码，新增一个降级原因却忘了配文案时这条测试会失败。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  REASON_CODE_LABELS,
  SCOPE_ERROR_META,
  SCOPE_METRIC_HINTS,
} from '../runtime-scope-labels'

/** 只看会执行的代码：注释里提到的旧码（例如 V1.16 之前的 STORY_CANDIDATE_LIMIT_EXCEEDED）不算。 */
const workerScope = readFileSync(
  join(import.meta.dirname, '../../../../worker/src/pipeline/story-scope.ts'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

describe('分析范围卡片的码表', () => {
  it('Worker 写出的每个降级原因都有中文文案', () => {
    // globalScope(story, 'XXX') 与 degradations 数组里的字面量就是全部来源。
    const emitted = new Set<string>()
    for (const match of workerScope.matchAll(/globalScope\(story, '([A-Z_]+)'/g)) emitted.add(match[1]!)
    for (const match of workerScope.matchAll(/\['(STORY_CANDIDATE_LIMIT_TRUNCATED|WEAK_CANDIDATES_CAPPED|NO_STRONG_SCOPE)'\]/g)) {
      emitted.add(match[1]!)
    }
    expect(emitted.size).toBeGreaterThanOrEqual(3)
    for (const code of emitted) {
      expect(Object.keys(SCOPE_ERROR_META), `缺少 ${code} 的中文文案`).toContain(code)
    }
  })

  it('每条文案都写清了「发生了什么」而不是只重复码名', () => {
    for (const [code, meta] of Object.entries(SCOPE_ERROR_META)) {
      expect(meta.label, code).not.toMatch(/[A-Z]{3,}_/)
      expect(meta.label.length, code).toBeGreaterThan(3)
      expect(meta.hint.length, code).toBeGreaterThan(20)
    }
  })

  it('六个指标都有悬停解释', () => {
    expect(Object.keys(SCOPE_METRIC_HINTS).sort()).toEqual(
      ['aiRelated', 'aiUncertain', 'candidate', 'read', 'reverted', 'strong'],
    )
    for (const hint of Object.values(SCOPE_METRIC_HINTS)) expect(hint.length).toBeGreaterThan(10)
  })

  it('线上高频出现的候选理由码有中文', () => {
    for (const code of ['WEAK_ATTRIBUTION_SIGNAL', 'OWNER_WINDOW_MODULE', 'EXPLICIT_STORY_ID']) {
      expect(Object.keys(REASON_CODE_LABELS)).toContain(code)
    }
  })
})
