import { useState } from 'react'
import { Alert, Card, Empty, Modal, Pagination, Tabs, Tag, Tooltip, Typography } from 'antd'
import type { AiCodeEvidence, AiReviewResult, AiVerdict } from '../types'
import { aiVerdictLabels } from '../lib/labels'
import './AcceptanceReviewCard.css'

const { Text } = Typography
const evidencePageSize = 2
const listPageSizeOptions = [10, 20, 50, 100]
const tones: Record<AiVerdict, string> = { IMPLEMENTED: 'success', PARTIAL: 'warning', NOT_IMPLEMENTED: 'error', UNCERTAIN: 'default' }
const origins = { INTRODUCED: '本次引入', MISSING_SCENARIO: '遗漏场景', EXISTING: '已有隐患', UNKNOWN: '归因待确认' }

type SelectedCriterion = { reportIdentity: string; criterionId: string }
type ListPagination = { reportIdentity: string; currentPage: number; pageSize: number }

function EvidenceDetails({ ids, evidence }: { ids: string[]; evidence: AiCodeEvidence[] }) {
  const evidenceIdentity = ids.join('|')
  const [pagination, setPagination] = useState({ evidenceIdentity, currentPage: 1 })
  const evidenceEntries = ids.map((id) => ({ id, item: evidence.find((entry) => entry.evidence_id === id) }))
  const totalPages = Math.max(1, Math.ceil(evidenceEntries.length / evidencePageSize))
  const page = Math.min(pagination.evidenceIdentity === evidenceIdentity ? pagination.currentPage : 1, totalPages)
  const start = (page - 1) * evidencePageSize
  const visibleEntries = evidenceEntries.slice(start, start + evidencePageSize)

  if (!ids.length) return <Text type="secondary">暂无可引用代码证据</Text>

  return <>
    <ul className="acceptance-evidence-list" aria-label="代码证据">
      {visibleEntries.map(({ id, item }) => {
        if (!item) return <li key={id}><Text type="warning">该证据未加载，需进一步确认</Text></li>
        return <li key={id}>
          <Text strong>{item.evidence_summary || item.description}</Text>
          <div className="acceptance-evidence-location">{item.repository_name} / {item.file_path}{item.start_line ? `：${item.start_line}${item.end_line && item.end_line !== item.start_line ? `–${item.end_line}` : ''} 行` : ''}</div>
          {item.commit_sha ? <div className="acceptance-evidence-commit">代码版本：{item.commit_sha}</div> : null}
          {item.evidence_summary ? <div>{item.description}</div> : null}
        </li>
      })}
    </ul>
    {evidenceEntries.length > evidencePageSize ? <div className="acceptance-evidence-pagination">
      <Text type="secondary">显示 {start + 1}–{Math.min(start + evidencePageSize, evidenceEntries.length)} / {evidenceEntries.length} 条</Text>
      <Pagination current={page} pageSize={evidencePageSize} size="small" showSizeChanger={false} total={evidenceEntries.length} onChange={(nextPage) => setPagination({ evidenceIdentity, currentPage: nextPage })} />
    </div> : null}
  </>
}

function ListPaginationBar({ total, label, page, pageSize, onChange }: { total: number; label: string; page: number; pageSize: number; onChange: (nextPage: number, nextPageSize: number) => void }) {
  if (!total) return null
  const start = (page - 1) * pageSize
  return <div className="acceptance-list-pagination" aria-label={`${label}分页`}>
    <Text type="secondary">显示 {start + 1}–{Math.min(start + pageSize, total)} / {total} 个{label}</Text>
    <Pagination current={page} pageSize={pageSize} showSizeChanger pageSizeOptions={listPageSizeOptions} total={total} onChange={onChange} />
  </div>
}

export function AcceptanceReviewCard({ result, evidence }: { result: AiReviewResult | null; evidence: AiCodeEvidence[] }) {
  const [criteriaPagination, setCriteriaPagination] = useState<ListPagination>({ reportIdentity: '', currentPage: 1, pageSize: 10 })
  const [riskPagination, setRiskPagination] = useState<ListPagination>({ reportIdentity: '', currentPage: 1, pageSize: 10 })
  const [selectedCriterion, setSelectedCriterion] = useState<SelectedCriterion | null>(null)

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

  const reportIdentity = `${result.id}:${report.criteria.map((point) => point.id).join('|')}:${report.risks.map((risk) => risk.id).join('|')}`
  const activeCriteriaPagination = criteriaPagination.reportIdentity === reportIdentity
    ? criteriaPagination
    : { reportIdentity, currentPage: 1, pageSize: 10 }
  const criteriaTotalPages = Math.max(1, Math.ceil(report.criteria.length / activeCriteriaPagination.pageSize))
  const criteriaPage = Math.min(activeCriteriaPagination.currentPage, criteriaTotalPages)
  const criteriaStart = (criteriaPage - 1) * activeCriteriaPagination.pageSize
  const visibleCriteria = report.criteria.slice(criteriaStart, criteriaStart + activeCriteriaPagination.pageSize)
  const activeRiskPagination = riskPagination.reportIdentity === reportIdentity
    ? riskPagination
    : { reportIdentity, currentPage: 1, pageSize: 10 }
  const riskTotalPages = Math.max(1, Math.ceil(report.risks.length / activeRiskPagination.pageSize))
  const riskPage = Math.min(activeRiskPagination.currentPage, riskTotalPages)
  const riskStart = (riskPage - 1) * activeRiskPagination.pageSize
  const visibleRisks = report.risks.slice(riskStart, riskStart + activeRiskPagination.pageSize)
  const findingsByCriterion = new Map(report.findings.map((finding) => [finding.criterionId, finding]))
  const sourcesById = new Map(report.sources.map((source) => [source.id, source]))
  const selectedPoint = selectedCriterion?.reportIdentity === reportIdentity
    ? report.criteria.find((point) => point.id === selectedCriterion.criterionId) ?? null
    : null
  const selectedFinding = selectedPoint ? findingsByCriterion.get(selectedPoint.id) : undefined
  const unresolved = report.findings.filter((finding) => finding.verdict === 'UNCERTAIN').length
  const openCriterion = (criterionId: string) => setSelectedCriterion({ reportIdentity, criterionId })
  const changeCriteriaPage = (nextPage: number, nextPageSize: number) => setCriteriaPagination({ reportIdentity, currentPage: nextPageSize === activeCriteriaPagination.pageSize ? nextPage : 1, pageSize: nextPageSize })
  const changeRiskPage = (nextPage: number, nextPageSize: number) => setRiskPagination({ reportIdentity, currentPage: nextPageSize === activeRiskPagination.pageSize ? nextPage : 1, pageSize: nextPageSize })

  return <Card className="review-ai-card" title="验收点评审" extra={<Tag color={report.verification.status === 'DISAGREEMENT' ? 'warning' : 'processing'}>{report.verification.status === 'DISAGREEMENT' ? '复核存在分歧' : '已独立复核'}</Tag>}>
    <p className="acceptance-summary">{result.summary}</p>
    {unresolved ? <Alert type="warning" showIcon title={`${unresolved} 个验收点需人工确认`} /> : null}
    <Tabs className="acceptance-review-tabs" defaultActiveKey="criteria" items={[
      {
        key: 'criteria',
        label: <>验收点 <Text type="secondary">{report.criteria.length} 项</Text></>,
        children: <div className="acceptance-tab-content">
          <table className="acceptance-table">
            <thead><tr><th scope="col">验收点</th><th scope="col">评审结论</th><th scope="col">依据</th></tr></thead>
            <tbody>{visibleCriteria.map((point) => {
              const finding = findingsByCriterion.get(point.id)
              const criterionTooltip = `${point.id} ${point.description}${point.needsClarification ? '（需求待澄清）' : ''}`
              const reason = finding?.reason || '该验收点缺少结论，需进一步确认。'
              return <tr
                className="acceptance-overview-row"
                key={point.id}
                tabIndex={0}
                aria-label={`查看验收点 ${point.id} 详情`}
                onClick={() => openCriterion(point.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    openCriterion(point.id)
                  }
                }}
              >
                <td data-label="验收点"><Tooltip title={criterionTooltip}><span className="acceptance-cell-ellipsis"><span className="acceptance-point-id">{point.id}</span>{point.description}{point.needsClarification ? <Tag>需求待澄清</Tag> : null}</span></Tooltip></td>
                <td data-label="评审结论"><Tag color={tones[finding?.verdict ?? 'UNCERTAIN']}>{aiVerdictLabels[finding?.verdict ?? 'UNCERTAIN']}</Tag></td>
                <td data-label="依据"><Tooltip title={reason}><span className="acceptance-reason-preview">{reason}</span></Tooltip></td>
              </tr>
            })}</tbody>
          </table>
          <ListPaginationBar total={report.criteria.length} label="验收点" page={criteriaPage} pageSize={activeCriteriaPagination.pageSize} onChange={changeCriteriaPage} />
        </div>,
      },
      {
        key: 'risks',
        label: <>风险项 <Text type="secondary">{report.risks.length} 项</Text></>,
        forceRender: true,
        children: <section className="acceptance-risks acceptance-tab-content" aria-label="风险项">
          {report.risks.length ? <>
            {visibleRisks.map((risk) => <article className="acceptance-risk" key={risk.id}>
              <div><Tag color={risk.certainty === 'CONFIRMED' ? 'error' : 'warning'}>{risk.certainty === 'CONFIRMED' ? '已确认' : '待确认'}</Tag><Tag>{origins[risk.origin]}</Tag><strong>{risk.title}</strong></div>
              <p><strong>触发条件：</strong>{risk.trigger}</p><p><strong>影响：</strong>{risk.impact}</p>
              {risk.criterionIds.length ? <p><Text type="secondary">关联验收点：{risk.criterionIds.join('、')}</Text></p> : null}
              {risk.reviewNote ? <p className="acceptance-disagreement">{risk.reviewNote}</p> : null}
              <details className="acceptance-details"><summary>查看风险依据</summary><EvidenceDetails ids={risk.evidenceIds} evidence={evidence} /></details>
            </article>)}
            <ListPaginationBar total={report.risks.length} label="风险项" page={riskPage} pageSize={activeRiskPagination.pageSize} onChange={changeRiskPage} />
          </> : <p><Text type="secondary">本次评审未发现明确风险项。</Text></p>}
        </section>,
      },
    ]} />
    <Modal open={Boolean(selectedPoint)} title="验收点详情" footer={null} className="acceptance-review-modal" width={780} onCancel={() => setSelectedCriterion(null)}>
      {selectedPoint ? <div className="acceptance-detail-content">
        <section className="acceptance-detail-section">
          <h3><span className="acceptance-point-id">{selectedPoint.id}</span>{selectedPoint.description}</h3>
          {selectedPoint.needsClarification ? <Tag>需求待澄清</Tag> : null}
        </section>
        <section className="acceptance-detail-section">
          <h4>评审结论</h4>
          <Tag color={tones[selectedFinding?.verdict ?? 'UNCERTAIN']}>{aiVerdictLabels[selectedFinding?.verdict ?? 'UNCERTAIN']}</Tag>
          <p>{selectedFinding?.reason || '该验收点缺少结论，需进一步确认。'}</p>
          {selectedFinding?.disagreement ? <div className="acceptance-disagreement">
            <p><strong>调查：</strong>{aiVerdictLabels[selectedFinding.disagreement.investigationVerdict]}。{selectedFinding.disagreement.investigationReason}</p>
            <p><strong>复核：</strong>{aiVerdictLabels[selectedFinding.disagreement.reviewVerdict]}。{selectedFinding.disagreement.reviewReason}</p>
          </div> : null}
        </section>
        <section className="acceptance-detail-section">
          <h4>需求出处</h4>
          {selectedPoint.sources.map((source, index) => <blockquote key={`${source.sourceId}-${index}`}><Text type="secondary">{sourcesById.get(source.sourceId)?.label || source.sourceId}</Text><div>{source.quote}</div></blockquote>)}
        </section>
        <section className="acceptance-detail-section">
          <h4>代码证据{selectedFinding?.evidenceIds.length ? `（${selectedFinding.evidenceIds.length}）` : ''}</h4>
          <EvidenceDetails ids={selectedFinding?.evidenceIds ?? []} evidence={evidence} />
        </section>
      </div> : null}
    </Modal>
  </Card>
}
