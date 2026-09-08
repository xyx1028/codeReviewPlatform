import type { BaselineCommit } from '../types'

export function parseBaselineCommit(value: string | null): BaselineCommit | null {
  if (!value) return null

  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

    const metadata = parsed as { actual_branch?: unknown; commits?: unknown }
    const actualBranch = typeof metadata.actual_branch === 'string' ? metadata.actual_branch.trim() : ''
    if (!actualBranch || !Array.isArray(metadata.commits) || metadata.commits.length === 0) return null

    const repositories = new Set<string>()
    const commits = metadata.commits.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error()
      const entry = item as { repository?: unknown; sha?: unknown; subject?: unknown }
      const repository = typeof entry.repository === 'string' ? entry.repository.trim() : ''
      const sha = typeof entry.sha === 'string' ? entry.sha.trim() : ''
      const hasSubject = Object.prototype.hasOwnProperty.call(entry, 'subject')
      const subject = typeof entry.subject === 'string' ? entry.subject.trim() : ''
      if (!repository || !/^[0-9A-Fa-f]{40}([0-9A-Fa-f]{24})?$/.test(sha) || repositories.has(repository) || (hasSubject && !subject)) throw new Error()
      repositories.add(repository)
      return subject ? { repository, sha, subject } : { repository, sha }
    })

    return { actual_branch: actualBranch, commits }
  } catch {
    return null
  }
}
