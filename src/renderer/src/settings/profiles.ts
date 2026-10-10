import { useMemo } from 'react'
import { DEFAULT_PROFILE_ID } from '../../../shared/defaults'
import type { OrbitState, ProfileId } from '../../../shared/state'
import { useOrbit, useOrbitShallow } from '../store'

export interface ProfileRow {
  id: ProfileId
  name: string
}

/** Profiles with settings of their own (not private windows' in-memory ones): Default first, then by age. */
export function settingsProfiles(state: OrbitState) {
  return Object.values(state.profiles)
    .filter((p) => p.partition.startsWith('persist:'))
    .sort((a, b) =>
      a.id === DEFAULT_PROFILE_ID
        ? -1
        : b.id === DEFAULT_PROFILE_ID
          ? 1
          : a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
    )
}

/** The profiles Settings lists (ST-04, ST-20), re-rendering only when one is added, removed or renamed. */
export function useProfiles(): ProfileRow[] {
  const flat = useOrbitShallow((s) => settingsProfiles(s).flatMap((p) => [p.id, p.name]))
  return useMemo(() => {
    const rows: ProfileRow[] = []
    for (let i = 0; i + 1 < flat.length; i += 2) rows.push({ id: flat[i] as string, name: flat[i + 1] as string })
    return rows
  }, [flat])
}

export function useProfileName(profileId: ProfileId): string {
  return useOrbit((s) => s.profiles[profileId]?.name ?? 'Default')
}
