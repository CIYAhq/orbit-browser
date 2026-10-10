import { useEffect, useState } from 'react'
import type { ImportJob, ImportProgressItem } from '../../../shared/commands/import'
import { invoke } from '../api'
import { ImportFlow } from './ImportFlow'

/**
 * Onboarding's import step (OB-03): the import flow inline. Its import is read at once and added
 * when onboarding ends with Start browsing; Skip setup adds nothing (OB-14, D44).
 */
export function OnboardingImport({ onLater, onStarted }: { onLater: () => void; onStarted: (jobId: string) => void }) {
  return <ImportFlow embedded session={undefined} onClose={onLater} onStarted={onStarted} />
}

const UNITS: Record<ImportProgressItem['type'], [string, string]> = {
  bookmarks: ['bookmark', 'bookmarks'],
  history: ['history item', 'history items'],
  extensions: ['extension', 'extensions'],
  cookies: ['cookie', 'cookies'],
  links: ['link', 'links'],
}

/** "1,204 bookmarks · 18,331 history items" (IM-14), from what was read. */
export function importCounts(job: ImportJob): string {
  const parts = job.items
    .filter((i) => i.state !== 'skipped' && i.state !== 'failed')
    .map((i) => {
      const n = i.total ?? i.done
      const [one, many] = UNITS[i.type]
      return `${n.toLocaleString()} ${n === 1 ? one : many}`
    })
  return parts.join(' · ')
}

/** The Done step's import line (OB-09): what will be added from where, or that nothing will. */
export function ImportSummary({ jobId }: { jobId: string | undefined }) {
  const [job, setJob] = useState<ImportJob | null>(null)
  useEffect(() => {
    if (!jobId) return
    void invoke('import.status', { jobId }).then(setJob)
    return window.orbit.on('import.progress', (status) => {
      if ((status as ImportJob).id === jobId) setJob(status as ImportJob)
    })
  }, [jobId])
  let text = 'Nothing imported: it’s in Settings, under General'
  if (jobId && job) {
    if (job.phase === 'reading') text = `Reading ${job.source}…`
    else if (job.phase === 'failed') text = `${job.source} couldn’t be read`
    else if (job.phase !== 'cancelled') text = `${importCounts(job)} from ${job.source}`
  }
  return <span data-testid="onboarding-summary-import">{text}</span>
}
