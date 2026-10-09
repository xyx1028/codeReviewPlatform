/**
 * 证据类型契约：Worker 侧校验必须与数据库 CHECK 逐字一致。
 *
 * 真实故障（2026-09-23 本地全链路实测，Job `0d4a6a37`）：Worker 侧**完全不校验**
 * `evidenceType`，模型编了一个不在词表里的类型，deterministic verifier 放过，直到
 * `save_agent_review_result` 才被数据库拒绝：
 *
 *   rpc save_agent_review_result failed: new row for relation "analysis_agent_evidence"
 *   violates check constraint "analysis_agent_evidence_evidence_type_check"
 *
 * 模型收到的既没有稳定错误码也没说清该填什么，只能靠猜重试（实测 4~5 次/Job）。
 * 严重时所有重试都用同一个错类型 → attempt 失败 → fail-fast 把整个 Job 判失败。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_EVIDENCE_TYPES,
  EXISTING_IMPLEMENTATION_EVIDENCE,
} from '../ai/snapshot/deterministic-verifier.js'
import { AGENT_REVIEW_SYSTEM_PROMPT } from '../ai/prompts/agent-review.js'

const root = join(import.meta.dirname, '../../..')

/** 从迁移文本里取出 evidence_type 的 CHECK 允许值（最后一次定义为准）。 */
function sqlAllowedEvidenceTypes(): string[] {
  const files = readdirSync(join(root, 'supabase/migrations')).filter((n) => n.endsWith('.sql')).sort()
  let found: string[] | null = null
  for (const file of files) {
    const text = readFileSync(join(root, 'supabase/migrations', file), 'utf8')
    // 形如：evidence_type text not null check (evidence_type in ('现有实现', '缺失依据', '风险依据'))
    for (const match of text.matchAll(/evidence_type[^\n]*?in \(([^)]*)\)/g)) {
      const values = [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
      if (values.length > 0) found = values
    }
  }
  if (found === null) throw new Error('未在迁移里找到 evidence_type 的 CHECK 取值')
  return found
}

describe('证据类型契约', () => {
  it('Worker 侧词表与数据库 CHECK 逐字一致', () => {
    expect([...ALLOWED_EVIDENCE_TYPES]).toEqual(sqlAllowedEvidenceTypes())
  })

  it('"现有实现"必须在词表里（IMPLEMENTED/PARTIAL 的硬要求依赖它）', () => {
    expect(ALLOWED_EVIDENCE_TYPES).toContain(EXISTING_IMPLEMENTATION_EVIDENCE)
  })

  it('提示词把三个合法取值写给模型（这是真正的预防）', () => {
    for (const type of ALLOWED_EVIDENCE_TYPES) {
      expect(AGENT_REVIEW_SYSTEM_PROMPT).toContain(type)
    }
    expect(AGENT_REVIEW_SYSTEM_PROMPT).toContain('evidenceType 只能是这三个值之一')
  })
})
