import { describe, expect, it, vi } from 'vitest'
import {
  CROSS_BACKEND_TRANSCRIPT_MAX_CHARS,
  CROSS_BACKEND_TRANSCRIPT_MESSAGE_MAX_CHARS,
  CrossBackendTransactionController,
  buildCrossBackendTranscript,
  resolveCrossBackendLocation,
} from '../../../src/client/data/cross-backend-controller.ts'
import type {
  CrossBackendOperations,
  CrossBackendTicket,
  CrossBackendTranscriptLabels,
} from '../../../src/client/data/cross-backend-controller.ts'

const source = { provider: 'deepseek', model: 'deepseek-chat' }
const target = { provider: 'acp-codex', model: 'gpt-5.6-mini' }
const labels: CrossBackendTranscriptLabels = {
  header: 'HEADER',
  truncated: 'TRUNCATED',
  user: 'User',
  assistant: 'Assistant',
}

function ticket(): CrossBackendTicket {
  return {
    key: 'session-1\u0000acp-codex\u0000gpt-5.6-mini',
    sourceSessionId: 'session-1',
    sourceSelection: source,
    targetSelection: target,
    location: { workspaceId: 'workspace-1' },
  }
}

function operations(order: string[], overrides: Partial<CrossBackendOperations> = {}): CrossBackendOperations {
  return {
    restoreSource: vi.fn(async () => {
      order.push('restore')
      return { ok: true }
    }),
    createDestination: vi.fn(async ({ sessionId }) => {
      order.push(`create:${sessionId}`)
      return { published: true }
    }),
    selectDestination: vi.fn(async () => {
      order.push('select')
      return { ok: true }
    }),
    carryTranscript: vi.fn(async () => {
      order.push('carry')
      return { ok: true, messages: 2, truncated: false }
    }),
    openDestination: vi.fn(async () => {
      order.push('open')
      return { ok: true }
    }),
    ...overrides,
  }
}

function statesOf(controller: CrossBackendTransactionController): Map<string, unknown> {
  return (controller as unknown as { states: Map<string, unknown> }).states
}

describe('CrossBackendTransactionController', () => {
  it('resolves workspace before cwd, and falls back to cwd only when ungrouped', () => {
    expect(resolveCrossBackendLocation('s1', [{ workspaceId: 'w', sessionIds: ['s1'] }], '/tmp/project')).toEqual({
      workspaceId: 'w',
    })
    expect(resolveCrossBackendLocation('s1', [], '/tmp/project')).toEqual({ cwd: '/tmp/project' })
    expect(resolveCrossBackendLocation('s1', [], undefined)).toBeUndefined()
  })

  it('restores source before create/select/open; official destination select is last default mutation', async () => {
    const order: string[] = []
    const ops = operations(order)
    const result = await new CrossBackendTransactionController().confirm(ticket(), ops)
    expect(result.ok).toBe(true)
    expect(order).toEqual(['restore', expect.stringMatching(/^create:session-/), 'select', 'open'])
    // Default off: the text handoff is never requested and the result claims nothing.
    expect(ops.carryTranscript).not.toHaveBeenCalled()
    expect(result.ok ? result.transcript : undefined).toBeUndefined()
  })

  it('writes the opted-in transcript after destination selection and before opening it', async () => {
    const order: string[] = []
    const ops = operations(order)
    const result = await new CrossBackendTransactionController().confirm({ ...ticket(), carryTranscript: labels }, ops)
    expect(order).toEqual(['restore', expect.stringMatching(/^create:session-/), 'select', 'carry', 'open'])
    expect(ops.carryTranscript).toHaveBeenCalledWith({
      sourceSessionId: 'session-1',
      destinationSessionId: expect.stringMatching(/^session-/),
      labels,
    })
    expect(result).toEqual({
      ok: true,
      destinationSessionId: expect.any(String),
      transcript: { status: 'injected', messages: 2, truncated: false },
    })
  })

  it('keeps a failed transcript write retryable without repeating create/select', async () => {
    const order: string[] = []
    let carryAttempt = 0
    const ops = operations(order, {
      carryTranscript: vi.fn(async () => {
        carryAttempt += 1
        order.push('carry')
        return carryAttempt === 1 ? { ok: false, message: 'prompt rejected' } : { ok: true, messages: 1 }
      }),
    })
    const controller = new CrossBackendTransactionController()
    const optedIn = { ...ticket(), carryTranscript: labels }

    const first = await controller.confirm(optedIn, ops)
    expect(first).toEqual({
      ok: false,
      failure: {
        phase: 'carry-transcript',
        message: 'prompt rejected',
        destinationSessionId: expect.any(String),
      },
    })
    expect(ops.openDestination).not.toHaveBeenCalled()

    const second = await controller.confirm(optedIn, ops)
    expect(second.ok).toBe(true)
    expect(order).toEqual(['restore', expect.stringMatching(/^create:session-/), 'select', 'carry', 'carry', 'open'])
    expect(ops.createDestination).toHaveBeenCalledTimes(1)
    expect(ops.selectDestination).toHaveBeenCalledTimes(1)
  })

  it('reports an opted-in handoff that had nothing to carry instead of claiming success', async () => {
    const order: string[] = []
    const ops = operations(order, {
      carryTranscript: vi.fn(async () => ({ ok: true, skipped: 'empty-transcript' as const })),
    })
    const result = await new CrossBackendTransactionController().confirm({ ...ticket(), carryTranscript: labels }, ops)
    expect(result).toEqual({
      ok: true,
      destinationSessionId: expect.any(String),
      transcript: { status: 'skipped', reason: 'empty-transcript' },
    })
  })

  it('does not create a second destination when create/select/open fails and is retried', async () => {
    const order: string[] = []
    let createAttempt = 0
    let selectAttempt = 0
    let openAttempt = 0
    const ops = operations(order, {
      createDestination: vi.fn(async ({ sessionId }) => {
        createAttempt += 1
        order.push(`create:${sessionId}`)
        return { published: true }
      }),
      selectDestination: vi.fn(async () => {
        selectAttempt += 1
        order.push('select')
        return selectAttempt === 1 ? { ok: false, message: 'temporary select failure' } : { ok: true }
      }),
      openDestination: vi.fn(async () => {
        openAttempt += 1
        order.push('open')
        return openAttempt === 1 ? { ok: false, message: 'temporary open failure' } : { ok: true }
      }),
    })
    const controller = new CrossBackendTransactionController()
    const first = await controller.confirm(ticket(), ops)
    expect(first.ok).toBe(false)
    const firstId = first.ok ? '' : first.failure.destinationSessionId
    const second = await controller.confirm(ticket(), ops)
    expect(second.ok).toBe(false)
    const third = await controller.confirm(ticket(), ops)
    expect(third.ok).toBe(true)
    const fourth = await controller.confirm(ticket(), ops)
    expect(fourth.ok).toBe(true)
    expect(createAttempt).toBe(1)
    expect(selectAttempt).toBe(2)
    expect(openAttempt).toBe(2)
    expect(third.ok ? third.destinationSessionId : '').toBe(firstId)
    expect(fourth.ok ? fourth.destinationSessionId : '').toBe(firstId)
  })

  it('cancel only restores source and keeps destination untouched', async () => {
    const order: string[] = []
    const ops = operations(order)
    const result = await new CrossBackendTransactionController().cancel(ticket(), ops)
    expect(result.ok).toBe(true)
    expect(order).toEqual(['restore'])
    expect(ops.createDestination).not.toHaveBeenCalled()
  })

  it('keeps the decision movable and reports a warning when source restore fails', async () => {
    const order: string[] = []
    const ops = operations(order, {
      restoreSource: vi.fn(async () => ({ ok: false, message: 'restore rejected' })),
    })
    const result = await new CrossBackendTransactionController().confirm(ticket(), ops)
    // The source model may no longer be routable; creating the destination does
    // not depend on putting it back, so the decision must still complete.
    expect(result).toEqual({
      ok: true,
      destinationSessionId: expect.any(String),
      warning: { phase: 'restore-source', message: 'restore rejected', destinationSessionId: expect.any(String) },
    })
    expect(ops.createDestination).toHaveBeenCalled()
    expect(ops.openDestination).toHaveBeenCalled()
  })

  it('discards the decision and warns when cancel cannot restore the source', async () => {
    const order: string[] = []
    const tx = new CrossBackendTransactionController()
    const ops = operations(order, {
      restoreSource: vi.fn(async () => ({ ok: false, message: 'restore rejected' })),
    })
    const result = await tx.cancel(ticket(), ops)
    expect(result).toEqual({
      ok: true,
      destinationSessionId: '',
      warning: { phase: 'restore-source', message: 'restore rejected' },
    })
    expect(ops.createDestination).not.toHaveBeenCalled()
  })

  it('clears state when canceling a failed transaction with no source selection', async () => {
    const order: string[] = []
    const tx = new CrossBackendTransactionController()
    const noSourceTicket = { ...ticket(), sourceSelection: undefined }
    const ops = operations(order, {
      selectDestination: vi.fn(async () => {
        order.push('select')
        return { ok: false, message: 'temporary select failure' }
      }),
    })
    await tx.confirm(noSourceTicket, ops)
    expect(statesOf(tx).has(noSourceTicket.key)).toBe(true)

    await tx.cancel(noSourceTicket, ops)

    expect(statesOf(tx).has(noSourceTicket.key)).toBe(false)
    expect(order).toEqual([expect.stringMatching(/^create:session-/), 'select'])
  })
})

describe('buildCrossBackendTranscript', () => {
  it('keeps chronological order, marks the header, and counts the carried turns', () => {
    const built = buildCrossBackendTranscript(
      [
        { role: 'user', text: 'first question' },
        { role: 'assistant', text: 'first answer' },
        { role: 'user', text: 'second question' },
      ],
      labels,
    )
    expect(built).toEqual({
      text: ['HEADER', '', 'User: first question', 'Assistant: first answer', 'User: second question'].join('\n'),
      messages: 3,
      truncated: false,
    })
  })

  it('drops older turns at the character budget and says so', () => {
    const entries = [1, 2, 3, 4].map((index) => ({ role: 'user' as const, text: `${index}`.repeat(4_000) }))
    const built = buildCrossBackendTranscript(entries, labels)
    expect(built?.messages).toBe(3)
    expect(built?.truncated).toBe(true)
    // Newest three survive; the oldest is gone rather than half-included.
    expect(built?.text).not.toContain('User: 1111')
    expect(built?.text.endsWith(`\n\nTRUNCATED`)).toBe(true)
  })

  it('clips one oversized turn instead of dropping the newest content', () => {
    const built = buildCrossBackendTranscript(
      [{ role: 'user', text: 'x'.repeat(CROSS_BACKEND_TRANSCRIPT_MESSAGE_MAX_CHARS + 10) }],
      labels,
    )
    expect(built?.messages).toBe(1)
    expect(built?.truncated).toBe(false)
    expect(built?.text).toContain(`${'x'.repeat(CROSS_BACKEND_TRANSCRIPT_MESSAGE_MAX_CHARS)}…`)
    expect(built?.text.length).toBeLessThan(CROSS_BACKEND_TRANSCRIPT_MAX_CHARS)
  })

  it('marks older history that the loaded window never held', () => {
    const built = buildCrossBackendTranscript([{ role: 'user', text: 'tail' }], labels, true)
    expect(built?.truncated).toBe(true)
    expect(built?.text.endsWith('TRUNCATED')).toBe(true)
  })

  it('returns undefined when there is no text to carry', () => {
    expect(buildCrossBackendTranscript([], labels)).toBeUndefined()
    expect(buildCrossBackendTranscript([{ role: 'user', text: '   ' }], labels)).toBeUndefined()
  })
})
