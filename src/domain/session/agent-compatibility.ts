/** Narrow compatibility rules for confirmed vendor behavior; no catalog or launch defaults. */
import type * as acp from '@agentclientprotocol/sdk'
import type { AcpAgentId } from '../../contract/agent-config.ts'

export function executableOverrideEnvFor(runtime: AcpAgentId | undefined): string | undefined {
  return runtime === 'claude' ? 'CLAUDE_CODE_EXECUTABLE' : runtime === 'antigravity' ? 'REFINED_AGY_ACP_BIN' : undefined
}

/**
 * Per-model configuration discovery is always attempted. A reasoning catalogue
 * is Agent-defined, not runtime-branded: probes show qoder answering
 * `[high, max, low, none]` for `dfmodel` but `[xhigh, low, medium, none]` for
 * `qfmodel`, and a picker fed only the first session's list offers `high` for a
 * model that rejects it. Discovery stays cheap for invariant catalogues — it
 * writes one config value per model on the probe session and creates extra
 * sessions only once an independent control is observed.
 */
export function modelProbeOptions(runtime: AcpAgentId | undefined): {
  probeModelConfigOptions: boolean
  probeModelConfigConcurrency: number
} {
  return {
    probeModelConfigOptions: true,
    probeModelConfigConcurrency: runtime === 'devin' ? 8 : 1,
  }
}

/** Opt into Claude's draft subagent notifications only for an explicitly bound runtime. */
export function sessionProtocolExtensions(runtime: AcpAgentId | undefined): { enableClaudeDraftSubagents: boolean } {
  return { enableClaudeDraftSubagents: runtime === 'claude' }
}

/** Kimi may resume `high` as `on`; accept only the live Agent-confirmed equivalent.
 * All other values still require exact equality or normal option validation.
 */
export function reasoningRequestIsCurrent(
  runtime: AcpAgentId | undefined,
  option: Extract<acp.SessionConfigOption, { type: 'select' }>,
  requested: string,
): boolean {
  if (option.currentValue === requested) return true
  if (runtime !== 'kimi' || requested !== 'high' || option.currentValue !== 'on') return false
  const values = new Set(
    option.options.flatMap((entry) => ('options' in entry ? entry.options : [entry])).map((entry) => entry.value),
  )
  return values.has('on') && !values.has('high')
}
