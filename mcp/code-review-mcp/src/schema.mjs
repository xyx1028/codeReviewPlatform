/**
 * 服务端入参校验（V1.56）。
 *
 * 为什么必须有：我们用的是 MCP SDK 的**低层** `Server`，它只把 `inputSchema` 原样转发给
 * 客户端，**不会**校验 `tools/call` 的实参（校验只存在于高层 `McpServer` + zod 那条路径）。
 * 所以在此之前，声明的 schema 对服务端是一张装饰 —— 多传一个字段会被静默忽略，
 * `commit_window_days: "7天"` 这种会一路走到业务代码里才被拦，而拦它的是另一份手写规则。
 *
 * 两份规则（声明的 schema + 手写的 if）早晚会分叉。所以这里**用我们对外公布的那一份
 * schema 本身**去校验，而不是另写一遍判断：对外说什么，服务端就按什么拒。
 *
 * 只实现本仓库 schema 里实际用到的关键字。遇到没实现的关键字**抛错**而不是跳过 ——
 * 悄悄忽略一条约束，等于对外承诺了一件服务端并不执行的事。
 */

const SUPPORTED_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'minLength',
  'maxLength',
  'pattern',
  'description',
  'title',
  'minimum',
  'maximum',
])

export class SchemaViolation {
  constructor({ path, message, expected = null, received = null }) {
    this.path = path
    this.message = message
    this.expected = expected
    this.received = received
  }
}

function describeValue(value) {
  if (value === undefined) return '（未提供）'
  if (value === null) return 'null'
  if (typeof value === 'string') return `"${value.length > 80 ? `${value.slice(0, 80)}…` : value}"`
  if (Array.isArray(value)) return `数组（${value.length} 项）`
  if (typeof value === 'object') return '对象'
  return String(value)
}

function jsonType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

function assertSupported(schema, path) {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(
        `schema 校验器不支持关键字 "${keyword}"（位置 ${path}）。` +
          '请在 src/schema.mjs 里实现它，而不是让它被静默忽略。',
      )
    }
  }
}

function validateValue(schema, value, path, violations) {
  assertSupported(schema, path)

  if (schema.type === 'integer' || schema.type === 'number') {
    // 刻意不接受 "7" 这种字符串数字：模型传字符串往往说明它没看懂参数，
    // 而我们悄悄转成 7 就把一次"它其实不确定"变成了一次真实提交。
    if (typeof value !== 'number' || Number.isNaN(value)) {
      violations.push(
        new SchemaViolation({
          path,
          message: `必须是${schema.type === 'integer' ? '整数' : '数字'}（不要加引号、不要带单位）`,
          expected: schema.type,
          received: `${jsonType(value)} ${describeValue(value)}`,
        }),
      )
      return
    }
    if (schema.type === 'integer' && !Number.isInteger(value)) {
      violations.push(
        new SchemaViolation({ path, message: '必须是整数', expected: 'integer', received: String(value) }),
      )
      return
    }
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      violations.push(
        new SchemaViolation({ path, message: `不能小于 ${schema.minimum}`, received: String(value) }),
      )
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      violations.push(
        new SchemaViolation({ path, message: `不能大于 ${schema.maximum}`, received: String(value) }),
      )
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') {
      violations.push(
        new SchemaViolation({
          path,
          message: '必须是字符串',
          expected: 'string',
          received: `${jsonType(value)} ${describeValue(value)}`,
        }),
      )
      return
    }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      violations.push(
        new SchemaViolation({
          path,
          message: schema.minLength === 1 ? '不能为空' : `至少 ${schema.minLength} 个字符`,
          received: describeValue(value),
        }),
      )
      return
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      violations.push(
        new SchemaViolation({
          path,
          message: `最多 ${schema.maxLength} 个字符（当前 ${value.length}）`,
          received: `${value.length} 字符`,
        }),
      )
      return
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      violations.push(
        new SchemaViolation({
          path,
          message: `格式不符合要求（需匹配 ${schema.pattern}）`,
          expected: schema.pattern,
          received: describeValue(value),
        }),
      )
      return
    }
  } else if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      violations.push(
        new SchemaViolation({ path, message: '必须是对象', received: describeValue(value) }),
      )
      return
    }
    validateObject(schema, value, path, violations)
    return
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    violations.push(
      new SchemaViolation({
        path,
        message: `只能是以下取值之一：${schema.enum.join(' / ')}`,
        expected: schema.enum.join(' / '),
        received: describeValue(value),
      }),
    )
  }
}

function validateObject(schema, value, basePath, violations) {
  const properties = schema.properties ?? {}

  for (const key of schema.required ?? []) {
    const provided = value[key]
    if (provided === undefined || provided === null || provided === '') {
      violations.push(
        new SchemaViolation({
          path: basePath === '' ? key : `${basePath}.${key}`,
          message: '必填参数，缺失或为空',
          expected: properties[key]?.enum
            ? properties[key].enum.join(' / ')
            : (properties[key]?.type ?? null),
          received: describeValue(provided),
        }),
      )
    }
  }

  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(properties))
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        // 不静默忽略：多出来的字段通常是模型把别的工具的参数名带过来了，或者
        // 把参数名拼错了（workspace 写成 workspace_names）。忽略它等于让那次调用
        // 带着"我以为我指定了"的错觉跑下去。
        violations.push(
          new SchemaViolation({
            path: basePath === '' ? key : `${basePath}.${key}`,
            message: `不是这个工具的参数。可用参数：${[...allowed].join(' / ')}`,
            expected: [...allowed].join(' / '),
            received: describeValue(value[key]),
          }),
        )
      }
    }
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    const provided = value[key]
    // 没提供的可选参数不校验；必填缺失已在上面报过，不重复报。
    if (provided === undefined || provided === null || provided === '') continue
    validateValue(propertySchema, provided, basePath === '' ? key : `${basePath}.${key}`, violations)
  }
}

/**
 * 按对外公布的 schema 校验实参。
 *
 * @returns {SchemaViolation[]} 全部违规项（**不是**只报第一条）。一次把问题说全，
 *   模型就能一次改对；只报第一条会让它反复试，而每次重试都是一轮真实往返。
 */
export function validateAgainstSchema(schema, args) {
  const violations = []
  validateValue(schema, args ?? {}, '', violations)
  return violations
}

/**
 * 把违规项写成模型能照着改的文本。
 *
 * 刻意保留字段路径、期望值与实收值三样 —— 只说"参数错误"的话，模型只能瞎猜重试。
 */
export function formatSchemaViolations(toolName, violations) {
  const lines = [
    `❌ 参数不符合 ${toolName} 的入参定义，没有执行任何操作（平台上没有创建任何评审）。`,
    '',
    `共 ${violations.length} 处问题：`,
  ]
  for (const violation of violations) {
    lines.push(`  · ${violation.path}：${violation.message}`)
    if (violation.received !== null) lines.push(`      实际收到：${violation.received}`)
  }
  lines.push('')
  lines.push('请按上面的说明修正参数后重新调用。不要凭猜测重试同一组参数。')
  return lines.join('\n')
}
