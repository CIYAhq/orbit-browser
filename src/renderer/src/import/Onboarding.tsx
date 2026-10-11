import { Check, Pin, Star } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ImportJob, ImportProgressItem, StarterSuggestion } from '../../../shared/commands/import'
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

/** An import's status, kept current. */
function useImportJob(jobId: string | undefined): ImportJob | null {
  const [job, setJob] = useState<ImportJob | null>(null)
  useEffect(() => {
    if (!jobId) return
    void invoke('import.status', { jobId }).then(setJob)
    return window.orbit.on('import.progress', (status) => {
      if ((status as ImportJob).id === jobId) setJob(status as ImportJob)
    })
  }, [jobId])
  return job
}

/** The Done step's import line (OB-09): what will be added from where, or that nothing will. */
export function ImportSummary({ jobId }: { jobId: string | undefined }) {
  const job = useImportJob(jobId)
  let text = 'Nothing imported: it’s in Settings, under General'
  if (jobId && job) {
    if (job.phase === 'reading') text = `Reading ${job.source}…`
    else if (job.phase === 'failed') text = `${job.source} couldn’t be read`
    else if (job.phase !== 'cancelled') text = `${importCounts(job)} from ${job.source}`
  }
  return <span data-testid="onboarding-summary-import">{text}</span>
}

/** Starter suggestions from the imported history (IM-16), under the Done step's summary: one click each, added with the import. */
export function ImportSuggestions({ jobId }: { jobId: string | undefined }) {
  const job = useImportJob(jobId)
  const suggestions: StarterSuggestion[] = job?.phase === 'held' ? (job.suggestions ?? []) : []
  if (!jobId || suggestions.length === 0) return null
  return (
    <div className="im-suggestions" data-testid="import-suggestions">
      <p>The sites you visit most in {job?.source}. Choose any to add:</p>
      <ul>
        {suggestions.map((s) => (
          <li key={s.url}>
            <button
              type="button"
              className="im-suggestion"
              aria-pressed={s.accepted}
              data-testid="import-suggestion"
              data-kind={s.kind}
              title={s.url}
              onClick={() => void invoke('import.suggest', { jobId, url: s.url, accepted: !s.accepted })}
            >
              {s.accepted ? (
                <Check size={13} aria-hidden="true" />
              ) : s.kind === 'favorite' ? (
                <Star size={13} aria-hidden="true" />
              ) : (
                <Pin size={13} aria-hidden="true" />
              )}
              <span className="im-suggestion__title">{s.title}</span>
              <span className="im-suggestion__kind">{s.kind === 'favorite' ? 'Favorite' : 'Pinned tab'}</span>
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="im-link"
        data-testid="import-suggestions-dismiss"
        onClick={() => void invoke('import.suggest', { jobId, accepted: false })}
      >
        Dismiss all
      </button>
    </div>
  )
}
