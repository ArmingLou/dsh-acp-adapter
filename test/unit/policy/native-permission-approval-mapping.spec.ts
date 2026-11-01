import { describe, expect, it, vi } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'
import {
  createAcpNativePermissionHandler,
  type AcpNativeApprovalService,
  type AcpPermissionAuditRecord,
} from '../../../src/domain/policy/permissions.ts'
import type { AcpNativeUserQuestionService } from '../../../src/domain/policy/elicitation.ts'

const option = (optionId: string, name: string, kind: acp.PermissionOption['kind']): acp.PermissionOption => ({
  optionId,
  name,
  kind,
})
/** The typical three-way card: one grant, one persistent grant, one refusal. */
const persistentOffers = (): acp.PermissionOption[] => [
  option('once', 'Allow once', 'allow_once'),
  option('session', 'Allow this session', 'allow_always'),
  option('deny', 'Reject', 'reject_once'),
]
const request = (options: acp.PermissionOption[]): acp.RequestPermissionRequest => ({
  sessionId: 'external-session',
  toolCall: {
    toolCallId: 'call-persistent',
    kind: 'execute',
    title: 'Run command',
    rawInput: { command: 'echo offered' },
  },
  options,
})
const firstLabel = (ask: ReturnType<typeof vi.fn>): string =>
  (ask.mock.calls[0] as [{ questions: readonly { id: string; options?: readonly { label: string }[] }[] }])[0]!
    .questions[0]!.options![0]!.label

describe('native approval for persistent Agent grants', () => {
  it.each([
    { outcome: 'allowed-once' as const, optionId: 'once', kind: 'allow_once' as const },
    { outcome: 'rejected' as const, optionId: 'deny', kind: 'reject_once' as const },
    { outcome: 'cancelled' as const, optionId: undefined, kind: undefined },
  ])('maps host $outcome to the closest offered option', async ({ outcome, optionId, kind }) => {
    const audit: AcpPermissionAuditRecord[] = []
    const approval = { request: vi.fn<AcpNativeApprovalService['request']>(async () => outcome) }
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>()
    const handler = createAcpNativePermissionHandler({
      approval,
      userQuestions: { ask },
      getAgent: () => ({}),
      audit: { append: async (record) => void audit.push(record) },
    })
    await expect(handler(request(persistentOffers()))).resolves.toEqual(
      optionId === undefined ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId } },
    )
    expect(approval.request).toHaveBeenCalledOnce()
    expect(ask).not.toHaveBeenCalled()
    expect(audit.at(-1)?.data).toMatchObject({
      decisionVia: 'native-approval',
      ...(optionId === undefined ? { outcome: 'cancelled' } : { optionId, selectedOptionKind: kind }),
    })
    // The Agent's persistent grant is never returned on the Host's behalf.
    expect(audit.at(-1)?.data).not.toMatchObject({ optionId: 'session' })
  })

  it.each(['en', 'zh'] as const)('keeps every Agent choice readable in the approval reason (%s)', async (locale) => {
    const approval = { request: vi.fn<AcpNativeApprovalService['request']>(async () => 'allowed-once') }
    const handler = createAcpNativePermissionHandler({ approval, getAgent: () => ({}), locale })
    await handler(request(persistentOffers()))
    const reason = approval.request.mock.calls[0]![0].reason!
    expect(reason).toContain(`${locale === 'zh' ? '本次允许' : 'Allow once'}: Allow once`)
    expect(reason).toContain(`${locale === 'zh' ? '本次拒绝' : 'Reject once'}: Reject`)
    expect(reason).toContain(
      `${locale === 'zh' ? 'Agent 提供的选项' : 'Options the Agent offered'}: Allow once / Allow this session / Reject`,
    )
  })

  it('keeps the wider card on the question surface when the Host has no answerer', async () => {
    const audit: AcpPermissionAuditRecord[] = []
    const approval = { request: vi.fn<AcpNativeApprovalService['request']>(async () => 'unavailable') }
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ questions }) => ({
      answers: [{ id: questions[0]!.id, selected: ['Allow this session'] }],
    }))
    const handler = createAcpNativePermissionHandler({
      approval,
      userQuestions: { ask },
      getAgent: () => ({}),
      audit: { append: async (record) => void audit.push(record) },
    })
    await expect(handler(request(persistentOffers()))).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'session' },
    })
    expect(approval.request).toHaveBeenCalledOnce()
    expect(ask).toHaveBeenCalledOnce()
    expect(firstLabel(ask)).toBe('Allow once')
    expect(audit.at(-1)?.data).toMatchObject({ decisionVia: 'native-question', optionId: 'session' })
  })

  it('keeps the wider card on the question surface when the approval service throws', async () => {
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ questions }) => ({
      answers: [{ id: questions[0]!.id, selected: [questions[0]!.options![2]!.label] }],
    }))
    const log = vi.fn()
    const handler = createAcpNativePermissionHandler({
      approval: {
        request: async () => {
          throw new Error('approval service unavailable')
        },
      },
      userQuestions: { ask },
      getAgent: () => ({}),
      log,
    })
    await expect(handler(request(persistentOffers()))).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'deny' },
    })
    expect(ask).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('native approval unavailable'))
  })

  it('keeps the binary card closed when the Host has no answerer', async () => {
    const approval = { request: vi.fn<AcpNativeApprovalService['request']>(async () => 'unavailable') }
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>()
    const handler = createAcpNativePermissionHandler({ approval, userQuestions: { ask }, getAgent: () => ({}) })
    await expect(
      handler(request([option('once', 'Allow once', 'allow_once'), option('deny', 'Reject', 'reject_once')])),
    ).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(ask).not.toHaveBeenCalled()
  })

  it('never turns a one-time Host refusal into a persistent Agent denial', async () => {
    const approval = { request: vi.fn<AcpNativeApprovalService['request']>(async () => 'rejected') }
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async () => ({ answers: [] }))
    const handler = createAcpNativePermissionHandler({ approval, userQuestions: { ask }, getAgent: () => ({}) })
    await expect(
      handler(request([option('once', 'Allow once', 'allow_once'), option('never', 'Never allow', 'reject_always')])),
    ).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(approval.request).not.toHaveBeenCalled()
    expect(ask).toHaveBeenCalledOnce()
  })

  it('keeps distinct one-time decisions on the question surface', async () => {
    const approval = { request: vi.fn<AcpNativeApprovalService['request']>(async () => 'allowed-once') }
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async () => ({ answers: [] }))
    const handler = createAcpNativePermissionHandler({ approval, userQuestions: { ask }, getAgent: () => ({}) })
    for (const options of [
      [
        option('turn', 'Allow this turn', 'allow_once'),
        option('strict', 'Allow with strict review', 'allow_once'),
        option('session', 'Allow this session', 'allow_always'),
      ],
      [
        option('once', 'Allow once', 'allow_once'),
        option('retry', 'Reject and revise', 'reject_once'),
        option('stop', 'Reject and stop', 'reject_once'),
        option('session', 'Allow this session', 'allow_always'),
      ],
    ])
      await expect(handler(request(options))).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(approval.request).not.toHaveBeenCalled()
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('keeps a wider Antigravity interaction on its own question card without a Host approval', async () => {
    const nothing = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ questions }) => ({
      answers: [{ id: questions[0]!.id, selected: ['Allow this session'] }],
    }))
    const handler = createAcpNativePermissionHandler({
      userQuestions: { ask: nothing },
      getAgent: () => ({}),
      nativeQuestionProfile: 'antigravity',
    })
    await expect(
      handler({
        sessionId: 'external-session',
        toolCall: { toolCallId: 'interaction_30c0e13e', title: 'Which scope?', rawInput: {} },
        options: persistentOffers(),
      }),
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'session' } })
    expect(nothing).toHaveBeenCalledOnce()
  })
})
