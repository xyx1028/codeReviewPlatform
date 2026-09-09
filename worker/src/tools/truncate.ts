/**
 * Truncation helpers for tool outputs. (Plan §11.4)
 * Tool return values must be truncated and record whether truncation occurred.
 */

export interface TruncatedList<T> {
  items: T[]
  truncated: boolean
  totalBeforeTruncation: number
}

/** Truncate an array to at most `max` items, recording whether it happened. */
export function truncateList<T>(items: T[], max: number): TruncatedList<T> {
  const total = items.length
  if (total <= max) {
    return { items, truncated: false, totalBeforeTruncation: total }
  }
  return { items: items.slice(0, max), truncated: true, totalBeforeTruncation: total }
}

export interface TruncatedText {
  text: string
  truncated: boolean
  originalLength: number
}

/** Truncate a string to at most `maxChars`, recording whether it happened. */
export function truncateText(text: string, maxChars: number): TruncatedText {
  if (text.length <= maxChars) {
    return { text, truncated: false, originalLength: text.length }
  }
  return {
    text: text.slice(0, maxChars),
    truncated: true,
    originalLength: text.length,
  }
}

/** Truncate a range of lines to at most `maxLines`. */
export function clampLineRange(
  startLine: number,
  endLine: number,
  maxLines: number,
): { startLine: number; endLine: number; truncated: boolean } {
  const start = Math.max(1, Math.floor(startLine))
  let end = Math.max(start, Math.floor(endLine))
  let truncated = false
  if (end - start + 1 > maxLines) {
    end = start + maxLines - 1
    truncated = true
  }
  return { startLine: start, endLine: end, truncated }
}
