/**
 * `SKILL.md` YAML frontmatter 的准入校验。
 *
 * 这一层存在的理由是一次真实的静默失败：**dsh 的 `skill-filesystem` 要求 `SKILL.md` 带
 * YAML frontmatter，且其中必须有非空的 `name` 与 `description`。缺了它，
 * `parseSkillFile` 只写一行 `logger.warn` 就 `return` —— 技能对模型等于不存在。**
 *
 * 那个失败形态是最难诊断的一种：
 *
 *   * Bundle 发布成功、Job 冻结成功、Worker 下载校验物化全部成功；
 *   * `<DSH_HOME>/skills/<name>/SKILL.md` 确实躺在磁盘上；
 *   * 模型的首轮目录里就是没有这个技能，而平台侧没有任何错误码。
 *
 * 所以校验必须发生在**发布**时，而不是运行时。这里刻意只接受一个**很窄的 YAML 子集**
 * （`key: value` 平铺标量），理由是安全方向：我们接受的集合必须是 dsh 接受集合的子集。
 * 用一个"尽量宽容"的自制解析器反而会放过 dsh 会拒的东西，把问题推回运行时。
 */

/** dsh 的 `isSkillName`（`@deepseek-ai/dsh-skill`）等价形式。 */
const DSH_SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** dsh 明确拒绝的旧式驼峰键。它抛错，于是整个技能被忽略。 */
const LEGACY_INVOCATION_KEYS = ['disableModelInvocation', 'modelInvocable', 'userInvocable'] as const

const FRONTMATTER_LINE = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/

export interface SkillEntryFrontmatter {
  name: string
  description: string
  whenToUse?: string
}

export class SkillFrontmatterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillFrontmatterError'
  }
}

function fail(message: string): never {
  throw new SkillFrontmatterError(message)
}

function unquote(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

/**
 * 解析并校验入口文件的 frontmatter。
 *
 * `expectedName` 是平台侧的技能名（也就是 `<DSH_HOME>/skills/<name>/` 的目录名）。要求
 * frontmatter 的 `name` 与它**完全相等**，这一条比 dsh 自己更严：dsh 只要求 `name` 形如
 * 合法技能名，于是一个目录叫 `a`、frontmatter 写 `b` 的 Bundle 会被注册成 `b`。那意味着
 * 冻结目录里的身份（`a`）与模型看到的名字（`b`）分叉 —— catalog hash、审计归因、
 * `skill(name)` 调用全部对不上。
 */
export function parseSkillEntryFrontmatter(
  text: string,
  expectedName: string,
): SkillEntryFrontmatter {
  const firstLineEnd = text.indexOf('\n')
  if (firstLineEnd < 0) {
    fail('SKILL.md must open with a YAML frontmatter block delimited by "---"')
  }
  if (text.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') {
    fail('SKILL.md must start with "---" on its very first line')
  }

  const lines = text.slice(firstLineEnd + 1).split('\n')
  const fields = new Map<string, string>()
  let closed = false
  let bodyStart = lines.length
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.replace(/\r$/, '')
    if (line === '---') {
      closed = true
      bodyStart = index + 1
      break
    }
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (/^[ \t]/.test(line)) {
      // 缩进意味着嵌套结构（列表、映射、块标量）。dsh 能解析它们，但平台不需要，
      // 而"能解析"和"我们知道它意味着什么"是两件事。窄进宽出在这里是反的：必须窄进。
      fail('SKILL.md frontmatter only accepts flat "key: value" fields')
    }
    const match = FRONTMATTER_LINE.exec(line)
    if (match === null) {
      fail('SKILL.md frontmatter contains a line that is not "key: value"')
    }
    const key = match[1]!
    if (fields.has(key)) {
      fail(`SKILL.md frontmatter repeats the field "${key}"`)
    }
    fields.set(key, unquote(match[2]!))
  }
  if (!closed) {
    fail('SKILL.md frontmatter is not closed by a "---" line')
  }
  if (lines.slice(bodyStart).join('\n').trim() === '') {
    // 只有 frontmatter、没有正文的技能对模型毫无用处：`skill(name)` 会返回一个空 body。
    fail('SKILL.md has no content after its frontmatter')
  }

  for (const legacy of LEGACY_INVOCATION_KEYS) {
    if (fields.has(legacy)) {
      // dsh 对这些键**抛错**，于是整个技能被静默忽略。
      fail(`SKILL.md frontmatter field "${legacy}" is unsupported by dsh`)
    }
  }

  const name = fields.get('name') ?? ''
  const description = fields.get('description') ?? ''
  if (name === '' || description === '') {
    fail('SKILL.md frontmatter requires a non-empty name and description')
  }
  if (!DSH_SKILL_NAME.test(name)) {
    fail('SKILL.md frontmatter name is not a valid dsh skill name')
  }
  if (name !== expectedName) {
    fail(
      'SKILL.md frontmatter name must equal the platform skill name; ' +
        'a mismatch would register the skill under a different name than the frozen catalog',
    )
  }

  const disableModelInvocation = fields.get('disable-model-invocation')
  if (disableModelInvocation !== undefined) {
    const normalized = disableModelInvocation.toLowerCase()
    if (!['true', 'false', 'yes', 'no', 'on', 'off', '0', '1'].includes(normalized)) {
      fail('SKILL.md frontmatter field "disable-model-invocation" must be a boolean')
    }
    if (['true', 'yes', 'on', '1'].includes(normalized)) {
      // 这个平台唯一的技能消费者就是模型。禁用模型调用等于发布一个永远不会被用到的包，
      // 而且它仍然占着首轮目录预算。
      fail('a bundle with "disable-model-invocation: true" can never be used by this platform')
    }
  }
  const userInvocable = fields.get('user-invocable')
  if (userInvocable !== undefined) {
    const normalized = userInvocable.toLowerCase()
    if (!['true', 'false', 'yes', 'no', 'on', 'off', '0', '1'].includes(normalized)) {
      fail('SKILL.md frontmatter field "user-invocable" must be a boolean')
    }
  }

  const whenToUse = fields.get('whenToUse')
  return {
    name,
    description,
    ...(whenToUse !== undefined && whenToUse !== '' ? { whenToUse } : {}),
  }
}
