import { useMemo } from 'react'
import type { SpaceId } from '../../../shared/state'
import { useOrbitShallow } from '../store'

export interface SpaceRow {
  id: SpaceId
  name: string
}

/** Every Space in sidebar order, re-rendering only when one is added, removed, renamed or moved. */
export function useSpaceRows(): SpaceRow[] {
  const flat = useOrbitShallow((s) => s.spaceOrder.flatMap((id) => [id, s.spaces[id]?.name ?? '']))
  return useMemo(() => {
    const rows: SpaceRow[] = []
    for (let i = 0; i + 1 < flat.length; i += 2) rows.push({ id: flat[i] as string, name: flat[i + 1] as string })
    return rows
  }, [flat])
}
