import { describe, it, expect } from 'vitest'
import { truncateList, truncateText, clampLineRange } from '../tools/truncate.js'

describe('truncateList', () => {
  it('does not truncate when within limit', () => {
    const r = truncateList([1, 2, 3], 5)
    expect(r.truncated).toBe(false)
    expect(r.items).toEqual([1, 2, 3])
    expect(r.totalBeforeTruncation).toBe(3)
  })
  it('truncates and flags when over limit', () => {
    const r = truncateList([1, 2, 3, 4, 5], 2)
    expect(r.truncated).toBe(true)
    expect(r.items).toEqual([1, 2])
    expect(r.totalBeforeTruncation).toBe(5)
  })
})

describe('truncateText', () => {
  it('truncates strings and records original length', () => {
    const r = truncateText('abcdef', 3)
    expect(r.text).toBe('abc')
    expect(r.truncated).toBe(true)
    expect(r.originalLength).toBe(6)
  })
})

describe('clampLineRange', () => {
  it('clamps ranges to max lines', () => {
    const r = clampLineRange(1, 500, 200)
    expect(r.startLine).toBe(1)
    expect(r.endLine).toBe(200)
    expect(r.truncated).toBe(true)
  })
  it('keeps small ranges intact', () => {
    const r = clampLineRange(10, 20, 200)
    expect(r).toEqual({ startLine: 10, endLine: 20, truncated: false })
  })
})
