/** Shared, dependency-free classification of Agent-owned config options. */

/** Maximum length for opaque ACP option and mode identifiers. */
export const ACP_CONFIG_IDENTIFIER_MAX = 512 as const

/**
 * Adapter-owned effort value meaning "send no reasoning effort at all".
 * The stock picker builds its effort list from adapter metadata, so an ACP
 * model without a `thought_level` option would otherwise expose no way to clear
 * an effort the session already carries (a pinned profile default, or a value
 * left over from another model) — and the Host rejects that stale value before
 * the adapter is ever called. Advertising this entry on every ACP model keeps a
 * stored selection valid across model switches; the adapter never writes it to
 * the Agent and lets the model apply its own default instead.
 */
export const ACP_DEFAULT_EFFORT_ID = 'acp-default' as const

/** Label the Host renders next to {@link ACP_DEFAULT_EFFORT_ID}. */
export const ACP_DEFAULT_EFFORT_NAME = 'ACP default' as const

/** Normalize ACP identifiers without changing the original value shown to users. */
export function normalizeAcpConfigOptionKey(value: string): string {
  return value.trim().toLowerCase().replaceAll('-', '_')
}

/**
 * Model and reasoning controls remain owned by the stock DSH model picker.
 * ACP agents may spell their category/id with different casing or separators;
 * classification is normalized while the Agent-provided labels stay untouched.
 */
export function isAcpModelOrReasoningOption(option: {
  readonly id: string
  readonly category?: string | null
}): boolean {
  const id = normalizeAcpConfigOptionKey(option.id)
  const category =
    option.category === undefined || option.category === null ? '' : normalizeAcpConfigOptionKey(option.category)
  return (
    category === 'model' ||
    id === 'model' ||
    category === 'thought_level' ||
    category === 'reasoning_effort' ||
    id === 'thought_level' ||
    id === 'reasoning_effort'
  )
}
