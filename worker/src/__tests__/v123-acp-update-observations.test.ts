/**
 * V1.23：ACP `session/update` 的观测分发。
 *
 * 这条路径是产品问答能不能拿到答案的**唯一**出口。评审那条路的结论走
 * `submit_review_result` 工具经 Broker 落库，正文从不经过这里；而问答没有提交工具，
 * 回答就是 Agent 说的话本身。所以：
 *
 *   - 正文分片丢了 → 一次成功的问答在 Worker 侧只剩 `stopReason: 'end_turn'`，
 *     页面上是一个空答案，而没有任何错误码；
 *   - 工具参数丢了 → 证据里列不出"AI 读过哪些文件"，答案变得无法核对。
 *
 * 两者都不会让任何测试失败、也不会打日志，所以必须在这里钉住。
 */

import { describe, expect, it, vi } from 'vitest'

import { dispatchUpdateObservations, readTextContent } from '../ai/acp/acp-client.js'

describe('readTextContent', () => {
  it('取出标准的 { type: text } 形状', () => {
    expect(readTextContent({ type: 'text', text: '你好' })).toBe('你好')
  })

  it('裸字符串直接返回', () => {
    expect(readTextContent('你好')).toBe('你好')
  })

  it('数组形状拼接（有些实现把 content 包成数组）', () => {
    expect(
      readTextContent([
        { type: 'text', text: '前半' },
        { type: 'text', text: '后半' },
      ]),
    ).toBe('前半后半')
  })

  it('认不出的形状返回 null 而不是抛错（新增 update 类型不该让 turn 失败）', () => {
    expect(readTextContent(null)).toBeNull()
    expect(readTextContent(undefined)).toBeNull()
    expect(readTextContent({ type: 'image', data: 'xx' })).toBeNull()
    expect(readTextContent(42)).toBeNull()
  })

  it('数组里一个都认不出时返回 null', () => {
    expect(readTextContent([{ type: 'image' }, { nope: true }])).toBeNull()
  })
})

describe('dispatchUpdateObservations', () => {
  it('agent_message_chunk 的正文交给 onAgentMessageChunk', () => {
    const onAgentMessageChunk = vi.fn()
    dispatchUpdateObservations(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '转派会关闭待办' } },
      { onAgentMessageChunk },
      { toolNames: [] },
    )
    expect(onAgentMessageChunk).toHaveBeenCalledWith('转派会关闭待办')
  })

  it('空正文不回调（避免把空串拼进答案）', () => {
    const onAgentMessageChunk = vi.fn()
    dispatchUpdateObservations(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } },
      { onAgentMessageChunk },
      { toolNames: [] },
    )
    expect(onAgentMessageChunk).not.toHaveBeenCalled()
  })

  it('tool_call 同时触发 onToolCall 与 onToolCallDetail，并带上入参', () => {
    const onToolCall = vi.fn()
    const onToolCallDetail = vi.fn()
    const collected = { toolNames: [] as string[] }
    dispatchUpdateObservations(
      {
        sessionUpdate: 'tool_call',
        toolName: 'read_snapshot_code',
        rawInput: { path: 'src/task/Transfer.java' },
      },
      { onToolCall, onToolCallDetail },
      collected,
    )
    expect(onToolCall).toHaveBeenCalledWith('read_snapshot_code')
    expect(onToolCallDetail).toHaveBeenCalledWith({
      toolName: 'read_snapshot_code',
      rawInput: { path: 'src/task/Transfer.java' },
    })
    expect(collected.toolNames).toEqual(['read_snapshot_code'])
  })

  it('没有 toolName 时回退到 title（V3/V4 的字段差异）', () => {
    const onToolCall = vi.fn()
    dispatchUpdateObservations(
      { sessionUpdate: 'tool_call', title: 'grep' },
      { onToolCall },
      { toolNames: [] },
    )
    expect(onToolCall).toHaveBeenCalledWith('grep')
  })

  it('没有入参时 rawInput 不出现在 detail 里（而不是 undefined 键）', () => {
    const onToolCallDetail = vi.fn()
    dispatchUpdateObservations(
      { sessionUpdate: 'tool_call', toolName: 'glob' },
      { onToolCallDetail },
      { toolNames: [] },
    )
    expect(onToolCallDetail).toHaveBeenCalledWith({ toolName: 'glob' })
  })

  it('同一工具重复调用只在 toolNames 里出现一次，但每次都回调', () => {
    const onToolCall = vi.fn()
    const collected = { toolNames: [] as string[] }
    for (let i = 0; i < 3; i++) {
      dispatchUpdateObservations(
        { sessionUpdate: 'tool_call', toolName: 'grep' },
        { onToolCall },
        collected,
      )
    }
    expect(collected.toolNames).toEqual(['grep'])
    expect(onToolCall).toHaveBeenCalledTimes(3)
  })

  it('观测回调抛出的异常不影响 turn（fail open）', () => {
    const boom = () => {
      throw new Error('observer exploded')
    }
    expect(() =>
      dispatchUpdateObservations(
        { sessionUpdate: 'tool_call', toolName: 'read' },
        { onToolCall: boom },
        { toolNames: [] },
      ),
    ).not.toThrow()
    expect(() =>
      dispatchUpdateObservations(
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
        { onAgentMessageChunk: boom },
        { toolNames: [] },
      ),
    ).not.toThrow()
  })

  it('回调抛错之后仍然把工具名记进 toolNames', () => {
    const collected = { toolNames: [] as string[] }
    dispatchUpdateObservations(
      { sessionUpdate: 'tool_call', toolName: 'read' },
      {
        onToolCall: () => {
          throw new Error('nope')
        },
      },
      collected,
    )
    expect(collected.toolNames).toEqual(['read'])
  })

  it('未知的 update 类型被静默忽略', () => {
    const onToolCall = vi.fn()
    const onAgentMessageChunk = vi.fn()
    expect(() =>
      dispatchUpdateObservations(
        { sessionUpdate: 'some_future_kind', content: { type: 'text', text: 'x' } },
        { onToolCall, onAgentMessageChunk },
        { toolNames: [] },
      ),
    ).not.toThrow()
    expect(onToolCall).not.toHaveBeenCalled()
    expect(onAgentMessageChunk).not.toHaveBeenCalled()
  })

  it('没有注册回调时也不炸（评审那条路不传这两个回调）', () => {
    expect(() =>
      dispatchUpdateObservations(
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
        {},
        { toolNames: [] },
      ),
    ).not.toThrow()
  })
})
