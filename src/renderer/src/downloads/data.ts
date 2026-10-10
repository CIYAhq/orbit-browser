import { useEffect, useMemo, useState } from 'react'
import type { DownloadEntry } from '../../../shared/commands/downloads'
import type { ProfileId } from '../../../shared/state'
import { invoke } from '../api'
import { useOrbit } from '../store'

/** Changes to the list come in bursts (several downloads, Clear all): read it once they settle. */
const RELOAD_DELAY_MS = 80

/** The persistent profiles, as "id\u0000name" lines (a stable string for the store selector). */
export function profileLines(s: { profiles: Record<string, { id: string; name: string; partition: string }> }): string {
  return Object.values(s.profiles)
    .filter((p) => p.partition.startsWith('persist:'))
    .map((p) => `${p.id}\u0000${p.name}`)
    .join('\u0001')
}

/**
 * A profile's downloads list (DL-10), newest first; read again when it changes and on each open of
 * the Library. `null` until the first answer.
 */
export function useDownloadsList(profileId: ProfileId, nonce: number, limit?: number): DownloadEntry[] | null {
  const [entries, setEntries] = useState<{ profileId: string; list: DownloadEntry[] } | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again on each open (nonce)
  useEffect(() => {
    if (!profileId) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let asked = 0
    const read = () => {
      const ask = ++asked
      void invoke('downloads.list', { profileId, ...(limit ? { limit } : {}) }).then((list) => {
        if (alive && ask === asked) setEntries({ profileId, list })
      })
    }
    read()
    const off = window.orbit.on('downloads.changed', (payload) => {
      if ((payload as { profileId?: string }).profileId !== profileId) return
      clearTimeout(timer)
      timer = setTimeout(read, RELOAD_DELAY_MS)
    })
    return () => {
      alive = false
      clearTimeout(timer)
      off()
    }
  }, [profileId, nonce, limit])
  return entries && entries.profileId === profileId ? entries.list : null
}

/** A download as shown now: its list entry, with the sidebar's live fields while it runs. */
export function useLiveEntry(entry: DownloadEntry): DownloadEntry {
  const live = useOrbit((s) => s.downloads[entry.id])
  return useMemo(() => (live ? { ...entry, ...live } : entry), [entry, live])
}

/** Resume a download where it stopped, or start it again when it can't continue (DL-15). */
export function resumeOrRetry(id: string): void {
  void invoke('downloads.resume', { id }).then((ok) => {
    if (!ok) void invoke('downloads.retry', { id })
  })
}
