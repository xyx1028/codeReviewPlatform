import { describe, it, expect } from 'vitest'
import { parseLsRemote, shaBelongsToBranch, GitError } from '../git/verify.js'
import { isJobDirName, cleanupJobDir } from '../security/cleanup.js'
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHA = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)

describe('parseLsRemote', () => {
  it('extracts the sha for the exact ref', () => {
    const out = `${SHA}\trefs/heads/feature_dev\n${SHA2}\trefs/heads/release\n`
    expect(parseLsRemote(out, 'refs/heads/feature_dev')).toBe(SHA)
  })
  it('throws when the ref is missing', () => {
    expect(() => parseLsRemote('', 'refs/heads/feature_dev')).toThrow(GitError)
  })
})

describe('shaBelongsToBranch', () => {
  it('matches identical shas case-insensitively', () => {
    expect(shaBelongsToBranch(SHA, SHA.toUpperCase())).toBe(true)
    expect(shaBelongsToBranch(SHA, SHA2)).toBe(false)
    expect(shaBelongsToBranch('bad', SHA)).toBe(false)
  })
})

describe('cleanup util', () => {
  it('recognizes UUID job dir names', () => {
    expect(isJobDirName('11111111-2222-3333-4444-555555555555')).toBe(true)
    expect(isJobDirName('not-a-uuid')).toBe(false)
    expect(isJobDirName('../etc')).toBe(false)
  })

  it('refuses to clean non-UUID names', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'))
    expect(() => cleanupJobDir(root, 'not-a-uuid')).toThrow(/non-UUID/)
    expect(() => cleanupJobDir(root, '../../etc')).toThrow()
  })

  it('cleans a real UUID job dir inside the workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'))
    const jobId = '11111111-2222-3333-4444-555555555555'
    mkdirSync(join(root, jobId, 'kdmanage-backend'), { recursive: true })
    expect(existsSync(join(root, jobId))).toBe(true)
    expect(cleanupJobDir(root, jobId)).toBe(true)
    expect(existsSync(join(root, jobId))).toBe(false)
  })
})
