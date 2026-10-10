import type { LinkRule, OrbitState } from '../../shared/state'
import type { MainContext } from '../context'

/** At most this many link routing rules (ST-09). */
export const MAX_LINK_RULES = 100
const MAX_VALUE = 2048

/**
 * The link routing rules Settings sends (ST-09), cleaned: values trimmed, other fields dropped, and
 * rules for a Space that is gone left out (as loading state does). Undefined when the list is
 * malformed: then nothing changes.
 */
export function checkLinkRules(rules: unknown, state: OrbitState): LinkRule[] | undefined {
  if (!Array.isArray(rules) || rules.length > MAX_LINK_RULES) return undefined
  const clean: LinkRule[] = []
  for (const rule of rules) {
    if (typeof rule !== 'object' || rule === null) return undefined
    const { match, value, spaceId } = rule as Record<string, unknown>
    if (match !== 'contains' && match !== 'exact') return undefined
    if (typeof value !== 'string' || typeof spaceId !== 'string') return undefined
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > MAX_VALUE) return undefined
    if (state.spaces[spaceId]) clean.push({ match, value: trimmed, spaceId })
  }
  return clean
}

/** Link routing rules (ST-09). The other link settings go through `settings.update`. */
export function registerLinkSettings(ctx: MainContext): void {
  const { store, commands } = ctx
  commands.register('settings.setLinkRules', ({ rules }) => {
    const checked = checkLinkRules(rules, store.state)
    if (!checked) return
    store.update((d) => {
      d.settings.linkRules = checked
    })
  })
}
