import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import type { BackupInfo, BackupUndoResult } from '../../../shared/commands/archive'
import { invoke } from '../api'
import { ConfirmDialog } from './ConfirmDialog'
import { dayLabel } from './geometry'
import { libraryToast } from './LibraryToasts'
import type { LibrarySectionProps } from './sections'

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

function startOfDay(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** "today at 10:42", "yesterday at 21:05", "Monday, October 5 at 09:30". */
export function momentLabel(at: number, now: number): string {
  const day = dayLabel(startOfDay(at), now)
  const time = timeFormat.format(at)
  if (day === 'Today' || day === 'Yesterday') return `${day.toLowerCase()} at ${time}`
  return `${day} at ${time}`
}

/** "just now", "5 minutes ago", "3 hours ago"; nothing past a day (the day heading says it). */
function ago(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return relative.format(-minutes, 'minute')
  const hours = Math.round(minutes / 60)
  return hours < 24 ? relative.format(-hours, 'hour') : ''
}

/** What the toast's Undo says it did. */
const UNDO_MESSAGES: Record<BackupUndoResult, string> = {
  undone: 'Restore undone',
  later: 'Undo the changes made since first',
  gone: 'The restore was undone already',
}

function counts(b: BackupInfo): string {
  const spaces = `${b.spaces} ${b.spaces === 1 ? 'Space' : 'Spaces'}`
  const tabs = `${b.tabs.toLocaleString()} ${b.tabs === 1 ? 'tab' : 'tabs'}`
  return `${spaces} · ${tabs}`
}

/**
 * Backups (AR-11), the Library section Help → Restore Data… opens: the sidebar backups Orbit keeps,
 * newest first by day. Restore… (or Enter on the highlighted row) asks first, then puts the
 * sidebar back as it was; the toast's Undo (or ⌘Z) takes the restore back, ⌘⇧Z restores again.
 */
export function BackupsSection({ show }: LibrarySectionProps) {
  const [list, setList] = useState<BackupInfo[] | null>(null)
  const [highlight, setHighlight] = useState(-1)
  const [ask, setAsk] = useState<BackupInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    invoke('backups.list', {})
      .then((next) => setList(next))
      .catch(() => setList([]))
  }, [])
  useEffect(() => window.orbit.on('backups.changed', load), [load])
  // Each open shows the list as it is now, and the list takes the keys.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs for each open of the Library
  useEffect(() => {
    load()
    setHighlight(-1)
    listRef.current?.focus()
  }, [show.nonce, load])

  const restore = async (b: BackupInfo) => {
    setAsk(null)
    setBusy(true)
    try {
      const result = await invoke('backups.restore', { id: b.id })
      if (!result.restored) {
        libraryToast(
          result.reason === 'backup-failed'
            ? 'Couldn’t back up the sidebar first; nothing was changed'
            : 'This backup can’t be restored',
        )
        return
      }
      const step = result.undoStep
      libraryToast(
        `Sidebar restored from ${momentLabel(b.at, Date.now())}`,
        step !== undefined
          ? {
              label: 'Undo',
              run: () => {
                invoke('backups.undoRestore', { step })
                  .then((r) => libraryToast(UNDO_MESSAGES[r]))
                  .catch(() => libraryToast(UNDO_MESSAGES.gone))
              },
            }
          : undefined,
      )
    } catch {
      libraryToast('This backup can’t be restored')
    } finally {
      setBusy(false)
      load()
    }
  }

  const backUpNow = async () => {
    const had = new Set((list ?? []).map((b) => b.id))
    const taken = await invoke('backups.take', {}).catch(() => null)
    if (!taken) libraryToast('The sidebar can’t be backed up right now')
    else libraryToast(had.has(taken.id) ? 'Nothing changed since the last backup' : 'Sidebar backed up')
    load()
  }

  const rows = list ?? []
  const onKeyDown = (e: KeyboardEvent) => {
    if (ask || rows.length === 0) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = highlight < 0 ? 0 : highlight + (e.key === 'ArrowDown' ? 1 : -1)
      setHighlight(Math.max(0, Math.min(rows.length - 1, next)))
      return
    }
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      const b = rows[highlight]
      if (!b || busy || b.unreadable) return
      e.preventDefault()
      setAsk(b)
    }
  }
  useEffect(() => {
    if (highlight < 0) return
    listRef.current?.querySelector(`[data-offset="${highlight}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  const now = Date.now()
  let lastDay = Number.NaN
  return (
    <section className="archive backups" data-testid="backups-section">
      <header className="archive__header">
        <div className="archive__heading">
          <h1 className="archive__title">Backups</h1>
          {rows.length > 0 && (
            <span className="archive__count" data-testid="backups-count">
              {rows.length === 1 ? '1 backup' : `${rows.length} backups`}
            </span>
          )}
        </div>
        <p className="backups__intro">
          Orbit keeps backups of the sidebar: Spaces, Favorites, pinned and Today tabs, and folders. Up to 10 from
          today, then one a day for the 10 days before, one a week for the month before that and one a month for the
          year before that.
        </p>
        <div className="archive__toolbar">
          <button
            type="button"
            className="archive__button"
            data-testid="backups-take"
            disabled={busy}
            onClick={() => void backUpNow()}
          >
            Back Up Now
          </button>
        </div>
      </header>
      <div
        ref={listRef}
        className="backups__list"
        role="listbox"
        aria-label="Sidebar backups"
        tabIndex={-1}
        data-testid="backups-list"
        data-loaded={list ? 'true' : 'false'}
        onKeyDown={onKeyDown}
      >
        {rows.map((b, i) => {
          const day = startOfDay(b.at)
          const heading =
            day !== lastDay ? (
              <div className="backups__day" role="presentation" data-testid="backups-day">
                {dayLabel(day, now)}
              </div>
            ) : null
          lastDay = day
          const highlighted = i === highlight
          return (
            <div key={b.id} role="presentation">
              {heading}
              <div
                className={`backup-row${highlighted ? ' is-highlighted' : ''}${b.unreadable ? ' is-unreadable' : ''}`}
                role="option"
                aria-selected={highlighted}
                data-testid="backup-row"
                data-id={b.id}
                data-offset={i}
                data-unreadable={b.unreadable ? 'true' : undefined}
                onClick={() => setHighlight(i)}
                onDoubleClick={() => {
                  if (!busy && !b.unreadable) setAsk(b)
                }}
              >
                <span className="backup-row__time">{timeFormat.format(b.at)}</span>
                <span
                  className="backup-row__counts"
                  data-testid="backup-row-counts"
                  title={b.unreadable ? 'The file is cut short, damaged or from another version of Orbit' : undefined}
                >
                  {b.unreadable ? 'Can’t be read' : counts(b)}
                </span>
                <span className="backup-row__ago">{ago(b.at, now)}</span>
                <button
                  type="button"
                  className="backup-row__restore"
                  data-testid="backup-restore"
                  disabled={busy || b.unreadable}
                  onClick={(e) => {
                    e.stopPropagation()
                    setHighlight(i)
                    setAsk(b)
                  }}
                >
                  Restore…
                </button>
              </div>
            </div>
          )
        })}
        {list && rows.length === 0 && (
          <div className="archive__empty" data-testid="backups-empty">
            <p className="archive__empty-title">No backups yet</p>
            <p>Orbit backs up the sidebar a few minutes after it changes.</p>
          </div>
        )}
      </div>
      {ask && (
        <ConfirmDialog
          title={`Restore the sidebar from ${momentLabel(ask.at, Date.now())}?`}
          confirmLabel="Restore"
          testId="backup-confirm"
          onConfirm={() => void restore(ask)}
          onCancel={() => setAsk(null)}
        >
          <p>
            Spaces, Favorites, pinned and Today tabs, and folders go back to how they were then. Tabs opened since go to
            the Archive.
          </p>
          <p>The sidebar as it is now is backed up first, so you can undo this.</p>
        </ConfirmDialog>
      )}
    </section>
  )
}
