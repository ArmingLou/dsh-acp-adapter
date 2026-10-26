import { describe, expect, it, vi } from 'vitest'
import {
  CrossBackendCoordinator,
  shouldConfirmBackendTransition,
} from '../../../src/client/coordinator/cross-backend-coordinator.ts'

type Selection = { provider: string; model: string; reasoningEffort?: string }
const owns = (provider: string | undefined): boolean => provider?.startsWith('acp-') === true
const transcriptLabels = {
  header: 'CARRIED TRANSCRIPT HEADER',
  truncated: 'EARLIER HISTORY TRUNCATED',
  user: 'User',
  assistant: 'Assistant',
}
const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

function observable<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(next: T) {
      value = next
      for (const listener of listeners) listener()
    },
  }
}

function fixture(
  options: {
    sessionId?: string
    row?: { blank: boolean; cwd?: string | null }
    projection?: { lastUsed: Selection | null; next: Selection | null }
  } = {},
) {
  const sessionId = options.sessionId ?? 'session-1'
  const order: string[] = []
  const projection = observable(
    options.projection ?? {
      lastUsed: { provider: 'native', model: 'model-a' },
      next: { provider: 'native', model: 'model-a' },
    },
  )
  const list = observable({
    byId: {
      [sessionId]: {
        id: sessionId,
        blank: options.row?.blank ?? false,
        cwd: options.row?.cwd === null ? undefined : (options.row?.cwd ?? '/tmp'),
      },
    },
  })
  const transcript = observable<{ entries: readonly unknown[]; hasMore: boolean }>({ entries: [], hasMore: false })
  const prompt = vi.fn(
    async (
      _content: readonly { type: string; text: string }[],
      _mode: 'queue' | 'steer',
    ): Promise<{ ok: boolean; error?: { message: string } }> => {
      order.push('prompt')
      return { ok: true }
    },
  )
  const destination = { blank: true }
  const bindingFor = (
    modelProjection: unknown,
    events: {
      getSnapshot: () => { entries: readonly unknown[]; hasMore: boolean }
      subscribe: (listener: () => void) => () => void
    } = transcript,
    blank = false,
  ) => ({
    eventSource: events,
    session: {
      projections: { faceOf: () => modelProjection },
      prompt,
      getSnapshot: () => ({ blank, promptAttempted: false }),
    },
  })
  const bindings = new Map([[sessionId, bindingFor(projection)]])
  const sessionBinding = (id: string) => bindings.get(id)
  const sessions = {
    list,
    binding: sessionBinding,
    create: vi.fn(async () => 'destination'),
    subagentAddress: vi.fn(() => undefined as unknown),
    using: vi.fn(
      async (
        id: string,
        _options: unknown,
        operation: (reference: { binding: ReturnType<typeof bindingFor> }) => unknown,
      ) => {
        const binding =
          bindings.get(id) ?? bindingFor(observable({ lastUsed: null, next: null }), transcript, destination.blank)
        bindings.set(id, binding)
        return operation({ binding })
      },
    ),
    open: vi.fn(() => {
      order.push('open')
    }),
  }
  const remote = {
    session: {
      selectModel: vi.fn(async (): Promise<{ ok: boolean; error?: { message: string }; value?: unknown }> => ({
        ok: true,
      })),
    },
  }
  const modelDirectories = vi.fn(() => {
    throw new Error('modelDirectories must not be read')
  })
  const ctx = {
    uiWorkspace: { openSession: sessions.open },
    get(name: string) {
      if (name === 'sessions') return sessions
      if (name === 'modelDirectories') return { directoryFor: modelDirectories }
      if (name === 'workspaces') return { list: observable({ items: [] }) }
      return undefined
    },
    remote,
  } as never
  return {
    ctx,
    remote,
    modelDirectories,
    sessions,
    bindings,
    bindingFor,
    list,
    order,
    projection,
    prompt,
    transcript,
    destination,
    coordinator: new CrossBackendCoordinator(ctx, owns),
  }
}

function transactionStatesOf(coordinator: CrossBackendCoordinator): Map<string, unknown> {
  const { tx } = coordinator as unknown as { tx: { states: Map<string, unknown> } }
  return tx.states
}

describe('cross-backend coordinator', () => {
  it('keeps native-to-native selection entirely outside the ACP path', () => {
    expect(
      shouldConfirmBackendTransition(
        {
          lastUsed: { provider: 'native-a', model: 'a' },
          next: { provider: 'native-b', model: 'b' },
          blank: false,
        },
        owns,
      ),
    ).toBe(false)
  })

  it('returns an identity-stable external snapshot', () => {
    const f = fixture()
    expect(f.coordinator.getSnapshot()).toBe(f.coordinator.getSnapshot())
  })

  it('adopts ACP directly for a blank session and does not open a modal', () => {
    const f = fixture({
      row: { blank: true },
      projection: { lastUsed: null, next: { provider: 'acp-codex', model: 'gpt' } },
    })
    const stop = f.coordinator.start()
    expect(f.coordinator.getSnapshot().pending).toBeNull()
    stop()
  })

  it('requires confirmation when historical state has no committed source model', async () => {
    const f = fixture({
      row: { blank: false },
      projection: { lastUsed: null, next: null },
    })
    const stop = f.coordinator.start()
    expect(f.coordinator.getSnapshot().pending).toBeNull()

    f.projection.set({ lastUsed: null, next: { provider: 'acp-codex', model: 'gpt' } })
    await settle()

    const pending = f.coordinator.getSnapshot().pending
    expect(pending?.ticket.sourceSelection).toBeUndefined()
    expect(pending?.ticket.sourceAlreadyRestored).toBeUndefined()
    expect(pending?.ticket.targetSelection).toEqual({ provider: 'acp-codex', model: 'gpt' })
    expect(pending?.confirmable).toBe(true)
    expect(f.remote.session.selectModel).not.toHaveBeenCalled()

    await f.coordinator.confirm()

    expect(f.sessions.create).toHaveBeenCalledTimes(1)
    expect(f.remote.session.selectModel).toHaveBeenCalledWith({
      sessionId: expect.any(String),
      provider: 'acp-codex',
      model: 'gpt',
    })
    expect(f.sessions.open).toHaveBeenCalledTimes(1)
    expect(f.coordinator.getSnapshot().pending).toBeNull()
    expect(transactionStatesOf(f.coordinator).has(pending!.ticket.key)).toBe(false)
    stop()
  })

  it.each([false, true])(
    'can dismiss an unknown-source transition without inventing a rollback model (failed confirm: %s)',
    async (failConfirm) => {
      const f = fixture({
        row: { blank: false },
        projection: { lastUsed: null, next: null },
      })
      const stop = f.coordinator.start()
      f.projection.set({ lastUsed: null, next: { provider: 'acp-codex', model: 'gpt' } })
      await settle()

      const key = f.coordinator.getSnapshot().pending!.ticket.key
      if (failConfirm) {
        f.remote.session.selectModel.mockResolvedValueOnce({
          ok: false,
          error: { message: 'destination selection failed' },
        })
        await f.coordinator.confirm()
        expect(transactionStatesOf(f.coordinator).has(key)).toBe(true)
      }

      await f.coordinator.cancel()

      expect(f.coordinator.getSnapshot().pending).toBeNull()
      expect(transactionStatesOf(f.coordinator).has(key)).toBe(false)
      expect(f.remote.session.selectModel).toHaveBeenCalledTimes(failConfirm ? 1 : 0)
      expect(f.sessions.create).toHaveBeenCalledTimes(failConfirm ? 1 : 0)
      expect(f.sessions.open).not.toHaveBeenCalled()
      expect(f.projection.getSnapshot().next).toEqual({ provider: 'acp-codex', model: 'gpt' })
      stop()
    },
  )

  it('keeps same-profile ACP model changes in the current session', () => {
    const f = fixture({
      projection: {
        lastUsed: { provider: 'acp-codex', model: 'old' },
        next: { provider: 'acp-codex', model: 'new' },
      },
    })
    const stop = f.coordinator.start()
    expect(f.coordinator.getSnapshot().pending).toBeNull()
    stop()
  })

  it('cancels a later cross-profile switch back to the latest visible selection', async () => {
    const f = fixture({
      projection: {
        lastUsed: { provider: 'acp-codex', model: 'GPT-5.4-Mini', reasoningEffort: 'low' },
        next: { provider: 'acp-codex', model: 'GPT-5.4-Mini', reasoningEffort: 'low' },
      },
    })
    const stop = f.coordinator.start()
    f.projection.set({
      lastUsed: { provider: 'acp-codex', model: 'GPT-5.4-Mini', reasoningEffort: 'low' },
      next: { provider: 'acp-codex', model: 'GPT-5.4-Mini', reasoningEffort: 'medium' },
    })
    f.projection.set({
      lastUsed: { provider: 'acp-codex', model: 'GPT-5.4-Mini', reasoningEffort: 'low' },
      next: { provider: 'acp-devin', model: 'Devin' },
    })
    await settle()
    expect(f.coordinator.getSnapshot().pending?.ticket.sourceSelection).toEqual({
      provider: 'acp-codex',
      model: 'GPT-5.4-Mini',
      reasoningEffort: 'medium',
    })
    await f.coordinator.cancel()
    expect(f.remote.session.selectModel).toHaveBeenCalledWith({
      sessionId: 'session-1',
      provider: 'acp-codex',
      model: 'GPT-5.4-Mini',
      reasoningEffort: 'medium',
    })
    expect(f.sessions.create).not.toHaveBeenCalled()
    stop()
  })

  it('restores the source before exposing one pending decision and keeps it across navigation', async () => {
    const f = fixture({
      projection: {
        lastUsed: { provider: 'native', model: 'old' },
        next: { provider: 'acp-codex', model: 'new' },
      },
    })
    const stop = f.coordinator.start()
    expect(f.coordinator.getSnapshot().pending).toBeNull()
    await settle()
    const pending = f.coordinator.getSnapshot().pending
    expect(pending?.ticket.sourceSessionId).toBe('session-1')
    expect(f.remote.session.selectModel).toHaveBeenCalledWith({
      sessionId: 'session-1',
      provider: 'native',
      model: 'old',
    })
    f.list.set({
      byId: { 'session-2': { id: 'session-2', blank: true, cwd: '/tmp' } },
    })
    expect(f.coordinator.getSnapshot().pending?.ticket.sourceSessionId).toBe('session-1')
    stop()
  })

  it('restores the source model without a stale effort its model no longer advertises', async () => {
    const f = fixture({
      projection: {
        lastUsed: { provider: 'acp-deveco', model: 'deveco/GLM-5.1', reasoningEffort: 'high' },
        next: { provider: 'acp-codebuddy-code', model: 'deepseek-v4.1-flash' },
      },
    })
    // The host rejects an effort the model does not advertise before any adapter
    // call, so staging must fall back to the bare model identity instead of
    // leaving the decision modal unconfirmable and cancel looping.
    f.remote.session.selectModel.mockResolvedValueOnce({
      ok: false,
      error: { message: 'provider "acp-deveco" model "deveco/GLM-5.1" does not support reasoning effort "high"' },
    })
    const stop = f.coordinator.start()
    await settle()
    expect(f.remote.session.selectModel).toHaveBeenNthCalledWith(1, {
      sessionId: 'session-1',
      provider: 'acp-deveco',
      model: 'deveco/GLM-5.1',
      reasoningEffort: 'high',
    })
    expect(f.remote.session.selectModel).toHaveBeenNthCalledWith(2, {
      sessionId: 'session-1',
      provider: 'acp-deveco',
      model: 'deveco/GLM-5.1',
    })
    const pending = f.coordinator.getSnapshot().pending
    expect(pending?.failure).toBeNull()
    expect(pending?.confirmable).toBe(true)
    stop()
  })

  it('does not read modelDirectories while observing a native or ACP transition', () => {
    const f = fixture({
      projection: {
        lastUsed: { provider: 'native', model: 'old' },
        next: { provider: 'acp-codex', model: 'new' },
      },
    })
    const stop = f.coordinator.start()
    expect(f.modelDirectories).not.toHaveBeenCalled()
    stop()
  })

  it('restores a no-location transition before exposing a non-confirmable decision', async () => {
    const f = fixture({
      row: { blank: false, cwd: null },
      projection: {
        lastUsed: { provider: 'native', model: 'old' },
        next: { provider: 'acp-codex', model: 'new' },
      },
    })
    const stop = f.coordinator.start()
    await settle()
    expect(f.coordinator.getSnapshot().pending?.confirmable).toBe(false)
    await f.coordinator.confirm()
    expect(f.sessions.create).not.toHaveBeenCalled()
    expect(f.remote.session.selectModel).toHaveBeenCalledWith({
      sessionId: 'session-1',
      provider: 'native',
      model: 'old',
    })
    stop()
  })

  it('does not leave a second decision after a failed source rollback', async () => {
    const f = fixture({
      projection: {
        lastUsed: { provider: 'native', model: 'old' },
        next: { provider: 'acp-codex', model: 'new' },
      },
    })
    const selectModel = f.remote.session.selectModel
    selectModel.mockResolvedValueOnce({ ok: false, error: { message: 'rollback failed' } })
    const stop = f.coordinator.start()
    await settle()
    expect(f.coordinator.getSnapshot().pending?.failure).toEqual({
      phase: 'restore-source',
      message: 'rollback failed',
    })
    expect(selectModel).toHaveBeenCalledTimes(1)
    stop()
  })

  it('keeps the decision confirmable when the source model cannot be restored', async () => {
    const f = fixture({
      projection: {
        lastUsed: { provider: 'buddy', model: 'step-5-preview' },
        next: { provider: 'acp-qoder', model: 'qfmodel' },
      },
    })
    // A retired model makes the restore permanently impossible; creating the
    // destination never depended on it, so the modal must stay actionable.
    f.remote.session.selectModel.mockResolvedValueOnce({
      ok: false,
      error: { message: 'Select an available model before sending a message.' },
    })
    const stop = f.coordinator.start()
    await settle()
    const pending = f.coordinator.getSnapshot().pending
    expect(pending?.confirmable).toBe(true)
    expect(pending?.ticket.sourceRestoreFailed).toBe('Select an available model before sending a message.')
    stop()
  })

  it('dismisses the decision when canceling an unrestorable source', async () => {
    const f = fixture({
      projection: {
        lastUsed: { provider: 'buddy', model: 'step-5-preview' },
        next: { provider: 'acp-qoder', model: 'qfmodel' },
      },
    })
    f.remote.session.selectModel.mockResolvedValue({ ok: false, error: { message: 'no such model' } })
    const stop = f.coordinator.start()
    await settle()
    expect(f.coordinator.getSnapshot().pending).not.toBeNull()
    await f.coordinator.cancel()
    // The dismissed decision must not bounce back: the modal closes and the
    // observer sees no new selection to stage.
    expect(f.coordinator.getSnapshot().pending).toBeNull()
    stop()
  })

  it.each([
    ['create-destination', 'create'],
    ['select-destination', 'select'],
    ['open-destination', 'open'],
  ] as const)('retains the structured %s failure for localized UI handling', async (phase, failedStep) => {
    const f = fixture({
      projection: {
        lastUsed: { provider: 'native', model: 'old' },
        next: { provider: 'acp-codex', model: 'new' },
      },
    })
    if (failedStep === 'create') f.sessions.create.mockRejectedValueOnce(new Error('CREATE_DIAGNOSTIC'))
    if (failedStep === 'select')
      f.remote.session.selectModel
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, error: { message: 'SELECT_DIAGNOSTIC' } })
    if (failedStep === 'open')
      f.sessions.open.mockImplementationOnce(() => {
        throw new Error('OPEN_DIAGNOSTIC')
      })
    const stop = f.coordinator.start()
    await settle()
    await f.coordinator.confirm()
    expect(f.coordinator.getSnapshot().pending?.failure).toMatchObject({ phase })
    stop()
  })

  it('observes a retained sidebar independently and queues simultaneous decisions without mixing their sources', async () => {
    const f = fixture()
    const child = observable({
      lastUsed: { provider: 'native', model: 'child-old' },
      next: { provider: 'native', model: 'child-old' },
    })
    f.bindings.set('child', f.bindingFor(child))
    f.list.set({ byId: { ...f.list.getSnapshot().byId, child: { id: 'child', blank: false, cwd: '/child' } } })
    const stop = f.coordinator.start()
    child.set({
      lastUsed: { provider: 'native', model: 'child-old' },
      next: { provider: 'acp-devin', model: 'child-new' },
    })
    f.projection.set({
      lastUsed: { provider: 'native', model: 'model-a' },
      next: { provider: 'acp-codex', model: 'parent-new' },
    })
    await settle()
    expect(f.remote.session.selectModel).toHaveBeenCalledWith({
      sessionId: 'child',
      provider: 'native',
      model: 'child-old',
    })
    expect(f.remote.session.selectModel).toHaveBeenCalledWith({
      sessionId: 'session-1',
      provider: 'native',
      model: 'model-a',
    })
    expect(f.coordinator.getSnapshot().pending?.ticket.sourceSessionId).toBe('child')
    await f.coordinator.cancel()
    expect(f.coordinator.getSnapshot().pending?.ticket.sourceSessionId).toBe('session-1')
    await f.coordinator.confirm()
    expect(f.sessions.open).toHaveBeenCalledTimes(1)
    expect(f.coordinator.getSnapshot().pending).toBeNull()
    stop()
  })

  it('does not reopen a released sidebar or publish a late decision from its old binding', async () => {
    const f = fixture()
    let restore!: (value: { ok: boolean }) => void
    f.remote.session.selectModel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          restore = resolve
        }),
    )
    const stop = f.coordinator.start()
    f.projection.set({
      lastUsed: { provider: 'native', model: 'model-a' },
      next: { provider: 'acp-codex', model: 'new' },
    })
    f.bindings.clear()
    f.list.set({ ...f.list.getSnapshot() })
    restore({ ok: true })
    await settle()
    expect(f.coordinator.getSnapshot().pending).toBeNull()
    f.projection.set({
      lastUsed: { provider: 'native', model: 'model-a' },
      next: { provider: 'acp-devin', model: 'another' },
    })
    expect(f.remote.session.selectModel).toHaveBeenCalledTimes(1)
    stop()
  })

  it('never offers the backend decision to a subagent session', async () => {
    const f = fixture()
    f.sessions.subagentAddress.mockReturnValue({
      parentSessionId: 'parent',
      childSessionId: 'session-1',
      mode: 'continuable',
    } as never)
    const stop = f.coordinator.start()
    f.projection.set({
      lastUsed: { provider: 'native', model: 'model-a' },
      next: { provider: 'acp-codex', model: 'new' },
    })
    await settle()
    expect(f.coordinator.getSnapshot().pending).toBeNull()
    expect(f.sessions.create).not.toHaveBeenCalled()
    stop()
  })

  it('carries text-only conversation into the destination before opening it when opted in', async () => {
    const f = fixture()
    f.transcript.set({
      entries: [
        {
          type: 'event',
          event: {
            type: 'user/message',
            seq: 1,
            time: 1,
            data: {
              source: { kind: 'user' },
              content: [
                { type: 'text', text: 'hello there' },
                { type: 'image', attachment: { id: 'attachment-1' } },
              ],
            },
          },
        },
        // Injected context shares the user role but is not conversation text.
        {
          type: 'event',
          event: {
            type: 'user/message',
            seq: 2,
            time: 2,
            data: { source: { kind: 'notice' }, content: [{ type: 'text', text: 'file changed' }] },
          },
        },
        // Live transient chunks never reach the durable transcript.
        { type: 'transient', event: { type: 'assistant/live-chunk', seq: 3, time: 3, data: {} } },
        {
          type: 'event',
          event: {
            type: 'assistant/message',
            seq: 4,
            time: 4,
            data: {
              message: {
                content: [
                  { type: 'reasoning', text: 'private chain' },
                  { type: 'text', text: 'the answer' },
                  { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
                ],
              },
            },
          },
        },
      ],
      hasMore: true,
    })
    const stop = f.coordinator.start()
    f.projection.set({
      lastUsed: { provider: 'native', model: 'model-a' },
      next: { provider: 'acp-codex', model: 'new' },
    })
    await settle()

    f.coordinator.setCarryTranscript(transcriptLabels)
    await f.coordinator.confirm()

    const call = f.prompt.mock.calls[0]!
    const text = call[0][0]!.text
    expect(call[1]).toBe('queue')
    expect(text.startsWith(transcriptLabels.header)).toBe(true)
    expect(text).toContain('User: hello there')
    expect(text).toContain('Assistant: the answer')
    expect(text).toContain(transcriptLabels.truncated)
    expect(text).not.toContain('private chain')
    expect(text).not.toContain('file changed')
    expect(text).not.toContain('attachment-1')
    expect(text).not.toContain('bash')
    // The first turn is written before the destination is opened.
    expect(f.order).toEqual(['prompt', 'open'])
    stop()
  })

  it('writes nothing when the user keeps the default (handoff off)', async () => {
    const f = fixture()
    const stop = f.coordinator.start()
    f.projection.set({
      lastUsed: { provider: 'native', model: 'model-a' },
      next: { provider: 'acp-codex', model: 'new' },
    })
    await settle()
    await f.coordinator.confirm()
    expect(f.prompt).not.toHaveBeenCalled()
    expect(f.sessions.open).toHaveBeenCalledTimes(1)
    stop()
  })

  it('reports a failed transcript write as a retryable carry-transcript failure', async () => {
    const f = fixture()
    f.transcript.set({
      entries: [
        {
          type: 'event',
          event: {
            type: 'user/message',
            seq: 1,
            time: 1,
            data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello there' }] },
          },
        },
      ],
      hasMore: false,
    })
    f.prompt.mockResolvedValueOnce({ ok: false, error: { message: 'PROMPT_REJECTED' } })
    const stop = f.coordinator.start()
    f.projection.set({
      lastUsed: { provider: 'native', model: 'model-a' },
      next: { provider: 'acp-codex', model: 'new' },
    })
    await settle()
    f.coordinator.setCarryTranscript(transcriptLabels)
    await f.coordinator.confirm()

    expect(f.coordinator.getSnapshot().pending?.failure).toMatchObject({
      phase: 'carry-transcript',
      message: 'PROMPT_REJECTED',
    })
    expect(f.sessions.open).not.toHaveBeenCalled()
    stop()
  })
})
