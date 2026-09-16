import { describe, expect, it } from 'vitest'
import { detectHeaderRowIndex, inferFieldMapping, parseSourceRows } from '../excel'

/** 旧格式：单表头，列名带「用户故事」「所属」前缀，人员只有一列「负责人」。 */
const legacyHeaders = [
  '序号', '关联用例', '用户故事编码', '用户故事名称', '用户故事标签', '立项状态', '迭代阶段',
  '迭代目标', '发布计划', '发布窗口', '负责人', '状态', '计划人天', 'AI辅助计划人天', '实际人天',
  '优先级', '绝对优先级', 'Scrum团队', '产品组', '所属项目', 'KSM或BUG编号', '计划开始时间',
  '计划结束时间', '类型', '所属云', '所属应用', '关联需求', '关联缺陷', '关联故事', '修改时间',
]

/** 新格式第 1 行：字段码。 */
const newFieldCodeRow = [
  'gf_name', 'gf_number', 'status', 'phase', 'current_step', 'assignee_id', 'tf_req_handlers',
  'tf_team', 'tf_startendtime', 'tf_dev_handlers', 'tf_test_handlers', 'gf_description',
  'gf_creator', 'gf_priority', 'gf_createtime', 'tf_subject', 'tf_iteration', 'tf_release_window',
]

/** 新格式第 2 行：中文列名。四个人员列并存，没有任何应用列。 */
const newHeaders = [
  '名称', '编码', '状态', '阶段', '步骤', '处理人', '需求人员', 'Scrum团队',
  '计划开始完成时间区间', '开发人员', '测试人员', '详细描述', '创建人', '优先级', '创建时间',
  '关联特性', '迭代阶段', '发布窗口',
]

describe('detectHeaderRowIndex', () => {
  it('新格式的字段码行被跳过，表头取第二行', () => {
    const rows = [newFieldCodeRow, newHeaders, ['需求A', 'US-2026-010446']]
    expect(detectHeaderRowIndex(rows)).toBe(1)
  })

  it('旧格式单表头不受影响', () => {
    const rows = [legacyHeaders, ['1', '', 'PRJ-00776253', '需求A']]
    expect(detectHeaderRowIndex(rows)).toBe(0)
  })

  it('表头本身是英文标识符时不能误判成字段码行', () => {
    // 第二行没有中文，说明第一行就是真表头，不是「字段码 + 中文名」的双表头。
    const rows = [['story_code', 'story_name', 'owners'], ['US-1', 'name', 'a,b']]
    expect(detectHeaderRowIndex(rows)).toBe(0)
  })

  it('只有一行时不做跳过', () => {
    expect(detectHeaderRowIndex([newFieldCodeRow])).toBe(0)
  })
})

describe('inferFieldMapping', () => {
  it('旧格式命中它有的字段，需求人员和测试人员留空', () => {
    const mapping = inferFieldMapping(legacyHeaders)
    expect(mapping).toEqual({
      story_code: '用户故事编码',
      story_name: '用户故事名称',
      owners_text: '负责人',
      project_name: '所属项目',
      cloud_name: '所属云',
      iteration_name: '迭代阶段',
      release_window: '发布窗口',
      source_status: '状态',
    })
    // 旧格式没有这两列；「所属应用」这一列现在已经不再是任何实体字段的来源。
    expect(mapping.requirement_handlers).toBeUndefined()
    expect(mapping.test_handlers).toBeUndefined()
  })

  it('新格式的四个人员列各归各位', () => {
    const mapping = inferFieldMapping(newHeaders)
    expect(mapping).toEqual({
      story_code: '编码',
      story_name: '名称',
      owners_text: '开发人员',
      requirement_handlers: '需求人员',
      test_handlers: '测试人员',
      project_name: '关联特性',
      iteration_name: '迭代阶段',
      release_window: '发布窗口',
      source_status: '状态',
    })
  })

  it('「处理人」不被任何字段认领', () => {
    // 处理人是当前流程节点的处理人，会随流程流转而变，不能当成稳定的人员归属。
    for (const header of ['处理人', '创建人', '修改人']) {
      expect(inferFieldMapping([header])).toEqual({})
    }
  })

  it('两代列名同时存在时优先认更精确的旧列名', () => {
    const mapping = inferFieldMapping(['名称', '编码', '用户故事编码', '用户故事名称', '开发人员', '负责人'])
    expect(mapping.story_code).toBe('用户故事编码')
    expect(mapping.story_name).toBe('用户故事名称')
    expect(mapping.owners_text).toBe('负责人')
  })

  it('只导出了字段码行时按字段码兜底', () => {
    const mapping = inferFieldMapping(newFieldCodeRow)
    expect(mapping.story_code).toBe('gf_number')
    expect(mapping.story_name).toBe('gf_name')
    expect(mapping.owners_text).toBe('tf_dev_handlers')
    expect(mapping.requirement_handlers).toBe('tf_req_handlers')
    expect(mapping.test_handlers).toBe('tf_test_handlers')
  })
})

describe('parseSourceRows', () => {
  const mapping = inferFieldMapping(newHeaders)
  const row = {
    名称: 'console侧skill提交时第三方工具校验',
    编码: 'US-2026-010446',
    状态: '提测完成',
    处理人: '何翘楚（61700）',
    需求人员: '何翘楚（61700）',
    开发人员: '古今（49086）',
    测试人员: '董驰（62413）',
    关联特性: 'Build开发测试 一体化服务（FT-2026-001543）',
    迭代阶段: '202609-3（0914-0918）',
    发布窗口: 'R20260918',
  }

  it('开发人员 / 需求人员 / 测试人员各自落到独立字段', () => {
    const { stories, issues } = parseSourceRows([row], mapping, 3)
    expect(stories).toHaveLength(1)
    expect(stories[0]).toMatchObject({
      story_code: 'US-2026-010446',
      story_name: 'console侧skill提交时第三方工具校验',
      owners_text: '古今（49086）',
      requirement_handlers: '何翘楚（61700）',
      test_handlers: '董驰（62413）',
      project_name: 'Build开发测试 一体化服务（FT-2026-001543）',
      cloud_name: null,
      iteration_name: '202609-3（0914-0918）',
      release_window: 'R20260918',
      source_status: '提测完成',
    })
    expect(issues.filter((issue) => issue.level === 'error')).toEqual([])
  })

  it('实体字段与 Excel 列同名时不重复说列名', () => {
    // 新格式下「开发人员」字段正好映射到同名的「开发人员」列，不该啰嗦成「开发人员（对应列「开发人员」）」。
    const { issues } = parseSourceRows([{ ...row, 关联特性: '', 开发人员: '' }], mapping, 3)
    expect(issues).toContainEqual({ level: 'warning', row: 3, message: '开发人员为空' })
    // 「所属项目」映射到的是「关联特性」列，必须点出来，否则用户回去翻文件找不到。
    expect(issues).toContainEqual({ level: 'warning', row: 3, message: '所属项目（对应列「关联特性」）为空' })
    expect(issues.some((issue) => issue.message.includes('应用'))).toBe(false)
  })

  it('旧格式里开发人员映射自「负责人」列，提示会点出列名', () => {
    const legacyMapping = inferFieldMapping(legacyHeaders)
    const { issues } = parseSourceRows([{ 用户故事编码: 'PRJ-1', 用户故事名称: 'n', 负责人: '' }], legacyMapping)
    expect(issues).toContainEqual({ level: 'warning', row: 2, message: '开发人员（对应列「负责人」）为空' })
    expect(issues).toContainEqual({ level: 'warning', row: 2, message: '所属项目为空' })
  })

  it('字段完全没映射时提示说清楚是未映射', () => {
    const { issues } = parseSourceRows([{ 名称: 'n', 编码: 'US-1' }], { story_code: '编码', story_name: '名称' }, 3)
    expect(issues).toContainEqual({ level: 'warning', row: 3, message: '开发人员（未映射任何 Excel 列）为空' })
    expect(issues).toContainEqual({ level: 'warning', row: 3, message: '所属项目（未映射任何 Excel 列）为空' })
  })

  it('行号按第一条数据的真实 Excel 行号起算', () => {
    const { issues } = parseSourceRows([{ ...row, 编码: '' }], mapping, 3)
    expect(issues).toContainEqual({ level: 'error', row: 3, message: '用户故事编码（对应列「编码」）为空' })
  })

  it('单表头文件的行号仍从第 2 行起算', () => {
    const { issues } = parseSourceRows([{ ...row, 编码: '' }], mapping)
    expect(issues).toContainEqual({ level: 'error', row: 2, message: '用户故事编码（对应列「编码」）为空' })
  })

  it('旧格式导入的需求，需求人员和测试人员为 null', () => {
    const legacyMapping = inferFieldMapping(legacyHeaders)
    const { stories } = parseSourceRows([{
      用户故事编码: 'PRJ-00776253',
      用户故事名称: '智能体的中文描述保持500字符控制',
      负责人: '张烨,向俊杰,尹昱杰',
      所属项目: '灵基AIOS项目',
      所属云: '平台公共',
      所属应用: '智能体',
    }], legacyMapping)
    expect(stories[0]).toMatchObject({
      owners_text: '张烨,向俊杰,尹昱杰',
      requirement_handlers: null,
      test_handlers: null,
      project_name: '灵基AIOS项目',
      cloud_name: '平台公共',
    })
    // 「所属应用」的值仍然留在 source_data 里，只是不再落到任何实体字段。
    expect(stories[0].source_data['所属应用']).toBe('智能体')
  })
})
