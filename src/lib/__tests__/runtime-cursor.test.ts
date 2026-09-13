/**
 * 运行监控台游标模型的契约（V1.5 方案 §8.3 / §10.3）。
 *
 * 这些用例覆盖 §10.3 验收矩阵里不需要浏览器就能验证的部分：
 *   * 断网 30 秒恢复后无事件缺口、无重复 timeline（按 event_uuid 去重生效）；
 *   * `requires_full_snapshot` 时本地状态被正确重置；
 *   * 游标只推进到服务端给的 `next_event_id`，不取本地 max；
 *   * `watermark_lag_ms > 3000` 显示「确认延迟」，与「陈旧」「Worker 离线」是三个不同提示。
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_TIMELINE_EVENTS,
  RuntimePullCoordinator,
  computeRuntimeFreshness,
  mergeRuntimeEvents,
  mergeRuntimeTasks,
  planCursorStep,
} from '../runtime-cursor'
import type { RuntimeConsoleCursor, RuntimeEvent, RuntimeTaskSnapshot } from '../../types'

function event(id: number, uuid = `uuid-${String(id)}`): RuntimeEvent {
  return {
    event_id: id,
    event_uuid: uuid,
    batch_id: 'batch-1',
    job_id: 'job-1',
    task_id: 'task-1',
    agent_run_id: 'run-1',
    agent_node_id: 'node-1',
    worker_id: 'worker-1',
    scope: 'TOOL',
    event_type: 'TOOL_CALL_COMPLETED',
    activity_code: 'TOOL_RUNNING',
    phase: 'TERMINAL',
    status: 'COMPLETED',
    correlation_id: `corr-${String(id)}`,
    parent_correlation_id: null,
    error_code: null,
    duration_ms: 10,
    payload: { tool_name: 'bash' },
    occurred_at: '2026-01-01T00:00:00.000Z',
    received_at: '2026-01-01T00:00:00.100Z',
    clock_skewed: false,
  }
}

function task(code: string, id = `task-${code}`): RuntimeTaskSnapshot {
  return {
    task_id: id,
    story_id: `story-${code}`,
    story_code: code,
    story_name: `需求 ${code}`,
    project_name: null,
    application_name: null,
    agent_status: 'RUNNING',
    agent_attempt: 1,
    worker_id: 'worker-1',
    lease_expires_at: null,
    heartbeat_at: null,
    error_code: null,
    started_at: null,
    finished_at: null,
    last_event_at: null,
    attempts: [],
  }
}

function cursor(overrides: Partial<RuntimeConsoleCursor> = {}): RuntimeConsoleCursor {
  return {
    requested_after: null,
    next_event_id: null,
    has_more: false,
    requires_full_snapshot: false,
    server_time: '2026-01-01T00:00:00.000Z',
    watermark_lag_ms: 0,
    ...overrides,
  }
}

describe('mergeRuntimeEvents：断线补拉不留缺口也不重复', () => {
  it('按 event_uuid 去重，而不是按 event_id', () => {
    const previous = [event(1), event(2)]
    // 服务端把同一段区间重发了一遍（断网恢复后的典型情形）。
    const merged = mergeRuntimeEvents(previous, [event(2), event(3)])
    expect(merged.map((item) => item.event_id)).toEqual([1, 2, 3])
  })

  it('同一个 event_id 但不同 uuid 视为两条（服务端换了行，不是重复投递）', () => {
    const merged = mergeRuntimeEvents([event(5, 'uuid-a')], [event(5, 'uuid-b')])
    expect(merged).toHaveLength(2)
  })

  it('乱序到达也按 event_id 排好序：时间线契约是按 id 排序', () => {
    const merged = mergeRuntimeEvents([], [event(9), event(3), event(7)])
    expect(merged.map((item) => item.event_id)).toEqual([3, 7, 9])
  })

  it('模拟断网 30 秒后一次性补拉 40 条：既无缺口也无重复', () => {
    let state = [event(1), event(2), event(3)]
    // 补拉时服务端从 cursor=1 重新给，于是 2、3 会再来一遍。
    const backlog = Array.from({ length: 40 }, (_, index) => event(index + 2))
    state = mergeRuntimeEvents(state, backlog)
    const ids = state.map((item) => item.event_id)
    expect(ids).toEqual([...new Set(ids)])
    expect(ids).toHaveLength(41)
    for (let index = 1; index < ids.length; index += 1) {
      expect(ids[index]).toBe(ids[index - 1]! + 1)
    }
  })

  it('超过内存上限时保留最新的一段，不是最旧的一段', () => {
    const many = Array.from({ length: MAX_TIMELINE_EVENTS + 50 }, (_, index) => event(index + 1))
    const merged = mergeRuntimeEvents([], many)
    expect(merged).toHaveLength(MAX_TIMELINE_EVENTS)
    expect(merged[merged.length - 1]!.event_id).toBe(MAX_TIMELINE_EVENTS + 50)
  })

  it('空增量不制造新数组内容', () => {
    const previous = [event(1)]
    expect(mergeRuntimeEvents(previous, [])).toEqual(previous)
  })
})

describe('mergeRuntimeTasks：增量只覆盖受影响的 task', () => {
  it('增量模式下没有新事件的 task 不会从界面上消失', () => {
    const previous = [task('ST-001'), task('ST-002')]
    const merged = mergeRuntimeTasks(previous, [task('ST-002')], false)
    expect(merged.map((item) => item.story_code)).toEqual(['ST-001', 'ST-002'])
  })

  it('增量返回的投影覆盖同 id 的旧投影', () => {
    const previous = [{ ...task('ST-001'), agent_attempt: 1 }]
    const merged = mergeRuntimeTasks(previous, [{ ...task('ST-001'), agent_attempt: 3 }], false)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.agent_attempt).toBe(3)
  })

  it('全量模式整体替换：快照就是当前真相', () => {
    const previous = [task('ST-001'), task('ST-002')]
    const merged = mergeRuntimeTasks(previous, [task('ST-003')], true)
    expect(merged.map((item) => item.story_code)).toEqual(['ST-003'])
  })

  it('按 story code 稳定排序', () => {
    const merged = mergeRuntimeTasks([], [task('ST-003'), task('ST-001'), task('ST-002')], false)
    expect(merged.map((item) => item.story_code)).toEqual(['ST-001', 'ST-002', 'ST-003'])
  })
})

describe('planCursorStep：游标推进规则', () => {
  it('只推进到服务端给的 next_event_id', () => {
    const step = planCursorStep(cursor({ next_event_id: 42 }), 10, false)
    expect(step).toEqual({ action: 'idle', nextEventId: 42 })
  })

  it('服务端被长事务卡住时不回退游标', () => {
    // 水位裁剪让服务端这一轮只敢确认到 30，但我们已经应用过 42。
    const step = planCursorStep(cursor({ next_event_id: 30 }), 42, false)
    expect(step.nextEventId).toBe(42)
  })

  it('next_event_id 为 null 时保持原位，不猜一个值', () => {
    expect(planCursorStep(cursor(), 42, false).nextEventId).toBe(42)
    expect(planCursorStep(cursor(), null, false).nextEventId).toBeNull()
  })

  it('has_more 为真时要求立即继续补拉', () => {
    expect(planCursorStep(cursor({ next_event_id: 500, has_more: true }), 0, false).action).toBe(
      'continue',
    )
  })

  it('requires_full_snapshot 触发重置，并把游标清空', () => {
    const step = planCursorStep(cursor({ requires_full_snapshot: true }), 42, false)
    expect(step).toEqual({ action: 'reset', nextEventId: null })
  })

  it('已经在做全量快照时不再因 requires_full_snapshot 递归重置', () => {
    const step = planCursorStep(
      cursor({ requires_full_snapshot: true, next_event_id: 7 }),
      null,
      true,
    )
    expect(step.action).toBe('idle')
    expect(step.nextEventId).toBe(7)
  })
})

describe('computeRuntimeFreshness：五档分别展示，不合并', () => {
  const now = '2026-01-01T00:01:00.000Z'
  const at = (secondsAgo: number) =>
    new Date(Date.parse(now) - secondsAgo * 1000).toISOString()

  it('最近事件 5 秒内是实时', () => {
    expect(
      computeRuntimeFreshness({
        serverTime: now,
        lastEventAt: at(2),
        watermarkLagMs: 0,
        heartbeatAt: at(1),
        isRunning: true,
      }),
    ).toBe('LIVE')
  })

  it('5~15 秒是延迟（链路拥塞）', () => {
    expect(
      computeRuntimeFreshness({
        serverTime: now,
        lastEventAt: at(9),
        watermarkLagMs: 0,
        heartbeatAt: at(1),
        isRunning: true,
      }),
    ).toBe('DELAYED')
  })

  it('超过 15 秒且任务仍在运行才是陈旧', () => {
    expect(
      computeRuntimeFreshness({
        serverTime: now,
        lastEventAt: at(40),
        watermarkLagMs: 0,
        heartbeatAt: at(1),
        isRunning: true,
      }),
    ).toBe('STALE')
    // 任务已终态：40 秒没有事件是正常的，不该报警。
    expect(
      computeRuntimeFreshness({
        serverTime: now,
        lastEventAt: at(40),
        watermarkLagMs: 0,
        heartbeatAt: null,
        isRunning: false,
      }),
    ).toBe('DELAYED')
  })

  it('watermark_lag_ms > 3000 是「确认延迟」，与「陈旧」不是一回事', () => {
    const freshness = computeRuntimeFreshness({
      serverTime: now,
      // 事件本身很新，只是没过提交水位。
      lastEventAt: at(1),
      watermarkLagMs: 4200,
      heartbeatAt: at(1),
      isRunning: true,
    })
    expect(freshness).toBe('AWAITING_COMMIT')
  })

  it('Worker 心跳超过 20 秒优先报 Worker 离线：那是 Worker 侧问题', () => {
    const freshness = computeRuntimeFreshness({
      serverTime: now,
      lastEventAt: at(1),
      // 即使确认也延迟，也要先说清是 Worker 掉线 —— 两者的处理动作完全不同。
      watermarkLagMs: 9000,
      heartbeatAt: at(25),
      isRunning: true,
    })
    expect(freshness).toBe('WORKER_OFFLINE')
  })

  it('运行中但一条事件都还没有：算陈旧而不是实时', () => {
    expect(
      computeRuntimeFreshness({
        serverTime: now,
        lastEventAt: null,
        watermarkLagMs: 0,
        heartbeatAt: at(1),
        isRunning: true,
      }),
    ).toBe('STALE')
  })
})


describe('RuntimePullCoordinator：长补拉期间不丢完整快照', () => {
  it('运行中的 cursor 合并普通 cursor，但把 snapshot 排到完成后', () => {
    const coordinator = new RuntimePullCoordinator()
    expect(coordinator.request('cursor')).toBe('cursor')
    expect(coordinator.request('cursor')).toBeNull()
    expect(coordinator.request('snapshot')).toBeNull()
    expect(coordinator.complete()).toBe('snapshot')
    expect(coordinator.complete()).toBeNull()
  })

  it('多次手动刷新合并为一次快照，完成后可开始下一轮', () => {
    const coordinator = new RuntimePullCoordinator()
    expect(coordinator.request('snapshot')).toBe('snapshot')
    expect(coordinator.request('snapshot')).toBeNull()
    expect(coordinator.request('snapshot')).toBeNull()
    expect(coordinator.complete()).toBe('snapshot')
    expect(coordinator.complete()).toBeNull()
    expect(coordinator.request('cursor')).toBe('cursor')
  })
})

describe('computeRuntimeFreshness：非法时间戳保守降级', () => {
  it('非法 server_time 不会把运行中任务乐观显示为 LIVE', () => {
    expect(
      computeRuntimeFreshness({
        serverTime: 'not-a-time',
        lastEventAt: '2026-01-01T00:00:00.000Z',
        watermarkLagMs: 0,
        heartbeatAt: '2026-01-01T00:00:00.000Z',
        isRunning: true,
      }),
    ).toBe('STALE')
  })

  it('运行中任务的非法 heartbeat 按 Worker 离线处理', () => {
    expect(
      computeRuntimeFreshness({
        serverTime: '2026-01-01T00:01:00.000Z',
        lastEventAt: '2026-01-01T00:00:59.000Z',
        watermarkLagMs: 0,
        heartbeatAt: 'not-a-heartbeat',
        isRunning: true,
      }),
    ).toBe('WORKER_OFFLINE')
  })

  it('非法 last_event_at 不会被比较结果 NaN 误判为实时', () => {
    expect(
      computeRuntimeFreshness({
        serverTime: '2026-01-01T00:01:00.000Z',
        lastEventAt: 'not-an-event-time',
        watermarkLagMs: 0,
        heartbeatAt: null,
        isRunning: true,
      }),
    ).toBe('STALE')
  })
})
