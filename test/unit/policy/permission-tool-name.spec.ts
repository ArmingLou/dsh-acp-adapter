import { describe, expect, it, vi } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'
import {
  ACP_PERMISSION_TOOL_TOKEN_MAX,
  createAcpNativePermissionHandler,
  permissionToolName,
  type AcpNativeApprovalService,
} from '../../../src/domain/policy/permissions.ts'
import { permissionCopy } from '../../../src/domain/policy/permission-copy.ts'

const copy = permissionCopy('en')
const toolCall = (
  input: Partial<acp.RequestPermissionRequest['toolCall']>,
): acp.RequestPermissionRequest['toolCall'] => ({
  toolCallId: 'call-tool-name',
  ...input,
})
const execute = (rawInput: unknown): acp.RequestPermissionRequest['toolCall'] => toolCall({ kind: 'execute', rawInput })

describe('permissionToolName', () => {
  it('keeps a declared name verbatim', () => {
    const bash = toolCall({ name: 'Bash', kind: 'execute', rawInput: { command: 'cat' } })
    const readFile = toolCall({ name: 'read_file', kind: 'read' })
    expect(permissionToolName(bash, copy)).toBe('Bash')
    expect(permissionToolName(readFile, copy)).toBe('read_file')
  })

  it('keeps a non-execute kind as its own name', () => {
    expect(permissionToolName(toolCall({ kind: 'read' }), copy)).toBe('read')
    expect(permissionToolName(toolCall({ kind: 'edit' }), copy)).toBe('edit')
  })

  it('falls back to the localized ACP tool name without a name or kind', () => {
    expect(permissionToolName(toolCall({}), copy)).toBe(copy.acpTool)
    expect(permissionToolName(toolCall({}), permissionCopy('zh'))).toBe('ACP 工具')
  })

  it.each([
    ['cat x', 'execute (cat)'],
    ['/usr/bin/git push', 'execute (git)'],
    ['./rm -rf /tmp/x', 'execute (rm)'],
    ['  npm   publish ', 'execute (npm)'],
    ['"quoted-tool" --flag', 'execute (quoted-tool)'],
    ['a/../b/tail.sh', 'execute (tail.sh)'],
  ])('names the program of `%s`', (command, expected) => {
    expect(permissionToolName(execute(command), copy)).toBe(expected)
  })

  it('reads the command from the record form too', () => {
    expect(permissionToolName(execute({ command: '/bin/cat y' }), copy)).toBe('execute (cat)')
    expect(permissionToolName(execute({ CommandLine: 'git status' }), copy)).toBe('execute (git)')
  })

  it('falls back to the bare kind when no program can be read', () => {
    expect(permissionToolName(execute(undefined), copy)).toBe('execute')
    expect(permissionToolName(execute({}), copy)).toBe('execute')
    expect(permissionToolName(execute('   '), copy)).toBe('execute')
    // No program name in reach: never a grant some other command could share.
    expect(permissionToolName(execute({ argv: ['rm', '-rf', '/'] }), copy)).toBe('execute')
    expect(permissionToolName(execute('&& rm -rf /'), copy)).toBe('execute')
    expect(permissionToolName(execute('..'), copy)).toBe('execute')
  })

  it('drops control characters instead of forwarding them', () => {
    const name = permissionToolName(execute('ca\u0007t\u0000 x'), copy)
    expect(name).toBe('execute (cat)')
    expect(name).not.toMatch(/[\u0000-\u001f\u007f]/)
  })

  it('bounds the token', () => {
    const name = permissionToolName(execute('a'.repeat(400)), copy)
    expect(name).toBe(`execute (${'a'.repeat(ACP_PERMISSION_TOOL_TOKEN_MAX)})`)
  })
})

describe('host approval tool name for an execute request', () => {
  const offers: acp.PermissionOption[] = [
    { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'session', name: 'Allow this session', kind: 'allow_always' },
    { optionId: 'deny', name: 'Reject', kind: 'reject_once' },
  ]

  it('narrows the name to the program and leaves the rest of the request alone', async () => {
    const approval = { request: vi.fn<AcpNativeApprovalService['request']>(async () => 'allowed-once') }
    const handler = createAcpNativePermissionHandler({ approval, getAgent: () => ({}) })
    await handler({
      sessionId: 'external-session',
      toolCall: toolCall({
        toolCallId: 'call-narrow',
        kind: 'execute',
        title: 'Run command',
        rawInput: { command: 'cat README.md', description: 'read the manual' },
      }),
      options: offers,
    })
    const sent = approval.request.mock.calls[0]![0]
    expect(sent.toolName).toBe('execute (cat)')
    expect(sent.callId).toBe('call-narrow')
    expect(sent.commandLine).toBe('cat README.md')
    expect(sent.toolArgs).toEqual({ command: 'cat README.md', description: 'read the manual' })
    expect(sent.reason).toContain('cat README.md')
  })

  it('keeps the bare slug when the command cannot be read', async () => {
    const approval = { request: vi.fn<AcpNativeApprovalService['request']>(async () => 'allowed-once') }
    const handler = createAcpNativePermissionHandler({ approval, getAgent: () => ({}) })
    await handler({
      sessionId: 'external-session',
      toolCall: toolCall({ toolCallId: 'call-bare', kind: 'execute', title: 'Run command' }),
      options: offers,
    })
    expect(approval.request.mock.calls[0]![0].toolName).toBe('execute')
  })
})
