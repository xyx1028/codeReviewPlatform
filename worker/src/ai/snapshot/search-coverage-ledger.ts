/**
 * Records what the attempt actually searched, so a "not implemented" verdict
 * has to be earned.
 *
 * A zero-hit search only means something if the search was broad, complete, and
 * not truncated. This ledger keeps the facts needed to decide that, and the
 * coverage policy below is what stands between a real absence and a model that
 * simply never looked.
 */

import type { RepositoryName } from '../../git/repositories.js'

export interface SearchAttemptRecord {
  repository: RepositoryName
  query: string
  pathGlob?: string
  hits: number
  truncated: boolean
  at: string
}

export interface CoverageVerdict {
  sufficient: boolean
  reason?: string
  searchedRepositories: RepositoryName[]
  totalSearches: number
  truncatedSearches: number
}

export interface CoveragePolicy {
  /** Repositories that must each have at least one complete search. */
  requiredRepositories: readonly RepositoryName[]
  /** Minimum distinct queries per repository. */
  minQueriesPerRepository: number
}

export class SearchCoverageLedger {
  private readonly records: SearchAttemptRecord[] = []

  record(entry: Omit<SearchAttemptRecord, 'at'>): void {
    this.records.push({ ...entry, at: new Date().toISOString() })
  }

  all(): SearchAttemptRecord[] {
    return [...this.records]
  }

  size(): number {
    return this.records.length
  }

  searchedRepositories(): RepositoryName[] {
    return [...new Set(this.records.map((record) => record.repository))]
  }

  /**
   * Decide whether the recorded searches justify claiming absence.
   * Truncated searches never count: a clipped result set cannot prove a
   * negative.
   */
  evaluate(policy: CoveragePolicy): CoverageVerdict {
    const truncatedSearches = this.records.filter((record) => record.truncated).length
    const base = {
      searchedRepositories: this.searchedRepositories(),
      totalSearches: this.records.length,
      truncatedSearches,
    }

    for (const repository of policy.requiredRepositories) {
      const complete = this.records.filter(
        (record) => record.repository === repository && !record.truncated,
      )
      const distinctQueries = new Set(complete.map((record) => record.query.trim().toLowerCase()))
      if (distinctQueries.size < policy.minQueriesPerRepository) {
        return {
          ...base,
          sufficient: false,
          reason: `${repository} has ${distinctQueries.size} complete distinct searches, but claiming absence requires at least ${policy.minQueriesPerRepository}. Search it further, or submit UNCERTAIN instead of NOT_IMPLEMENTED.`,
        }
      }
    }

    return { ...base, sufficient: true }
  }
}
