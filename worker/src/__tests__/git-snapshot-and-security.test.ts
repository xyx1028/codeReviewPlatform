import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  authArgs,
  chmodReadOnlyRecursive,
  prepareRepositoryAtSnapshot,
  cachePathFor,
} from '../git/prepare.js'
import { GitError } from '../git/verify.js'
import { assertSafePathGlob, MAX_PATH_GLOB_LENGTH, PathPolicyError } from '../security/path-policy.js'
import { redactString, redact } from '../security/redaction.js'

const SHA = 'a'.repeat(40)

describe('git auth args (token mode uses http.extraHeader, not URL)', () => {
  it('emits an extraHeader Basic credential config', () => {
    const args = authArgs({
      cacheRoot: '/c',
      authMode: 'token',
      deployUser: 'deployer',
      deployToken: 'tok-123',
    })
    expect(args[0]).toBe('-c')
    expect(args[1]).toMatch(/^http\.extraHeader=Authorization: Basic /)
    // Credential is base64, never the raw token or a URL.
    expect(args[1]).not.toContain('tok-123')
    expect(args[1]).not.toContain('://')
  })

  it('emits no auth args in local mode', () => {
    expect(authArgs({ cacheRoot: '/c', authMode: 'local' })).toEqual([])
  })
})

describe('prepareRepositoryAtSnapshot exact-SHA guard', () => {
  it('refuses an invalid SHA before touching the network', async () => {
    await expect(
      prepareRepositoryAtSnapshot('kdmanage-backend', 'feature_dev', 'not-a-sha', {
        cacheRoot: '/tmp/does-not-matter',
        authMode: 'local',
      }),
    ).rejects.toBeInstanceOf(GitError)
  })

  it('cachePathFor is keyed by repository and full sha', () => {
    expect(cachePathFor('/cache', 'kdmanage-backend', SHA)).toBe(`/cache/kdmanage-backend/${SHA}`)
  })
})

describe('chmodReadOnlyRecursive (shared cache is immutable after publish)', () => {
  it('makes files 0o444 and directories 0o555', () => {
    const root = mkdtempSync(join(tmpdir(), 'ro-'))
    try {
      mkdirSync(join(root, 'sub'), { recursive: true })
      writeFileSync(join(root, 'sub', 'f.txt'), 'x')
      chmodReadOnlyRecursive(root)
      const fileMode = statSync(join(root, 'sub', 'f.txt')).mode & 0o777
      const dirMode = statSync(join(root, 'sub')).mode & 0o777
      expect(fileMode).toBe(0o444)
      expect(dirMode).toBe(0o555)
    } finally {
      // Restore writable so cleanup can remove it.
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  })
})

describe('assertSafePathGlob', () => {
  it('accepts a normal glob', () => {
    expect(assertSafePathGlob('**/*.java')).toBe('**/*.java')
  })
  it('rejects overly long globs', () => {
    expect(() => assertSafePathGlob('a'.repeat(MAX_PATH_GLOB_LENGTH + 1))).toThrow(PathPolicyError)
  })
  it('rejects absolute globs', () => {
    expect(() => assertSafePathGlob('/etc/**')).toThrow(PathPolicyError)
  })
  it('rejects traversal globs', () => {
    expect(() => assertSafePathGlob('../secrets/**')).toThrow(PathPolicyError)
    expect(() => assertSafePathGlob('src/../../x')).toThrow(PathPolicyError)
  })
  it('rejects null bytes and empty', () => {
    expect(() => assertSafePathGlob('a\0b')).toThrow(PathPolicyError)
    expect(() => assertSafePathGlob('')).toThrow(PathPolicyError)
  })
})

describe('redaction — Basic token and substring keys', () => {
  it('masks Basic auth tokens (http.extraHeader)', () => {
    const out = redactString('git -c http.extraHeader=Authorization: Basic ZGVwbG95OnRvazEyMw== fetch')
    // The base64 credential must never survive redaction.
    expect(out).not.toContain('ZGVwbG95OnRvazEyMw==')
    expect(out).toContain('[REDACTED]')
  })

  it('masks keys by sensitive substring, not exact name', () => {
    const out = redact({
      gitlab_deploy_token: 'tok',
      apiKeySecretId: 'sid',
      serviceRoleKey: 'srk',
      X_API_KEY: 'k',
      harmless: 'ok',
    }) as Record<string, unknown>
    expect(out.gitlab_deploy_token).toBe('[REDACTED]')
    expect(out.apiKeySecretId).toBe('[REDACTED]')
    expect(out.serviceRoleKey).toBe('[REDACTED]')
    expect(out.X_API_KEY).toBe('[REDACTED]')
    expect(out.harmless).toBe('ok')
  })
})
