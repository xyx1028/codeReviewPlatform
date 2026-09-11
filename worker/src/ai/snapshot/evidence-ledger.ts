/**
 * Records exactly which ranges were shown to the model during one attempt.
 *
 * The model may only cite evidence by an id this ledger issued. That turns
 * "the model claims it saw this code" into "the platform showed this exact
 * blob range and can re-read it from the same commit object". Ids are scoped to
 * one task and one agent attempt, so a receipt from another attempt is refused
 * rather than silently accepted.
 */

import { randomUUID } from 'node:crypto'
import type { RepositoryName } from '../../git/repositories.js'

export interface EvidenceReceipt {
  evidenceId: string
  taskId: string
  agentAttempt: number
  repository: RepositoryName
  commitSha: string
  filePath: string
  blobSha: string
  startLine: number
  endLine: number
  contentHash: string
  shownAt: string
}

export interface EvidenceClaim {
  evidenceId: string
  repository: string
  filePath: string
  startLine: number
  endLine: number
}

export type EvidenceRejection =
  | { code: 'EVIDENCE_ID_UNKNOWN'; reason: string }
  | { code: 'EVIDENCE_ID_FOREIGN'; reason: string }
  | { code: 'EVIDENCE_MISMATCH'; reason: string }
  | { code: 'EVIDENCE_RANGE_OUTSIDE'; reason: string }

export class EvidenceLedger {
  private readonly receipts = new Map<string, EvidenceReceipt>()

  constructor(
    private readonly taskId: string,
    private readonly agentAttempt: number,
  ) {}

  /** Record one shown range and return its citable receipt. */
  record(shown: {
    repository: RepositoryName
    commitSha: string
    filePath: string
    blobSha: string
    startLine: number
    endLine: number
    contentHash: string
  }): EvidenceReceipt {
    const receipt: EvidenceReceipt = {
      evidenceId: `ev_${randomUUID()}`,
      taskId: this.taskId,
      agentAttempt: this.agentAttempt,
      shownAt: new Date().toISOString(),
      ...shown,
    }
    this.receipts.set(receipt.evidenceId, receipt)
    return receipt
  }

  get(evidenceId: string): EvidenceReceipt | undefined {
    return this.receipts.get(evidenceId)
  }

  size(): number {
    return this.receipts.size
  }

  all(): EvidenceReceipt[] {
    return [...this.receipts.values()]
  }

  /**
   * Check one claim against what was actually shown. This is the structural
   * half of verification; re-reading the blob is the deterministic half.
   */
  check(claim: EvidenceClaim): { ok: true; receipt: EvidenceReceipt } | { ok: false; rejection: EvidenceRejection } {
    const receipt = this.receipts.get(claim.evidenceId)
    if (!receipt) {
      return {
        ok: false,
        rejection: {
          code: 'EVIDENCE_ID_UNKNOWN',
          reason: `evidenceId ${JSON.stringify(claim.evidenceId)} was never returned by a snapshot tool in this attempt`,
        },
      }
    }
    if (receipt.taskId !== this.taskId || receipt.agentAttempt !== this.agentAttempt) {
      return {
        ok: false,
        rejection: {
          code: 'EVIDENCE_ID_FOREIGN',
          reason: `evidenceId ${JSON.stringify(claim.evidenceId)} belongs to a different task attempt`,
        },
      }
    }
    if (claim.repository !== receipt.repository || claim.filePath !== receipt.filePath) {
      return {
        ok: false,
        rejection: {
          code: 'EVIDENCE_MISMATCH',
          reason: `evidenceId ${JSON.stringify(claim.evidenceId)} was issued for ${receipt.repository}:${receipt.filePath}, not ${claim.repository}:${claim.filePath}`,
        },
      }
    }
    if (claim.startLine < receipt.startLine || claim.endLine > receipt.endLine) {
      return {
        ok: false,
        rejection: {
          code: 'EVIDENCE_RANGE_OUTSIDE',
          reason: `cited range ${claim.startLine}-${claim.endLine} is not inside the shown range ${receipt.startLine}-${receipt.endLine} of ${receipt.filePath}`,
        },
      }
    }
    return { ok: true, receipt }
  }
}
