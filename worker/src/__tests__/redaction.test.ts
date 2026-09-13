import { describe, it, expect } from 'vitest'
import { redact, redactString, redactError } from '../security/redaction.js'

describe('redactString', () => {
  it('masks bearer tokens', () => {
    expect(redactString('Authorization: Bearer sk-abcdef123456')).not.toContain('sk-abcdef123456')
  })
  it('masks credentials embedded in git URLs', () => {
    const out = redactString('cloning https://user:supersecrettoken@git.kingdee.com/x.git')
    expect(out).not.toContain('supersecrettoken')
    // URL stripping drops userinfo entirely, keeping only origin+path.
    expect(out).not.toContain('user:')
    expect(out).toContain('https://git.kingdee.com/x.git')
  })
  it('masks sk- style api keys and jwts', () => {
    expect(redactString('key sk-0123456789abcdef')).not.toContain('sk-0123456789abcdef')
    const jwt = 'eyJhbGciOi.eyJzdWIiOi.SflKxwRJ'
    expect(redactString(`token ${jwt}`)).not.toContain(jwt)
  })

  it('masks labelled agent capability tokens (base64url) in free-form text', () => {
    // randomBytes(32).toString('base64url') is 43 base64url chars.
    const token = 'Zm9vYmFyMDEyMzQ1Njc4OWFiY2RlZmdoaWprbG1ub3A'
    const out = redactString(`broker denied capability=${token} for agent`)
    expect(out).not.toContain(token)
    expect(out).toContain('[REDACTED]')
    // The surrounding label and context are preserved.
    expect(out).toContain('broker denied')
    expect(out).toContain('for agent')
  })

  it('does not clobber a bare 43-char identifier without a capability label', () => {
    const id = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'
    // No capability/token label precedes it, so it must survive untouched.
    expect(redactString(`commit ${id} resolved`)).toContain(id)
  })

  it('strips query and fragment from URLs, keeping only origin+path', () => {
    const out = redactString(
      'fetched https://docs.example.com/guide?token=leak123&sig=abc#section-secret next',
    )
    expect(out).not.toContain('token=leak123')
    expect(out).not.toContain('sig=abc')
    expect(out).not.toContain('section-secret')
    expect(out).toContain('https://docs.example.com/guide')
    expect(out).toContain('next')
  })

  it('strips userinfo and query together from a credentialed URL', () => {
    const out = redactString('clone https://deploy:tok987@git.kingdee.com/x.git?private_token=zzz')
    expect(out).not.toContain('tok987')
    expect(out).not.toContain('private_token=zzz')
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

  it('masks agent capability tokens by key name', () => {
    const token = 'Zm9vYmFyMDEyMzQ1Njc4OWFiY2RlZmdoaWprbG1ub3A'
    const out = redact({
      agentId: 'agent-1',
      capabilityToken: token,
      rootCapabilityToken: token,
      nested: { agent_capability: token, parentCapability: token },
    }) as Record<string, unknown>
    expect(out.agentId).toBe('agent-1')
    expect(out.capabilityToken).toBe('[REDACTED]')
    expect(out.rootCapabilityToken).toBe('[REDACTED]')
    const nested = out.nested as Record<string, unknown>
    expect(nested.agent_capability).toBe('[REDACTED]')
    expect(nested.parentCapability).toBe('[REDACTED]')
  })

  it('masks session JSONL content by key name', () => {
    const transcript = '{"role":"assistant","text":"secret source code here"}'
    const out = redact({
      sessionId: 's-1',
      sessionRevision: 3,
      sessionContent: transcript,
      nested: { session_jsonl: transcript, transcript },
    }) as Record<string, unknown>
    expect(out.sessionId).toBe('s-1')
    expect(out.sessionRevision).toBe(3)
    expect(out.sessionContent).toBe('[REDACTED]')
    const nested = out.nested as Record<string, unknown>
    expect(nested.session_jsonl).toBe('[REDACTED]')
    expect(nested.transcript).toBe('[REDACTED]')
  })

  it('reduces storage locator host paths to a basename', () => {
    const out = redact({
      storageLocator: '/workspace/agent-sessions/attempt-42/session-9.jsonl',
      sessionPath: '/workspace/agent-sessions/attempt-42',
      dshHome: '/workspace/agent-attempts/attempt-42/home',
    }) as Record<string, unknown>
    expect(out.storageLocator).toBe('[path:session-9.jsonl]')
    expect(out.storageLocator).not.toContain('agent-sessions')
    expect(out.storageLocator).not.toContain('/workspace')
    expect(out.sessionPath).toBe('[path:attempt-42]')
    expect(out.dshHome).toBe('[path:home]')
  })

  it('strips query/fragment from URL-valued keys', () => {
    const out = redact({
      modelEndpoint: 'https://api.example.com/v1/chat?key=leaksecret#frag',
      auditUrl: 'https://docs.example.com/p?token=zzz',
    }) as Record<string, unknown>
    expect(out.modelEndpoint).toBe('https://api.example.com/v1/chat')
    expect(out.auditUrl).toBe('https://docs.example.com/p')
    expect(JSON.stringify(out)).not.toContain('leaksecret')
    expect(JSON.stringify(out)).not.toContain('token=zzz')
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

describe('方案 §7.11 禁止记录的全部类别（逐条回归）', () => {
  const SECRET = 'S3CRET-VALUE-must-not-appear'

  it('源码正文不得进日志', () => {
    // §7.11 明确禁止记录源码。此前键名黑名单里没有对应条目：`{ sourceCode: ... }` 与
    // `{ content: ... }`（快照读取结果的字段名）会原样写进日志。当时没有活跃泄漏点，但黑名单
    // 的意义就是防住后加的代码。
    for (const ctx of [
      { sourceCode: `class Foo { ${SECRET} }` },
      { content: `class Foo { ${SECRET} }` },
      { fileContent: SECRET },
      { rangeContent: SECRET },
      { codeSnippet: SECRET },
      { snippet: SECRET },
    ]) {
      expect(JSON.stringify(redact(ctx))).not.toContain(SECRET)
    }
  })

  it('网页正文不得进日志', () => {
    for (const ctx of [
      { pageBody: `网页内容 ${SECRET}` },
      { body: SECRET },
      { responseBody: SECRET },
      { htmlBody: SECRET },
      { pageContent: SECRET },
      { bodyText: SECRET },
    ]) {
      expect(JSON.stringify(redact(ctx))).not.toContain(SECRET)
    }
  })

  it('安全字段必须保留，不能被上面的规则误伤', () => {
    // 这一条和上面两条同等重要：把 `contentHash` / `responseBytes` / 错误码打掉会让排查失去
    // 依据。全仓有 53 处引用这些字段，它们必须能记。
    const kept = redact({
      contentHash: 'sha256:abc123',
      content_hash: 'sha256:def456',
      responseBytes: 4096,
      requestBytes: 128,
      code: 'AGENT_IDENTITY_INVALID',
      workspacePath: 'src/OrderService.java',
    }) as Record<string, unknown>
    expect(kept.contentHash).toBe('sha256:abc123')
    expect(kept.content_hash).toBe('sha256:def456')
    expect(kept.responseBytes).toBe(4096)
    expect(kept.requestBytes).toBe(128)
    expect(kept.code).toBe('AGENT_IDENTITY_INVALID')
    expect(kept.workspacePath).toBe('src/OrderService.java')
  })

  it('其余禁止类别逐条确认', () => {
    const categories: Array<[string, Record<string, unknown>]> = [
      ['Prompt 全文', { promptBody: SECRET }],
      ['需求全文', { requirementText: SECRET }],
      ['工具正文', { toolResultBody: SECRET }],
      ['Session JSONL', { sessionTranscript: SECRET }],
      ['API Key', { apiKey: SECRET }],
      ['service role', { supabaseServiceRoleKey: SECRET }],
      ['Git token', { gitlabDeployToken: SECRET }],
      ['claim token', { claimToken: SECRET }],
      ['Broker token', { brokerToken: SECRET }],
      ['capability token', { agentCapability: SECRET }],
      ['Authorization 头', { headers: { authorization: `Bearer ${SECRET}` } }],
    ]
    for (const [label, ctx] of categories) {
      expect(JSON.stringify(redact(ctx)), label).not.toContain(SECRET)
    }
  })

  it('Web URL 只保留 origin+path', () => {
    const out = redact({ url: `https://docs.example.com/a?key=${SECRET}#${SECRET}` }) as {
      url: string
    }
    expect(out.url).toBe('https://docs.example.com/a')
  })
})
