import { Ellipsis, FolderOpen, Play, RotateCw, Search, ShieldAlert, X } from 'lucide-react'
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { DownloadEntry } from '../../../shared/commands/downloads'
import { displayHost } from '../../../shared/url'
import { invoke, isMac } from '../api'
import { dayLabel, HEAD_H, listGeometry, ROW_H, rowTop, visibleItems } from '../library/geometry'
import { libraryToast } from '../library/LibraryToasts'
import type { LibrarySectionProps } from '../library/sections'
import { useOrbit, useWindow } from '../store'
import { profileLines, resumeOrRetry, useDownloadsList, useLiveEntry } from './data'
import { dragOut, FileThumb } from './file-ui'
import { byDay, nameMatches, percentDone, statusText } from './format'
import './downloads-library.css'

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
interface RowProps {
  entry: DownloadEntry
  offset: number
  top: number
  highlighted: boolean
  onOpen: (entry: DownloadEntry, tab: boolean) => void
  onMenu: (offset: number, entry: DownloadEntry, e: MouseEvent) => void
}

const Row = memo(function Row({ entry, offset, top, highlighted, onOpen, onMenu }: RowProps) {
  const d = useLiveEntry(entry)
  const { id, state } = d
  const held = state === 'completed' && !!d.danger && !d.missing
  const openable = state === 'completed' && !d.missing && !d.danger
  const running = state === 'progressing' || state === 'paused'
  const pct = running ? percentDone(d.receivedBytes, d.totalBytes) : undefined
  const host = displayHost(d.pageUrl || d.url)
  return (
    <div
      className={`archive-row dl-lib-row is-${state}${d.missing ? ' is-missing' : ''}${held ? ' is-held' : ''}${
        highlighted ? ' is-highlighted' : ''
      }`}
      style={{ transform: `translateY(${top}px)` } as CSSProperties}
      role="option"
      aria-selected={highlighted}
      data-testid="library-download"
      data-id={id}
      data-state={state}
      data-offset={offset}
      title={d.filename}
      draggable={openable}
      onDragStart={(e) => void dragOut(e, id)}
      onClick={(e) => openable && onOpen(d, e.metaKey || e.ctrlKey)}
      onContextMenu={(e) => onMenu(offset, d, e)}
    >
      <span className="archive-row__icon dl-lib-row__icon">
        {held ? <ShieldAlert size={16} /> : <FileThumb name={d.filename} url={d.fileUrl} size={20} />}
      </span>
      <span className="dl-lib-row__text">
        <span className="dl-lib-row__name" data-testid="library-download-name">
          {d.filename}
        </span>
        <span className="dl-lib-row__meta">
          <span className="dl-lib-row__status" data-testid="library-download-status">
            {statusText(d)}
          </span>
          {host && <span className="dl-lib-row__host"> · {host}</span>}
        </span>
      </span>
      <span className="dl-lib-row__end">
        <span className="dl-lib-row__time">{timeFormat.format(d.startedAt)}</span>
        <span className="dl-lib-row__actions">
          {held && (
            <>
              <TextButton
                label="Keep"
                testId="library-download-keep"
                onClick={() => void invoke('downloads.keep', { id })}
              />
              <TextButton
                label="Discard"
                testId="library-download-discard"
                onClick={() => void invoke('downloads.discard', { id })}
              />
            </>
          )}
          {state === 'paused' && (
            <IconButton label="Resume" testId="library-download-resume" onClick={() => resumeOrRetry(id)}>
              <Play size={14} />
            </IconButton>
          )}
          {state === 'interrupted' &&
            (d.canResume ? (
              <IconButton label="Resume" testId="library-download-resume" onClick={() => resumeOrRetry(id)}>
                <Play size={14} />
              </IconButton>
            ) : (
              <IconButton
                label="Retry"
                testId="library-download-retry"
                onClick={() => void invoke('downloads.retry', { id })}
              >
                <RotateCw size={14} />
              </IconButton>
            ))}
          {running && (
            <IconButton
              label="Cancel"
              testId="library-download-cancel"
              onClick={() => void invoke('downloads.cancel', { id })}
            >
              <X size={14} />
            </IconButton>
          )}
          {openable && (
            <IconButton
              label={isMac ? 'Show in Finder' : 'Show in Folder'}
              testId="library-download-show"
              onClick={() => void invoke('downloads.showInFolder', { id })}
            >
              <FolderOpen size={14} />
            </IconButton>
          )}
          <IconButton label="More" testId="library-download-more" onClick={(e) => onMenu(offset, d, e)}>
            <Ellipsis size={14} />
          </IconButton>
        </span>
      </span>
      {running && (
        <span className={`dl-lib-row__bar${pct === undefined ? ' is-indeterminate' : ''}`} aria-hidden>
          <span className="dl-lib-row__fill" style={pct !== undefined ? { width: `${pct}%` } : undefined} />
        </span>
      )}
    </div>
  )
})

function IconButton({
  label,
  testId,
  onClick,
  children,
}: {
  label: string
  testId: string
  onClick: (e: MouseEvent) => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="dl-lib-row__btn"
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation()
        onClick(e)
      }}
    >
      {children}
    </button>
  )
}

function TextButton({ label, testId, onClick }: { label: string; testId: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="dl-lib-row__text-btn"
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {label}
    </button>
  )
}

/**
 * The Downloads section of the Library (DL-10): everything downloaded in a profile, wherever it was
 * saved, newest first and by day, with search by name, in a virtualised list. A file Orbit can show
 * previews in a Peek over the Library (⌘/Ctrl-click: a new tab); others open in their app. Rows
 * drag out as the file (DL-06); their menu and buttons show, remove, delete, pause, resume, retry,
 * keep or discard (DL-04, DL-08, DL-12, DL-15). Clear all empties the list of finished downloads
 * (DL-08). The profile is the current Space's, with a switcher when there are several.
 */
export function DownloadsSection({ show }: LibrarySectionProps) {
  const win = useWindow()
  const spaceProfile = useOrbit((s) => (win ? s.spaces[win.spaceId]?.profileId : undefined)) ?? ''
  const profileList = useOrbit(profileLines)
  const profiles = useMemo(
    () =>
      profileList
        ? profileList.split('\u0001').map((line) => {
            const [id = '', name = ''] = line.split('\u0000')
            return { id, name }
          })
        : [],
    [profileList],
  )
  const [chosen, setChosen] = useState<string | undefined>()
  const profileId = chosen && profiles.some((p) => p.id === chosen) ? chosen : spaceProfile

  const [search, setSearch] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [highlight, setHighlight] = useState(0)
  const [keyboard, setKeyboard] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs for each open of the Library
  useEffect(() => {
    // A fresh open starts from the newest download of the Space's profile, with the search cleared.
    if (show.entering) {
      setChosen(undefined)
      setSearch('')
      setHighlight(0)
      setKeyboard(false)
      scrollerRef.current?.scrollTo({ top: 0 })
    }
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [show.nonce])
  useEffect(
    () =>
      window.orbit.on('library:find', () => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }),
    [],
  )

  const all = useDownloadsList(profileId, show.nonce)
  const rows = useMemo(() => (all ?? []).filter((d) => nameMatches(d.filename, search)), [all, search])
  const days = useMemo(() => byDay(rows.map((d) => d.startedAt)), [rows])
  const geometry = useMemo(() => listGeometry(days), [days])
  const finished = (all ?? []).some(
    (d) => d.state === 'completed' || d.state === 'cancelled' || d.state === 'interrupted',
  )

  // ---- Virtualised list ----
  const [viewport, setViewport] = useState({ top: 0, height: 0 })
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const update = () =>
      setViewport((v) =>
        v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight },
      )
    update()
    let raf = 0
    const onScroll = () => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0
          update()
        })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      observer.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [])
  const items = useMemo(
    () => visibleItems(geometry, viewport.top, Math.max(viewport.height, 400)),
    [geometry, viewport],
  )

  const total = rows.length
  const hl = total === 0 ? -1 : Math.min(highlight, total - 1)
  // biome-ignore lint/correctness/useExhaustiveDependencies: back to the top when the search or profile changes
  useEffect(() => {
    setHighlight(0)
    scrollerRef.current?.scrollTo({ top: 0 })
  }, [search, profileId])

  const scrollToOffset = useCallback(
    (offset: number) => {
      const el = scrollerRef.current
      if (!el) return
      const top = rowTop(geometry, offset)
      const headroom = offset > 0 && rowTop(geometry, offset - 1) + ROW_H < top ? HEAD_H : 0
      if (top - headroom < el.scrollTop) el.scrollTop = top - headroom
      else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight
    },
    [geometry],
  )

  const onOpen = useCallback((entry: DownloadEntry, tab: boolean) => {
    void invoke('downloads.preview', { id: entry.id, tab }).then((ok) => {
      if (!ok) libraryToast(`${entry.filename} is no longer there`)
    })
  }, [])
  const onMenu = useCallback((offset: number, entry: DownloadEntry, e: MouseEvent) => {
    e.preventDefault()
    setHighlight(offset)
    void invoke('downloads.menu', { id: entry.id })
  }, [])
  const clearAll = () => {
    void invoke('downloads.clear', { profileId }).then((count) => {
      libraryToast(count === 1 ? 'Cleared 1 download' : `Cleared ${count} downloads`)
    })
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (total === 0) return
      e.preventDefault()
      const next = Math.max(0, Math.min(total - 1, (hl < 0 ? -1 : hl) + (e.key === 'ArrowDown' ? 1 : -1)))
      setHighlight(next)
      setKeyboard(true)
      scrollToOffset(next)
      return
    }
    if (e.key === 'Enter') {
      const entry = hl >= 0 ? rows[hl] : undefined
      if (!entry || e.nativeEvent.isComposing) return
      e.preventDefault()
      if (entry.state === 'completed' && !entry.missing && !entry.danger) onOpen(entry, e.metaKey || e.ctrlKey)
      return
    }
    if (e.key === 'Escape' && search) {
      e.preventDefault()
      setSearch('')
    }
  }

  const now = Date.now()
  const showHighlight = keyboard || search.trim() !== ''
  const profileName = profiles.length > 1 ? profiles.find((p) => p.id === profileId)?.name : undefined

  return (
    <section className="archive dl-library" data-testid="downloads-section" onKeyDown={onKeyDown}>
      <header className="archive__header">
        <div className="archive__heading">
          <h1 className="archive__title">Downloads</h1>
          {profiles.length > 1 && (
            <select
              className="archive__select dl-library__profile"
              aria-label="Profile"
              title="Downloads of this profile"
              data-testid="downloads-profile"
              value={profileId}
              onChange={(e) => setChosen(e.target.value)}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              {!profiles.some((p) => p.id === profileId) && (
                <option value={profileId}>{profileName ?? 'Private'}</option>
              )}
            </select>
          )}
        </div>
        <div className="archive__toolbar">
          <label className="archive__search">
            <Search size={15} className="archive__search-icon" />
            <input
              ref={inputRef}
              className="archive__search-input"
              data-testid="downloads-search"
              placeholder="Search downloads"
              value={search}
              spellCheck={false}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                className="archive__search-clear"
                aria-label="Clear search"
                onClick={() => {
                  setSearch('')
                  inputRef.current?.focus()
                }}
              >
                <X size={13} />
              </button>
            )}
          </label>
          <button
            type="button"
            className="archive__button"
            data-testid="downloads-clear"
            disabled={!finished}
            title="Take finished downloads off the list (the files stay)"
            onClick={clearAll}
          >
            Clear all
          </button>
        </div>
      </header>
      <div
        ref={scrollerRef}
        className="archive__scroller"
        role="listbox"
        aria-label="Downloads"
        tabIndex={-1}
        data-testid="downloads-list"
        data-answered={all ? 'true' : 'false'}
      >
        <div className="archive__canvas" style={{ height: geometry.height }}>
          {items.map((item) => {
            if (item.kind === 'day') {
              return (
                <div
                  key={`d${item.at}`}
                  className="archive-day"
                  style={{ transform: `translateY(${item.top}px)` } as CSSProperties}
                  data-testid="downloads-day"
                  role="presentation"
                >
                  {dayLabel(item.at, now)}
                </div>
              )
            }
            const entry = rows[item.offset]
            if (!entry) return null
            return (
              <Row
                key={entry.id}
                entry={entry}
                offset={item.offset}
                top={item.top}
                highlighted={showHighlight && item.offset === hl}
                onOpen={onOpen}
                onMenu={onMenu}
              />
            )
          })}
        </div>
        {all && total === 0 && (
          <div className="archive__empty" data-testid="downloads-empty">
            {search.trim() ? (
              <p>No downloads match.</p>
            ) : (
              <>
                <p className="archive__empty-title">No downloads yet</p>
                <p>Files you download in this profile show up here.</p>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
