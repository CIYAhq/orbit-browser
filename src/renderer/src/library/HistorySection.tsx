import { Search, X } from 'lucide-react'
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { LibraryHistoryQuery } from '../../../shared/commands/archive'
import type { HistoryVisit } from '../../../shared/commands/history'
import { displayHost } from '../../../shared/url'
import { invoke } from '../api'
import { useOrbit, useWindow } from '../store'
import { Favicon } from '../ui/Favicon'
import { dayLabel, HEAD_H, type ListItem, listGeometry, ROW_H, rowRange, rowTop, visibleItems } from './geometry'
import { HistoryListModel, type HistoryRow, historyKey } from './history-model'
import { libraryToast } from './LibraryToasts'
import type { LibrarySectionProps } from './sections'

/**
 * What the list asks of main: the Library's commands, or the History page's (AR-10, pages lane),
 * which are about its own tab's profile only. `profileId` is the profile shown, '' if not known yet.
 */
export interface HistoryCalls {
  visits: (q: LibraryHistoryQuery) => Promise<HistoryVisit[]>
  open: (url: string, background: boolean) => Promise<unknown>
  remove: (url: string, profileId: string) => Promise<unknown>
  menu: (url: string, profileId: string, x: number, y: number) => Promise<unknown>
}

const profileArg = (profileId: string) => (profileId ? { profileId } : {})

const LIBRARY_CALLS: HistoryCalls = {
  visits: (q) => invoke('library.history', q),
  open: (url, background) => invoke('tabs.create', { url, activate: !background }),
  remove: (url, profileId) => invoke('history.delete', { ...profileArg(profileId), url }),
  menu: (url, profileId, x, y) => invoke('library.historyMenu', { ...profileArg(profileId), url, x, y }),
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
/** Typing settles this long before the history is searched (a search reads every visit). */
const SEARCH_DELAY_MS = 60

interface RowProps {
  row: HistoryRow
  offset: number
  top: number
  highlighted: boolean
  onOpen: (row: HistoryRow, background: boolean) => void
  onRemove: (row: HistoryRow) => void
  onMenu: (offset: number, row: HistoryRow, e: MouseEvent) => void
}

const Row = memo(function Row({ row, offset, top, highlighted, onOpen, onRemove, onMenu }: RowProps) {
  const time = timeFormat.format(row.at)
  return (
    <div
      className={`archive-row history-row${highlighted ? ' is-highlighted' : ''}`}
      style={{ transform: `translateY(${top}px)` } as CSSProperties}
      role="option"
      aria-selected={highlighted}
      data-testid="history-row"
      data-url={row.url}
      data-offset={offset}
      title={row.url}
      onClick={(e) => onOpen(row, e.metaKey || e.ctrlKey || e.shiftKey)}
      onAuxClick={(e) => {
        if (e.button === 1) onOpen(row, true)
      }}
      onContextMenu={(e) => onMenu(offset, row, e)}
    >
      <span className="archive-row__icon">
        <Favicon src={row.favicon} size={16} />
      </span>
      <span className="archive-row__text">
        <span className="archive-row__title" data-testid="history-row-title">
          {row.title || row.url}
        </span>
        <span className="archive-row__host">{displayHost(row.url)}</span>
      </span>
      <span className="archive-row__time history-row__time">{time}</span>
      <button
        type="button"
        className="history-row__remove"
        data-testid="history-remove"
        title="Remove from History"
        aria-label="Remove from History"
        onClick={(e) => {
          e.stopPropagation()
          onRemove(row)
        }}
      >
        <X size={14} />
      </button>
    </div>
  )
})

function DayHeading({ item, now }: { item: Extract<ListItem, { kind: 'day' }>; now: number }) {
  return (
    <div
      className="archive-day"
      style={{ transform: `translateY(${item.top}px)` } as CSSProperties}
      data-testid="history-day"
      role="presentation"
    >
      {dayLabel(item.at, now)}
    </div>
  )
}

/**
 * The History section of the Library (AR-10): every page visit of the current profile, newest
 * first, by day, with search, in a virtualised list. A row opens its page in a new tab (⌘-click or
 * the middle button: behind the Library); its × or its menu removes the page from history. The
 * Archive is separate: it lists the tabs that left the sidebar. The History page (`orbit://history/`)
 * shows it too, with its own `calls`.
 */
export function HistorySection({ show, calls = LIBRARY_CALLS }: LibrarySectionProps & { calls?: HistoryCalls }) {
  const win = useWindow()
  const spaceId = win?.spaceId
  const profileId = useOrbit((s) => (spaceId ? s.spaces[spaceId]?.profileId : undefined)) ?? ''
  const profileName = useOrbit((s) => {
    const persistent = Object.values(s.profiles).filter((p) => p.partition.startsWith('persist:'))
    return persistent.length > 1 ? s.profiles[profileId]?.name : undefined
  })
  const [text, setText] = useState('')
  const [search, setSearch] = useState('')
  useEffect(() => {
    if (text.trim() === search.trim()) return
    const timer = setTimeout(() => setSearch(text), text.trim() ? SEARCH_DELAY_MS : 0)
    return () => clearTimeout(timer)
  }, [text, search])

  const model = useMemo(() => new HistoryListModel((q) => calls.visits(q)), [calls])
  const data = useSyncExternalStore(model.subscribe, model.getSnapshot)
  useEffect(() => {
    if (profileId) model.setSearch(profileId, search)
  }, [model, profileId, search])
  const key = historyKey(profileId, search)

  // ---- Focus: the search field takes the keys on each open and on ⌘F ----
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(
    () =>
      window.orbit.on('library:find', () => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }),
    [],
  )

  // ---- Virtualised list ----
  const scrollerRef = useRef<HTMLDivElement>(null)
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
  const geometry = useMemo(() => listGeometry(data.days), [data.days])
  const items = useMemo(
    () => visibleItems(geometry, viewport.top, Math.max(viewport.height, 400)),
    [geometry, viewport],
  )
  useEffect(() => {
    const range = rowRange(items)
    if (range) model.shown(range[1])
  }, [model, items])

  const opened = useRef(false)

  // ---- Highlight: the top match first (Enter opens it), then the arrow keys ----
  const [highlight, setHighlight] = useState(0)
  const [keyboard, setKeyboard] = useState(false)
  const total = data.rows.length
  const hl = total === 0 ? -1 : Math.min(highlight, total - 1)
  // biome-ignore lint/correctness/useExhaustiveDependencies: back to the top when the search changes
  useEffect(() => {
    setHighlight(0)
    scrollerRef.current?.scrollTo({ top: 0 })
  }, [key])

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs for each open of the Library
  useEffect(() => {
    // A fresh open starts from the newest visit, with the search cleared; pages were visited since
    // (the first open is fetched by the search above).
    if (show.entering) {
      setText('')
      setSearch('')
      setHighlight(0)
      setKeyboard(false)
      scrollerRef.current?.scrollTo({ top: 0 })
    }
    if (opened.current) void model.reload()
    opened.current = true
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [show.nonce])

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

  // ---- Open and remove ----
  const onOpen = useCallback(
    (row: HistoryRow, background: boolean) => {
      // Shown: the Library makes way for the new tab. Behind: the Library stays for more.
      void calls.open(row.url, background).then(() => {
        if (background) libraryToast('Opened in a new tab')
      })
    },
    [calls],
  )
  const onRemove = useCallback(
    (row: HistoryRow) => {
      // Main deletes before it answers the next page the list may ask for.
      void calls.remove(row.url, profileId)
      model.remove(row.url)
    },
    [calls, model, profileId],
  )
  const onMenu = useCallback(
    (offset: number, row: HistoryRow, e: MouseEvent) => {
      e.preventDefault()
      setHighlight(offset)
      void calls.menu(row.url, profileId, Math.round(e.clientX), Math.round(e.clientY))
    },
    [calls, profileId],
  )
  // The row menu's Remove from History (main removed the page).
  useEffect(
    () =>
      window.orbit.on('library:history.removed', (payload) => {
        const url = (payload as { url?: unknown }).url
        if (typeof url === 'string') model.remove(url)
      }),
    [model],
  )

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
      const row = hl >= 0 ? data.rows[hl] : undefined
      if (!row || e.nativeEvent.isComposing) return
      e.preventDefault()
      onOpen(row, e.metaKey || e.ctrlKey)
      return
    }
    if (e.key === 'Escape' && text) {
      e.preventDefault()
      setText('')
    }
  }

  const now = Date.now()
  const showHighlight = keyboard || search.trim() !== ''
  const empty = !data.loading && data.key === key && total === 0

  return (
    <section className="archive history" data-testid="history-section" onKeyDown={onKeyDown}>
      <header className="archive__header">
        <div className="archive__heading">
          <h1 className="archive__title">History</h1>
          {profileName && (
            <span className="archive__profile" title="Pages visited in this profile">
              {profileName}
            </span>
          )}
        </div>
        <div className="archive__toolbar">
          <label className="archive__search">
            <Search size={15} className="archive__search-icon" />
            <input
              ref={inputRef}
              className="archive__search-input"
              data-testid="history-search"
              placeholder="Search history"
              value={text}
              spellCheck={false}
              onChange={(e) => setText(e.target.value)}
            />
            {text && (
              <button
                type="button"
                className="archive__search-clear"
                aria-label="Clear search"
                onClick={() => {
                  setText('')
                  inputRef.current?.focus()
                }}
              >
                <X size={13} />
              </button>
            )}
          </label>
        </div>
      </header>
      <div
        ref={scrollerRef}
        className="archive__scroller"
        role="listbox"
        aria-label="Pages visited"
        tabIndex={-1}
        data-testid="history-list"
        data-answered={data.key === key && !data.loading ? 'true' : 'false'}
        data-query={search}
      >
        <div className="archive__canvas" style={{ height: geometry.height }}>
          {items.map((item) => {
            if (item.kind === 'day') return <DayHeading key={`d${item.at}`} item={item} now={now} />
            const row = data.rows[item.offset]
            if (!row) return null
            return (
              <Row
                key={row.key}
                row={row}
                offset={item.offset}
                top={item.top}
                highlighted={showHighlight && item.offset === hl}
                onOpen={onOpen}
                onRemove={onRemove}
                onMenu={onMenu}
              />
            )
          })}
        </div>
        {empty && (
          <div className="archive__empty" data-testid="history-empty">
            {search.trim() ? (
              <p>No pages match.</p>
            ) : (
              <>
                <p className="archive__empty-title">No history yet</p>
                <p>Pages you visit in this profile show up here.</p>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
