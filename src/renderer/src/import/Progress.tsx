import { AlertTriangle, Check, Circle, Loader2, Minus } from 'lucide-react'
import type { ImportJob, ImportProgressItem } from '../../../shared/commands/import'
import { useOrbit } from '../store'
import { TYPE_LABELS } from './sources'

const UNITS: Record<ImportProgressItem['type'], [string, string]> = {
  bookmarks: ['bookmark', 'bookmarks'],
  history: ['page', 'pages'],
  extensions: ['extension', 'extensions'],
  cookies: ['cookie', 'cookies'],
  links: ['link', 'links'],
}

function amount(item: ImportProgressItem): string {
  const [one, many] = UNITS[item.type]
  const n = item.state === 'done' ? item.done : (item.total ?? item.done)
  if (item.state === 'running' && item.total) return `${item.done.toLocaleString()} of ${item.total.toLocaleString()}`
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

function StateIcon({ state }: { state: ImportProgressItem['state'] }) {
  if (state === 'done') return <Check size={14} className="im-state im-state--done" aria-hidden="true" />
  if (state === 'running') return <Loader2 size={14} className="im-state im-state--running" aria-hidden="true" />
  if (state === 'failed') return <AlertTriangle size={14} className="im-state im-state--failed" aria-hidden="true" />
  if (state === 'skipped') return <Minus size={14} className="im-state" aria-hidden="true" />
  return <Circle size={10} className="im-state" aria-hidden="true" />
}

/** Progress per type while an import runs, then what was added and what was left out, and why (IM-14). */
export function Progress({ job }: { job: ImportJob }) {
  const folder = job.folders[0]
  const folderName = useOrbit((s) => (folder ? s.folders[folder.folderId]?.name : undefined))
  const spaceName = useOrbit((s) => (folder ? s.spaces[folder.spaceId]?.name : undefined))
  const done = job.phase === 'done'
  return (
    <div className="im-progress" data-testid="import-progress" data-phase={job.phase}>
      <p className="im-lead" aria-live="polite">
        {job.phase === 'reading' && `Reading ${job.source}… Nothing is added until it’s all read.`}
        {job.phase === 'held' && `Ready: ${job.source} is added when setup ends.`}
        {job.phase === 'adding' && `Adding from ${job.source}… You can keep browsing.`}
        {done &&
          (folderName
            ? `Done. The ${job.items[0]?.type === 'links' ? 'links' : 'bookmarks'} are in the pinned folder “${folderName}”${spaceName ? ` in ${spaceName}` : ''}.`
            : 'Done.')}
        {job.phase === 'failed' &&
          `The import stopped: ${job.error ?? 'something went wrong'}. Nothing more was added.`}
        {job.phase === 'cancelled' && 'Cancelled. Nothing was imported.'}
      </p>
      <ul className="im-items">
        {job.items.map((item) => (
          <li
            key={item.type}
            className="im-item"
            data-testid={`import-item-${item.type}`}
            data-state={item.state}
            data-done={item.done}
          >
            <StateIcon state={item.state} />
            <span className="im-item__label">{TYPE_LABELS[item.type]}</span>
            <span className="im-item__count">{item.state === 'skipped' ? (item.note ?? 'Skipped') : amount(item)}</span>
            {item.note && item.state !== 'skipped' && <span className="im-item__note">{item.note}</span>}
          </li>
        ))}
      </ul>
      {job.locked && (
        <div className="im-banner" role="alert" data-testid="import-locked">
          {job.locked.browser} was using some of its files, so they weren’t imported. Quit {job.locked.browser} and
          import again.
        </div>
      )}
      {(done || job.phase === 'failed') && job.skipped.length > 0 && (
        <div className="im-skipped" data-testid="import-skipped">
          <h2>Left out</h2>
          <ul>
            {job.skipped.map((s) => (
              <li key={`${s.what}:${s.reason}`}>
                {s.count.toLocaleString()} {s.what}: {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {done && job.stats && (
        <p
          className="im-note"
          data-testid="import-summary"
          data-ms={job.stats.ms}
          data-longest={job.stats.longestTaskMs}
        >
          Took {job.stats.ms < 1000 ? `${job.stats.ms} ms` : `${(job.stats.ms / 1000).toFixed(1)} s`}.
        </p>
      )}
    </div>
  )
}
