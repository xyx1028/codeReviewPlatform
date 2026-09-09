import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  containsTraversal,
  isBlockedPath,
  isInside,
  resolveSafePath,
  PathPolicyError,
} from '../security/path-policy.js'

describe('path traversal detection', () => {
  it('flags .. segments and null bytes', () => {
    expect(containsTraversal('../etc/passwd')).toBe(true)
    expect(containsTraversal('a/../../b')).toBe(true)
    expect(containsTraversal('a/b/c')).toBe(false)
    expect(containsTraversal('a/\0/b')).toBe(true)
  })
})

describe('blocked path detection', () => {
  it('blocks sensitive directories and secret files', () => {
    expect(isBlockedPath('.git/config')).toBe(true)
    expect(isBlockedPath('node_modules/x/index.js')).toBe(true)
    expect(isBlockedPath('target/classes/A.class')).toBe(true)
    expect(isBlockedPath('.env')).toBe(true)
    expect(isBlockedPath('config/.env.production')).toBe(true)
    expect(isBlockedPath('certs/server.pem')).toBe(true)
    expect(isBlockedPath('deploy/id_rsa')).toBe(true)
    expect(isBlockedPath('src/main/java/App.java')).toBe(false)
  })
})

describe('isInside', () => {
  it('detects containment correctly', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true)
    expect(isInside('/a/b', '/a/b')).toBe(true)
    expect(isInside('/a/b', '/a/bc')).toBe(false)
    expect(isInside('/a/b', '/a')).toBe(false)
  })
})

describe('resolveSafePath', () => {
  let root: string
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'pp-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'App.java'), 'line1\nline2\n')
    // symlink escaping the root
    try {
      symlinkSync('/etc/passwd', join(root, 'escape-link'))
    } catch {
      // ignore on platforms without symlink permission
    }
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('resolves a legitimate file inside the root', () => {
    const p = resolveSafePath(root, 'src/App.java')
    expect(p.endsWith('App.java')).toBe(true)
  })

  it('rejects traversal outside the root', () => {
    expect(() => resolveSafePath(root, '../../../etc/passwd')).toThrow(PathPolicyError)
  })

  it('rejects absolute paths', () => {
    expect(() => resolveSafePath(root, '/etc/passwd')).toThrow(PathPolicyError)
  })

  it('rejects blocked files', () => {
    expect(() => resolveSafePath(root, '.env')).toThrow(PathPolicyError)
  })

  it('rejects symlinks that escape the root', () => {
    // Only meaningful when the symlink was created.
    let threw = false
    try {
      resolveSafePath(root, 'escape-link')
    } catch (e) {
      threw = e instanceof PathPolicyError
    }
    expect(threw).toBe(true)
  })
})
