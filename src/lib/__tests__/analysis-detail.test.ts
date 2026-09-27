import { describe, expect, it } from 'vitest'

import { displayStructuredAnalysisDetailItem, parseAnalysisDetail } from '../analysis-detail'

describe('parseAnalysisDetail', () => {
  it('按项目符号和编号形成可扫描要点，并保留标签正文', () => {
    expect(parseAnalysisDetail('1. 已实现：订单创建接口\n- 缺失：退款处理\n• 风险：并发库存扣减')).toEqual([
      {
        kind: 'list',
        items: [
          { label: '已实现', content: '订单创建接口' },
          { label: '缺失', content: '退款处理' },
          { label: '风险', content: '并发库存扣减' },
        ],
      },
    ])
  })

  it('将历史单段长文按完整中文句子和分号拆为要点，不按逗号拆分', () => {
    expect(parseAnalysisDetail('创建接口已实现，包含参数校验。退款流程尚未发现；建议覆盖并发下单。')).toEqual([
      {
        kind: 'list',
        items: [
          { label: null, content: '创建接口已实现，包含参数校验。' },
          { label: null, content: '退款流程尚未发现；' },
          { label: null, content: '建议覆盖并发下单。' },
        ],
      },
    ])
  })

  it('保留空行分隔的段落，并将多行人工文本展示为要点', () => {
    expect(parseAnalysisDetail('结论：主流程可用\n边界：缺少异常回滚\n\n请在上线前补充集成测试。')).toEqual([
      {
        kind: 'list',
        items: [
          { label: '结论', content: '主流程可用' },
          { label: '边界', content: '缺少异常回滚' },
        ],
      },
      { kind: 'paragraph', content: '请在上线前补充集成测试。' },
    ])
  })

  it('不把 URL 与路径识别成标签，无法分割时保留完整原文', () => {
    expect(parseAnalysisDetail('见 https://example.com/a:b 和 src/a:b.ts 的现有实现')).toEqual([
      { kind: 'paragraph', content: '见 https://example.com/a:b 和 src/a:b.ts 的现有实现' },
    ])
  })

  it('空白输入返回空结构', () => {
    expect(parseAnalysisDetail(' \r\n\t ')).toEqual([])
  })

  it('removes screenshot-style parenthesized numbering and ideographic indentation', () => {
    expect(parseAnalysisDetail('1) 鉴权方式下拉不出现 AK/SK；\n　　鉴权方式保持原值可保存；')).toEqual([
      {
        kind: 'list',
        items: [
          { label: null, content: '鉴权方式下拉不出现 AK/SK；' },
          { label: null, content: '鉴权方式保持原值可保存；' },
        ],
      },
    ])
  })

  it('keeps structured items as a single item while defensively stripping list decoration', () => {
    expect(displayStructuredAnalysisDetailItem('1) 订单创建已实现；退款仍缺失。')).toBe('订单创建已实现；退款仍缺失。')
  })
})
