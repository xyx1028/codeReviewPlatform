import { describe, expect, it, vi } from 'vitest'
import {
  TREND_DIMENSIONS,
  forbiddenOutputPattern,
  parseArgs,
  parseSince,
} from './runtime-report.mjs'

describe('runtime-report CLI 参数契约', () => {
  it('解析位置参数、值参数与 remote 布尔开关', () => {
    expect(
      parseArgs([
        'trend',
        '--group-by',
        'model_label,policy_hash',
        '--since',
        '30d',
        '--remote',
      ]),
    ).toEqual({
      _: ['trend'],
      'group-by': 'model_label,policy_hash',
      since: '30d',
      remote: true,
    })
  })

  it('趋势分组白名单与数据库契约使用的八个稳定维度一致', () => {
    expect(TREND_DIMENSIONS).toEqual([
      'model_label',
      'policy_hash',
      'profile_config_hash',
      'harness_version',
      'capability_contract_hash',
      'worker_id',
      'batch_id',
      'finished_day',
    ])
  })
})

describe('runtime-report 时间窗口', () => {
  it('按固定当前时间解析相对天、小时、分钟和默认窗口', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-13T08:00:00.000Z'))
    try {
      expect(parseSince('30d', 90)).toBe('2026-08-14T08:00:00.000Z')
      expect(parseSince('12h', 90)).toBe('2026-09-12T20:00:00.000Z')
      expect(parseSince('15m', 90)).toBe('2026-09-13T07:45:00.000Z')
      expect(parseSince(undefined, 7)).toBe('2026-09-06T08:00:00.000Z')
    } finally {
      vi.useRealTimers()
    }
  })

  it('规范化 ISO 时间戳', () => {
    expect(parseSince('2026-09-01T08:30:00+08:00', 90)).toBe('2026-09-01T00:30:00.000Z')
  })
})

describe('runtime-report 输出安全扫描', () => {
  it('允许合法 token 计数字段与稳定机器码', () => {
    expect(
      forbiddenOutputPattern(
        JSON.stringify({ input_tokens: 123, output_tokens: 45, error_code: 'MODEL_FAILED' }),
      ),
    ).toBeNull()
  })

  it.each([
    ['bearer 头', 'Authorization: Bearer abcdefghijklmnop'],
    ['模型密钥', 'sk-abcdefghijklmno'],
    ['api key 字段', '{"service_role_key":"do-not-print"}'],
    ['URL', 'https://internal.example.test/path'],
    ['宿主机绝对路径', '/Users/example/private/session'],
    ['git 凭据', 'glpat-abcdefghijklmno'],
    ['session locator', 'session-1.jsonl'],
  ])('拒绝%s', (expected, value) => {
    expect(forbiddenOutputPattern(value)).toBe(expected)
  })
})
