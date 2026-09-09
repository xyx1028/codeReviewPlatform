import { describe, it, expect } from 'vitest'
import { redact, redactString, redactError } from '../security/redaction.js'

describe('redactString', () => {
  it('masks bearer tokens', () => {
    expect(redactString('Authorization: Bearer sk-abcdef123456')).not.toContain('sk-abcdef123456')
  })
  it('masks credentials embedded in git URLs', () => {
    const out = redactString('cloning https://user:supersecrettoken@git.kingdee.com/x.git')
    expect(out).not.toContain('supersecrettoken')
    expect(out).toContain('user:[REDACTED]@')
  })
  it('masks sk- style api keys and jwts', () => {
    expect(redactString('key sk-0123456789abcdef')).not.toContain('sk-0123456789abcdef')
    const jwt = 'eyJhbGciOi.eyJzdWIiOi.SflKxwRJ'
    expect(redactString(`token ${jwt}`)).not.toContain(jwt)
  })
})

describe('redact object', () => {
  it('masks sensitive keys entirely', () => {
    const out = redact({
      api_key: 'sk-secret',
      authorization: 'Bearer x',
      supabase_service_role_key: 'srk',
      nested: { deploy_token: 'tok', safe: 'ok' },
    }) as Record<string, unknown>
    expect(out.api_key).toBe('[REDACTED]')
    expect(out.authorization).toBe('[REDACTED]')
    expect(out.supabase_service_role_key).toBe('[REDACTED]')
    expect((out.nested as Record<string, unknown>).deploy_token).toBe('[REDACTED]')
    expect((out.nested as Record<string, unknown>).safe).toBe('ok')
  })

  it('handles circular references', () => {
    const a: Record<string, unknown> = { name: 'x' }
    a.self = a
    const out = redact(a) as Record<string, unknown>
    expect(out.self).toBe('[Circular]')
  })
})

describe('redactError', () => {
  it('redacts secrets inside error messages', () => {
    const err = new Error('failed https://u:tok123@git.kingdee.com/x.git Bearer sk-xyz987654')
    const msg = redactError(err)
    expect(msg).not.toContain('tok123')
    expect(msg).not.toContain('sk-xyz987654')
  })
})
