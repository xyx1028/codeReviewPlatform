import { Alert, Card, Empty, Tag, Typography } from 'antd'
import type { AiCodeEvidence, AiReviewResult, AiVerdict } from '../types'
import { aiVerdictLabels } from '../lib/labels'
import './AcceptanceReviewCard.css'

const { Text } = Typography
const tones: Record<AiVerdict, string> = { IMPLEMENTED: 'success', PARTIAL: 'warning', NOT_IMPLEMENTED: 'error', UNCERTAIN: 'default' }
const origins = { INTRODUCED: '本次引入', MISSING_SCENARIO: '遗漏场景', EXISTING: '已有隐患', UNKNOWN: '归因待确认' }

function EvidenceDetails({ ids, evidence }: { ids: string[]; evidence: AiCodeEvidence[] }) {
  if (!ids.length) return <Text type="secondary">暂无可引用代码证据</Text>
  return <ul className="acceptance-evidence-list">{ids.map((id) => {
    const item = evidence.find((entry) => entry.evidence_id === id)
    if (!item) return <li key={id}><Text type="warning">该证据未加载，需进一步确认</Text></li>
    return <li key={id}>
      <Text strong>{item.evidence_summary || item.description}</Text>
      <div className="acceptance-evidence-location">{item.repository_name} / {item.file_path}{item.start_line ? `：${item.start_line}${item.end_line && item.end_line !== item.start_line ? `–${item.end_line}` : ''} 行` : ''}</div>
      {item.commit_sha ? <div className="acceptance-evidence-commit">代码版本：{item.commit_sha}</div> : null}
      {item.evidence_summary ? <div>{item.description}</div> : null}
    </li>
  })}</ul>
}

export function AcceptanceReviewCard({ result, evidence }: { result: AiReviewResult | null; evidence: AiCodeEvidence[] }) {
  if (!result) return <Card className="review-ai-card" title="验收点评审"><Empty description="尚未生成评审结果" /></Card>
  const report = result.acceptance_review
  if (!report || report.version !== 1) return <Card className="review-ai-card" title="评审结果">
    <Alert type="info" showIcon title="历史报告尚无逐项验收结论" description="重新分析后，将展示固定验收点及独立复核结果。" />
    <p className="acceptance-summary">{result.summary || '暂无摘要'}</p>
    <details className="acceptance-details"><summary>查看历史报告与代码依据</summary>
      {[result.implemented_content, result.missing_content, result.risks, result.test_points, result.ai_remark].filter(Boolean).map((text, index) => <p className="acceptance-legacy-text" key={index}>{text}</p>)}
      <EvidenceDetails ids={evidence.map((entry) => entry.evidence_id || entry.id)} evidence={evidence.map((entry) => ({ ...entry, evidence_id: entry.evidence_id || entry.id }))} />
    </details>
  </Card>

  const unresolved = report.findings.filter((finding) => finding.verdict === 'UNCERTAIN').length
  return <Card className="review-ai-card" title="验收点评审" extra={<Tag color={report.verification.status === 'DISAGREEMENT' ? 'warning' : 'processing'}>{report.verification.status === 'DISAGREEMENT' ? '复核存在分歧' : '已独立复核'}</Tag>}>
    <p className="acceptance-summary">{result.summary}</p>
    {unresolved ? <Alert type="warning" showIcon title={`${unresolved} 个验收点需人工确认`} /> : null}
    <table className="acceptance-table">
      <thead><tr><th scope="col">验收点</th><th scope="col">评审结论</th><th scope="col">依据</th></tr></thead>
      <tbody>{report.criteria.map((point) => {
        const finding = report.findings.find((entry) => entry.criterionId === point.id)
        return <tr key={point.id}>
          <td data-label="验收点"><span className="acceptance-point-id">{point.id}</span>{point.description}{point.needsClarification ? <div><Tag>需求待澄清</Tag></div> : null}</td>
          <td data-label="评审结论"><Tag color={tones[finding?.verdict ?? 'UNCERTAIN']}>{aiVerdictLabels[finding?.verdict ?? 'UNCERTAIN']}</Tag></td>
          <td data-label="依据">
            <div>{finding?.reason || '该验收点缺少结论，需进一步确认。'}</div>
            {finding?.disagreement ? <div className="acceptance-disagreement">
              <p><strong>调查：</strong>{aiVerdictLabels[finding.disagreement.investigationVerdict]}。{finding.disagreement.investigationReason}</p>
              <p><strong>复核：</strong>{aiVerdictLabels[finding.disagreement.reviewVerdict]}。{finding.disagreement.reviewReason}</p>
            </div> : null}
            <details className="acceptance-details"><summary>查看需求出处与代码证据{finding?.evidenceIds.length ? `（${finding.evidenceIds.length}）` : ''}</summary>
              {point.sources.map((source, index) => <blockquote key={`${source.sourceId}-${index}`}><Text type="secondary">{report.sources.find((entry) => entry.id === source.sourceId)?.label || source.sourceId}</Text><div>{source.quote}</div></blockquote>)}
              <EvidenceDetails ids={finding?.evidenceIds ?? []} evidence={evidence} />
            </details>
          </td>
        </tr>
      })}</tbody>
    </table>
    <section className="acceptance-risks" aria-label="风险项">
      <h3>风险项 <Text type="secondary">{report.risks.length} 项</Text></h3>
      {report.risks.length ? report.risks.map((risk) => <article className="acceptance-risk" key={risk.id}>
        <div><Tag color={risk.certainty === 'CONFIRMED' ? 'error' : 'warning'}>{risk.certainty === 'CONFIRMED' ? '已确认' : '待确认'}</Tag><Tag>{origins[risk.origin]}</Tag><strong>{risk.title}</strong></div>
        <p><strong>触发条件：</strong>{risk.trigger}</p><p><strong>影响：</strong>{risk.impact}</p>
        {risk.criterionIds.length ? <p><Text type="secondary">关联验收点：{risk.criterionIds.join('、')}</Text></p> : null}
        {risk.reviewNote ? <p className="acceptance-disagreement">{risk.reviewNote}</p> : null}
        <details className="acceptance-details"><summary>查看风险依据</summary><EvidenceDetails ids={risk.evidenceIds} evidence={evidence} /></details>
      </article>) : <p><Text type="secondary">本次评审未发现明确风险项。</Text></p>}
    </section>
  </Card>
}
