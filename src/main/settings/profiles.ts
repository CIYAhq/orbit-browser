import { ARCHIVE_AFTER_CHOICES } from '../../shared/commands/settings'
import { DEFAULT_PROFILE_ID } from '../../shared/defaults'
import type { OrbitState } from '../../shared/state'
import type { MainContext } from '../context'

/** Whether a profile can have settings of its own: private windows' in-memory profiles can't. */
export function isPersistentProfile(state: OrbitState, profileId: string): boolean {
  return !!state.profiles[profileId]?.partition.startsWith('persist:')
}

/**
 * Per-profile settings that aren't the spaces lane's (profiles.create/rename/delete are): auto-archive
 * timing (ST-05). A profile without its own value follows the Default profile's (TD-03).
 */
export function registerProfileSettings(ctx: MainContext): void {
  const { store, commands } = ctx
  commands.register('settings.setArchiveAfter', ({ profileId, ms }) => {
    if (typeof profileId !== 'string' || !isPersistentProfile(store.state, profileId)) return
    const inherit = ms === null && profileId !== DEFAULT_PROFILE_ID
    if (!inherit && !(typeof ms === 'number' && ARCHIVE_AFTER_CHOICES.includes(ms))) return
    store.update((d) => {
      const profile = d.profiles[profileId]
      if (!profile) return
      if (inherit) delete profile.archiveAfterMs
      else if (profile.archiveAfterMs !== ms) profile.archiveAfterMs = ms as number
    })
  })
}
