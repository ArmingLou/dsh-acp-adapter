import { describe, expect, it } from 'vitest'
import { modelProbeOptions } from '../../../src/domain/session/agent-compatibility.ts'

describe('modelProbeOptions', () => {
  // A reasoning catalogue is Agent-defined: qoder answers `[high, max, low, none]`
  // for `dfmodel` and `[xhigh, low, medium, none]` for `qfmodel`. Advertising the
  // first session's list for every model makes the picker offer a level the live
  // session rejects, so discovery is not gated on a runtime brand.
  it('discovers per-model configuration for Agents without a bound runtime', () => {
    expect(modelProbeOptions(undefined).probeModelConfigOptions).toBe(true)
  })

  it('discovers per-model configuration for every bound runtime', () => {
    for (const runtime of ['devin', 'codex', 'kimi', 'claude', 'codebuddy', 'antigravity'] as const)
      expect(modelProbeOptions(runtime).probeModelConfigOptions).toBe(true)
  })

  it('keeps the Devin worker allowance and the serial default elsewhere', () => {
    expect(modelProbeOptions('devin').probeModelConfigConcurrency).toBe(8)
    expect(modelProbeOptions(undefined).probeModelConfigConcurrency).toBe(1)
    expect(modelProbeOptions('codebuddy').probeModelConfigConcurrency).toBe(1)
  })
})
