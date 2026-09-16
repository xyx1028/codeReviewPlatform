import { describe, expect, it } from 'vitest'
import type { RuntimeAttemptSnapshot, RuntimeEvent } from '../../types'
import {
  buildRuntimeTaskEventPage,
  buildRuntimeTimelineGroups,
  compactRuntimeEvents,
  eventsForRuntimeTask,
} from '../runtime-timeline'

function event(
  id: number,
  overrides: Partial<RuntimeEvent> = {},
): RuntimeEvent {
  return {
    event_id: id,
    event_uuid: `event-${id}`,
    batch_id: 'batch-1',
    job_id: 'job-1',
    task_id: 'task-1',
    agent_run_id: 'run-1',
    agent_node_id: 'node-1',
    worker_id: 'worker-1',
    scope: 'ATTEMPT',
    event_type: 'ATTEMPT_STARTED',
    activity_code: 'ATTEMPT_STARTING',
    phase: null,
    status: null,
    correlation_id: null,
    parent_correlation_id: null,
    error_code: null,
    duration_ms: null,
    payload: {},
    occurred_at: `2026-09-13T08:00:${String(id).padStart(2, '0')}.000Z`,
    received_at: `2026-09-13T08:00:${String(id).padStart(2, '0')}.100Z`,
    clock_skewed: false,
    ...overrides,
  }
}

function attempt(
  agentAttempt: number,
  agentRunId = `run-${agentAttempt}`,
): RuntimeAttemptSnapshot {
  return {
    agent_run_id: agentRunId,
    agent_attempt: agentAttempt,
    status: 'COMMITTED',
    worker_id: 'worker-1',
    model_label: 'model',
    error_code: null,
    started_at: '2026-09-13T08:00:00.000Z',
    committed_at: '2026-09-13T08:00:10.000Z',
    finished_at: '2026-09-13T08:00:10.000Z',
    cancel_requested_at: null,
    cancel_reason: null,
    sealed_at: '2026-09-13T08:00:10.000Z',
    session_revision: 1,
    attempt_phase_code: null,
    attempt_phase_started_at: null,
    agent_count: 1,
    max_depth_reached: 0,
    model_requests: 1,
    tool_calls: 1,
    input_tokens: null,
    output_tokens: null,
    resume_count: 0,
    agents: [],
  }
}

describe('runtime timeline task isolation', () => {
  it('never mixes events from other tasks or job-level events into the selected task', () => {
    const events = [
      event(1),
      event(2, { task_id: 'task-2', agent_run_id: 'run-2' }),
      event(3, { task_id: null, agent_run_id: null, scope: 'JOB' }),
    ]

    expect(eventsForRuntimeTask(events, 'task-1').map((item) => item.event_id)).toEqual([1])
    expect(eventsForRuntimeTask(events, null)).toEqual([])
  })

  it('keeps task anchors on every history page and only merges live attempt facts on page one', () => {
    const history = [event(10)]
    const live = [
      event(10),
      event(11),
      event(12, {
        agent_run_id: 'run-1',
        scope: 'TASK',
        event_type: 'TASK_REPOSITORIES_READY',
      }),
      event(13, { task_id: 'task-2' }),
    ]

    expect(
      buildRuntimeTaskEventPage(history, live, 'task-1', true).map((item) => item.event_id),
    ).toEqual([10, 11, 12])
    expect(
      buildRuntimeTaskEventPage(history, live, 'task-1', false).map((item) => item.event_id),
    ).toEqual([10, 12])
  })
})

describe('runtime timeline compact mode', () => {
  it('orders by occurrence time when database ids arrive out of order', () => {
    const events = [
      event(11, {
        event_type: 'AGENT_FINISHED',
        occurred_at: '2026-09-13T08:02:35.000Z',
      }),
      event(10, {
        event_type: 'ATTEMPT_COMMITTED',
        occurred_at: '2026-09-13T08:02:37.000Z',
      }),
    ]
    const compacted = compactRuntimeEvents(events)
    const full = buildRuntimeTimelineGroups(events, [attempt(1, 'run-1')], false)[0]

    expect(compacted.map((item) => item.representative.event_type)).toEqual([
      'ATTEMPT_COMMITTED',
      'AGENT_FINISHED',
    ])
    expect(full?.clusters.map((item) => item.representative.event_type)).toEqual([
      'ATTEMPT_COMMITTED',
      'AGENT_FINISHED',
    ])
  })

  it('hides a closed STARTED pair but keeps an actually open STARTED event', () => {
    const compacted = compactRuntimeEvents([
      event(1, {
        scope: 'MODEL',
        event_type: 'MODEL_REQUEST_STARTED',
        phase: 'STARTED',
        correlation_id: 'closed',
      }),
      event(2, {
        scope: 'MODEL',
        event_type: 'MODEL_REQUEST_COMPLETED',
        phase: 'TERMINAL',
        correlation_id: 'closed',
      }),
      event(3, {
        scope: 'TOOL',
        event_type: 'TOOL_CALL_STARTED',
        phase: 'STARTED',
        correlation_id: 'open',
        payload: { tool_name: 'bash' },
      }),
    ])

    expect(compacted.flatMap((item) => item.events).map((item) => item.event_id)).toEqual([3, 2])
  })

  it('merges consecutive identical tool terminals and condenses setup steps', () => {
    const compacted = compactRuntimeEvents([
      event(1, { event_type: 'RUNTIME_CONTRACT_VERIFIED' }),
      event(2, { event_type: 'WORKSPACE_READY' }),
      event(3, {
        scope: 'TOOL',
        event_type: 'TOOL_CALL_COMPLETED',
        phase: 'TERMINAL',
        correlation_id: 'tool-1',
        duration_ms: 4,
        payload: { tool_name: 'search_snapshot_code' },
      }),
      event(4, {
        scope: 'TOOL',
        event_type: 'TOOL_CALL_COMPLETED',
        phase: 'TERMINAL',
        correlation_id: 'tool-2',
        duration_ms: 6,
        payload: { tool_name: 'search_snapshot_code' },
      }),
    ])

    expect(compacted).toHaveLength(2)
    expect(compacted[0]).toMatchObject({ kind: 'event', count: 2, totalDurationMs: 10 })
    expect(compacted[1]).toMatchObject({ kind: 'setup', count: 2 })
  })
})

describe('runtime timeline attempt grouping', () => {
  it('groups runs independently, puts the newest attempt first and keeps task facts separate', () => {
    const groups = buildRuntimeTimelineGroups(
      [
        event(1, { agent_run_id: 'run-1' }),
        event(2, { agent_run_id: 'run-2' }),
        event(3, {
          agent_run_id: 'run-2',
          scope: 'TASK',
          event_type: 'TASK_REPOSITORIES_READY',
        }),
      ],
      [attempt(1), attempt(2)],
      false,
    )

    expect(groups.map((group) => group.key)).toEqual(['run-2', 'run-1', 'task'])
    expect(groups[0]?.attempt?.agent_attempt).toBe(2)
    expect(groups[0]?.events.map((item) => item.event_id)).toEqual([2])
    expect(groups[2]?.attempt).toBeNull()
    expect(groups[2]?.events.map((item) => item.event_id)).toEqual([3])
  })
})
