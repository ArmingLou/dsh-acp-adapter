/**
 * Transactional handoff between DSH execution backends.
 *
 * This module deliberately has no DSH settings or UI dependency.  The stock
 * session controller remains the authority for model selection: restoring the
 * source calls `session.selectModel(source)`, and selecting the destination
 * calls the same official operation after the destination exists.  That gives
 * the host its normal "selection becomes default" semantics without a second
 * plugin-owned default store.
 */

/** Client-safe model selection shape; intentionally independent of the legacy picker. */
export interface CrossBackendModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface CrossBackendLocation {
  readonly workspaceId?: string
  readonly cwd?: string
}

/**
 * Localized markers for the optional text handoff. The injected turn is
 * model-facing prose, so its framing follows the UI language the user opted in
 * with instead of a plugin-owned constant.
 */
export interface CrossBackendTranscriptLabels {
  /** One-line marker opening the carried transcript. */
  readonly header: string
  /** Trailing marker used when older turns were left behind. */
  readonly truncated: string
  readonly user: string
  readonly assistant: string
}

/** One text-only conversation turn available for the handoff. */
export interface CrossBackendTranscriptEntry {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/**
 * Character budget for the carried transcript. ACP agents advertise windows
 * from 128k tokens upward, but this text is one extra first turn stacked on the
 * agent's own system prompt, tool schemas and (for some routes) its own
 * context replay. 12k characters (~3k tokens) covers the tail of an ordinary
 * session while staying a small fraction of the smallest supported window.
 */
export const CROSS_BACKEND_TRANSCRIPT_MAX_CHARS = 12_000

/**
 * Per-message ceiling. A single pasted log or diff must not consume the whole
 * budget and hide the rest of the conversation; the newest message is clipped
 * with an ellipsis instead of being dropped.
 */
export const CROSS_BACKEND_TRANSCRIPT_MESSAGE_MAX_CHARS = 4_000

export interface CrossBackendTicket {
  readonly key: string
  readonly sourceSessionId: string
  readonly sourceSelection: CrossBackendModelSelection | undefined
  readonly targetSelection: CrossBackendModelSelection
  readonly location: CrossBackendLocation
  readonly label?: string
  /** The additive observer already compensated the stock picker's source
   * mutation before showing its confirmation UI. */
  readonly sourceAlreadyRestored?: true
  /**
   * Present only when the user explicitly opted in to carrying the current
   * conversation's text into the destination's first turn. Absent means the
   * default: no handoff, byte-for-byte the previous behavior.
   */
  readonly carryTranscript?: CrossBackendTranscriptLabels
  /**
   * The observer already tried to restore the source selection and the host
   * refused it. Creating the destination does not depend on that restore, so
   * the decision stays confirmable and the failure is reported as a warning
   * instead of being retried (or blocking) in the transaction.
   */
  readonly sourceRestoreFailed?: string
}

export type CrossBackendPhase =
  'restore-source' | 'create-destination' | 'select-destination' | 'carry-transcript' | 'open-destination' | 'completed'

export interface CrossBackendFailure {
  readonly phase: CrossBackendPhase
  readonly message: string
  readonly destinationSessionId?: string
}

export type CrossBackendResult =
  | {
      readonly ok: true
      readonly destinationSessionId: string
      /** Absent unless the user opted in to the text handoff. */
      readonly transcript?: CrossBackendTranscriptOutcome
      /**
       * Non-blocking problem the user should know about — currently only a
       * failed source-model restore. The decision itself succeeded.
       */
      readonly warning?: CrossBackendFailure
    }
  | { readonly ok: false; readonly failure: CrossBackendFailure }

/** Honest reasons for writing nothing when the user did opt in. */
export type CrossBackendTranscriptSkipReason = 'empty-transcript' | 'destination-not-blank'

/** Truthful account of the optional text handoff. */
export type CrossBackendTranscriptOutcome =
  | { readonly status: 'injected'; readonly messages: number; readonly truncated: boolean }
  | { readonly status: 'skipped'; readonly reason: CrossBackendTranscriptSkipReason }

export interface CrossBackendCreateResult {
  /** The host published the session even when workspace attachment failed. */
  readonly published: boolean
  readonly message?: string
}

export interface CrossBackendOperationResult {
  readonly ok: boolean
  readonly message?: string
}

export interface CrossBackendCarryResult extends CrossBackendOperationResult {
  /** Text messages written into the destination's first turn. */
  readonly messages?: number
  /** Older turns were left behind by the budget or by the loaded window. */
  readonly truncated?: boolean
  /** Why nothing was written, when that was the honest outcome. */
  readonly skipped?: CrossBackendTranscriptSkipReason
}

export interface CrossBackendOperations {
  restoreSource(selection: CrossBackendModelSelection): Promise<CrossBackendOperationResult>
  createDestination(input: { sessionId: string; location: CrossBackendLocation }): Promise<CrossBackendCreateResult>
  selectDestination(sessionId: string, selection: CrossBackendModelSelection): Promise<CrossBackendOperationResult>
  /**
   * Write the source transcript into the destination's first user turn.
   * Called only when the ticket opted in, between destination model selection
   * and opening, so the destination never opens without the promised content.
   */
  carryTranscript(input: {
    sourceSessionId: string
    destinationSessionId: string
    labels: CrossBackendTranscriptLabels
  }): Promise<CrossBackendCarryResult>
  openDestination(sessionId: string): Promise<CrossBackendOperationResult>
}

interface TransactionState {
  readonly destinationSessionId: string
  sourceRestored: boolean
  destinationCreated: boolean
  destinationSelected: boolean
  transcriptHandled: boolean
  opened: boolean
}

/**
 * Build the destination's first-turn text from text-only turns, newest first.
 * Older turns are dropped (never silently interleaved) once the budget is
 * exhausted, and the drop is marked so the destination model knows the history
 * is partial. Returns undefined when nothing textual exists to carry.
 */
export function buildCrossBackendTranscript(
  entries: readonly CrossBackendTranscriptEntry[],
  labels: CrossBackendTranscriptLabels,
  omittedOlder = false,
): { text: string; messages: number; truncated: boolean } | undefined {
  const kept: string[] = []
  let used = 0
  let truncated = omittedOlder
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const text = entries[index]!.text.trim()
    if (text.length === 0) continue
    const clipped =
      text.length > CROSS_BACKEND_TRANSCRIPT_MESSAGE_MAX_CHARS
        ? `${text.slice(0, CROSS_BACKEND_TRANSCRIPT_MESSAGE_MAX_CHARS)}…`
        : text
    // The newest turn is always kept (clipped to the total budget at worst);
    // every older turn must fit whole or it and everything before it is dropped.
    if (kept.length > 0 && used + clipped.length > CROSS_BACKEND_TRANSCRIPT_MAX_CHARS) {
      truncated = true
      break
    }
    const body =
      clipped.length > CROSS_BACKEND_TRANSCRIPT_MAX_CHARS
        ? `${clipped.slice(0, CROSS_BACKEND_TRANSCRIPT_MAX_CHARS)}…`
        : clipped
    const role = entries[index]!.role === 'user' ? labels.user : labels.assistant
    kept.push(`${role}: ${body}`)
    used += body.length
  }
  if (kept.length === 0) return undefined
  const parts = [labels.header, '', ...kept.reverse()]
  if (truncated) parts.push('', labels.truncated)
  return { text: parts.join('\n'), messages: kept.length, truncated }
}

function messageOf(message: string | undefined, fallback: string): string {
  return typeof message === 'string' && message.length > 0 ? message : fallback
}

/**
 * Resolves the only locations that are truthful for a new session.  Workspace
 * membership wins over cwd because it preserves DSH's grouping semantics.
 */
export function resolveCrossBackendLocation(
  sessionId: string,
  workspaces: readonly { workspaceId: string; sessionIds: readonly string[] }[],
  cwd: string | undefined,
): CrossBackendLocation | undefined {
  const workspace = workspaces.find((candidate) => candidate.sessionIds.includes(sessionId))
  if (workspace !== undefined) return { workspaceId: workspace.workspaceId }
  if (typeof cwd === 'string' && cwd.length > 0) return { cwd }
  return undefined
}

/**
 * Small stateful coordinator.  A ticket key identifies one user decision;
 * retries reuse its preallocated destination id and skip completed phases.
 * No phase after destination selection writes a separate default: the official
 * destination `selectModel` call is the sole default-producing operation.
 */
export class CrossBackendTransactionController {
  private readonly states = new Map<string, TransactionState>()

  private stateFor(ticket: CrossBackendTicket): TransactionState {
    const existing = this.states.get(ticket.key)
    if (existing !== undefined) return existing
    const state: TransactionState = {
      destinationSessionId: `session-${globalThis.crypto.randomUUID()}`,
      sourceRestored: ticket.sourceAlreadyRestored === true,
      destinationCreated: false,
      destinationSelected: false,
      transcriptHandled: false,
      opened: false,
    }
    this.states.set(ticket.key, state)
    return state
  }

  async confirm(ticket: CrossBackendTicket, operations: CrossBackendOperations): Promise<CrossBackendResult> {
    const state = this.stateFor(ticket)
    let warning: CrossBackendFailure | undefined
    if (!state.sourceRestored && ticket.sourceSelection !== undefined) {
      const restored = await operations.restoreSource(ticket.sourceSelection)
      if (restored.ok) state.sourceRestored = true
      else
        // Creating the destination never depended on this restore: the source
        // keeps whichever selection the Host accepted. Report it as a warning
        // and keep the decision movable instead of stranding the modal.
        warning = {
          phase: 'restore-source',
          message: messageOf(restored.message, 'source model restore failed'),
          destinationSessionId: state.destinationSessionId,
        }
    }
    // A blank launcher has no previous model to restore.  It is still safe to
    // create a destination because no semantic context is being replaced.
    if (ticket.sourceSelection === undefined) state.sourceRestored = true

    if (!state.destinationCreated) {
      let created: CrossBackendCreateResult = { published: false }
      try {
        created = await operations.createDestination({
          sessionId: state.destinationSessionId,
          location: ticket.location,
        })
      } catch (error) {
        return {
          ok: false,
          failure: {
            phase: 'create-destination',
            message: messageOf(error instanceof Error ? error.message : undefined, 'destination creation failed'),
            destinationSessionId: state.destinationSessionId,
          },
        }
      }
      if (!created.published) {
        return {
          ok: false,
          failure: {
            phase: 'create-destination',
            message: messageOf(created.message, 'destination creation failed'),
            destinationSessionId: state.destinationSessionId,
          },
        }
      }
      state.destinationCreated = true
    }

    if (!state.destinationSelected) {
      const selected = await operations.selectDestination(state.destinationSessionId, ticket.targetSelection)
      if (!selected.ok) {
        return {
          ok: false,
          failure: {
            phase: 'select-destination',
            message: messageOf(selected.message, 'destination model selection failed'),
            destinationSessionId: state.destinationSessionId,
          },
        }
      }
      state.destinationSelected = true
    }

    let transcript: CrossBackendTranscriptOutcome | undefined
    if (ticket.carryTranscript !== undefined && !state.transcriptHandled) {
      const carried = await operations.carryTranscript({
        sourceSessionId: ticket.sourceSessionId,
        destinationSessionId: state.destinationSessionId,
        labels: ticket.carryTranscript,
      })
      if (!carried.ok) {
        // A failed write is retryable on the same preallocated destination:
        // create/select are already recorded, so a retry repeats only this
        // phase and never leaves the destination opened without its content.
        return {
          ok: false,
          failure: {
            phase: 'carry-transcript',
            message: messageOf(carried.message, 'conversation transcript handoff failed'),
            destinationSessionId: state.destinationSessionId,
          },
        }
      }
      state.transcriptHandled = true
      transcript =
        carried.skipped === undefined
          ? {
              status: 'injected',
              messages: carried.messages ?? 0,
              truncated: carried.truncated === true,
            }
          : { status: 'skipped', reason: carried.skipped }
    }

    if (!state.opened) {
      const opened = await operations.openDestination(state.destinationSessionId)
      if (!opened.ok) {
        return {
          ok: false,
          failure: {
            phase: 'open-destination',
            message: messageOf(opened.message, 'opening destination failed'),
            destinationSessionId: state.destinationSessionId,
          },
        }
      }
      state.opened = true
    }

    return {
      ok: true,
      destinationSessionId: state.destinationSessionId,
      ...(transcript === undefined ? {} : { transcript }),
      ...(warning === undefined ? {} : { warning }),
    }
  }

  /** Cancel restores the source only; it never creates or opens a destination. */
  async cancel(ticket: CrossBackendTicket, operations: CrossBackendOperations): Promise<CrossBackendResult> {
    if (ticket.sourceAlreadyRestored === true) {
      this.states.delete(ticket.key)
      return { ok: true, destinationSessionId: '' }
    }
    if (ticket.sourceSelection === undefined) {
      this.states.delete(ticket.key)
      return { ok: true, destinationSessionId: '' }
    }
    const restored = await operations.restoreSource(ticket.sourceSelection)
    // Discarding the decision must always succeed: a failed restore leaves the
    // source on its new selection, which is the state the modal already shows.
    this.states.delete(ticket.key)
    if (restored.ok) return { ok: true, destinationSessionId: '' }
    return {
      ok: true,
      destinationSessionId: '',
      warning: { phase: 'restore-source', message: messageOf(restored.message, 'source model restore failed') },
    }
  }

  /** Explicitly discard a completed/failed transaction after the UI is done. */
  forget(key: string): void {
    this.states.delete(key)
  }
}
