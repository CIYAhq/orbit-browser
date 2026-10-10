import { ArchiveRestore, RotateCcw, Search, X } from 'lucide-react'
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
import type { ArchiveClosedBy, ArchiveRestoreResult, ArchiveRow, ArchiveSource } from '../../../shared/commands/archive'
import type { SpaceId } from '../../../shared/state'
import { primaryColor } from '../../../shared/theme'
import { displayHost } from '../../../shared/url'
import { invoke } from '../api'
import { getOrbitState, useOrbit, useOrbitShallow, useWindow } from '../store'
import { Favicon } from '../ui/Favicon'
import { ArchiveListModel, filtersKey } from './archive-model'
import { ConfirmDialog } from './ConfirmDialog'
import { dayLabel, HEAD_H, type ListItem, listGeometry, ROW_H, rowRange, rowTop, visibleItems } from './geometry'
import { libraryToast } from './LibraryToasts'
import type { LibrarySectionProps } from './sections'

const SOURCES: { id: ArchiveSource; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'sidebar', label: 'Sidebar' },
  { id: 'mini', label: 'Mini Window' },
]

const CLOSED_BY: { id: ArchiveClosedBy; label: string }[] = [
  { id: 'any', label: 'Closed any way' },
  { id: 'manual', label: 'Closed by you' },
  { id: 'auto', label: 'Archived automatically' },
]

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

const REASON: Record<ArchiveRow['reason'], string> = {
  auto: 'Archived automatically',
  closed: 'Closed',
  cleared: 'Cleared',
}

/** Restored rows fade out and the rows below rise for this long (FL-09). */
const LEAVE_MS = 200

/** The open of the Library whose "Clear Archive…" was asked already (showing the section again asks no more). */
let askedClearNonce = -1

/** "Kept for 30 days", "kept forever" (AR-08). */
export function keptFor(days: number): string {
  if (!(days > 0)) return 'kept forever'
  if (days % 365 === 0) return days === 365 ? 'kept for a year' : `kept for ${days / 365} years`
  return `kept for ${days} days`
}

/** Empties a selection (keeping the same set when it is empty already, so nothing renders again). */
const clearSet = (set: ReadonlySet<string>): ReadonlySet<string> => (set.size ? new Set() : set)

/** The Space a row came from: its icon or colour, and its name. */
interface SpaceBadge {
  name: string
  icon?: string
  color?: string
}

/** Every Space's badge, made once per change to the Spaces (rows look theirs up). */
function useSpaceBadges(): ReadonlyMap<SpaceId, SpaceBadge> {
  const spaces = useOrbit((s) => s.spaces)
  return useMemo(() => {
    const out = new Map<SpaceId, SpaceBadge>()
    for (const [id, space] of Object.entries(spaces)) {
      if (!space) continue
      out.set(id as SpaceId, {
        name: space.name,
        ...(space.icon ? { icon: space.icon } : {}),
        ...(space.theme ? { color: primaryColor(space.theme) } : {}),
      })
    }
    return out
  }, [spaces])
}

interface RowProps {
  row: ArchiveRow | undefined
  /** The Space it came from; undefined when that Space is gone (the entry keeps its name). */
  space: SpaceBadge | undefined
  offset: number
  top: number
  highlighted: boolean
  selected: boolean
  leaving: boolean
  onRowClick: (offset: number, row: ArchiveRow, e: MouseEvent) => void
  onRestore: (row: ArchiveRow) => void
  onRowMenu: (offset: number, row: ArchiveRow, e: MouseEvent) => void
}

const Row = memo(function Row(props: RowProps) {
  const { row, top, highlighted, selected, leaving } = props
  const style = { transform: `translateY(${top}px)` } as CSSProperties
  if (!row) {
    return (
      <div className="archive-row archive-row--placeholder" style={style} aria-hidden>
        <span className="archive-row__skeleton" />
      </div>
    )
  }
  return (
    <LoadedRow {...props} row={row} style={style} highlighted={highlighted} selected={selected} leaving={leaving} />
  )
})

function LoadedRow(props: RowProps & { row: ArchiveRow; style: CSSProperties }) {
  const { row, offset, style, highlighted, selected, leaving } = props
  const space = props.space ?? { name: row.spaceName ?? 'Deleted Space' }
  const host = displayHost(row.url)
  const time = timeFormat.format(row.archivedAt)
  return (
    <div
      className={`archive-row${highlighted ? ' is-highlighted' : ''}${selected ? ' is-selected' : ''}${leaving ? ' is-leaving' : ''}`}
      style={style}
      role="option"
      aria-selected={selected}
      data-testid="archive-row"
      data-entry-id={row.id}
      data-offset={offset}
      // The search field keeps the keys: Enter after a preview restores this row.
      onMouseDown={(e) => {
        if (e.button === 0) e.preventDefault()
      }}
      onClick={(e) => props.onRowClick(offset, row, e)}
      onContextMenu={(e) => props.onRowMenu(offset, row, e)}
      onKeyDown={undefined}
      title={row.url}
    >
      <span className="archive-row__icon">
        <Favicon src={row.favicon} size={16} />
      </span>
      <span className="archive-row__text">
        <span className="archive-row__title" data-testid="archive-row-title">
          {row.title || row.url}
        </span>
        <span className="archive-row__host">{host}</span>
      </span>
      <span
        className="archive-row__space"
        title={`From ${space.name}`}
        data-testid="archive-row-space"
        style={{ '--dot': space.color } as CSSProperties}
      >
        {space.icon ? (
          <span className="archive-row__space-icon">{space.icon}</span>
        ) : (
          <span className="archive-row__dot" />
        )}
        <span className="archive-row__space-name">{space.name}</span>
      </span>
      <span
        className="archive-row__time"
        title={`${row.from === 'mini' ? 'Closed in a Mini Window' : row.from === 'peek' ? 'Closed preview' : REASON[row.reason]} at ${time}`}
      >
        {time}
      </span>
      <button
        type="button"
        className="archive-row__restore"
        data-testid="archive-restore"
        title="Put back in the sidebar"
        onClick={(e) => {
          e.stopPropagation()
          props.onRestore(row)
        }}
      >
        <ArchiveRestore size={14} />
        <span>Restore</span>
      </button>
    </div>
  )
}

function DayHeading({ item, now }: { item: Extract<ListItem, { kind: 'day' }>; now: number }) {
  return (
    <div
      className="archive-day"
      style={{ transform: `translateY(${item.top}px)` }}
      data-testid="archive-day"
      data-day={item.at}
      role="presentation"
    >
      <span className="archive-day__label">{dayLabel(item.at, now)}</span>
      <span className="archive-day__count">{item.count}</span>
    </div>
  )
}

/**
 * The Archive section of the Library (AR-03, AR-04, AR-05): the current profile's archived tabs,
 * newest first, grouped by day, with search and filters, in a virtualised list.
 */
export function ArchiveSection({ show }: LibrarySectionProps) {
  const win = useWindow()
  const spaceId = win?.spaceId
  const profileId = useOrbit((s) => (spaceId ? s.spaces[spaceId]?.profileId : undefined)) ?? ''
  const profileName = useOrbit((s) => {
    const persistent = Object.values(s.profiles).filter((p) => p.partition.startsWith('persist:'))
    return persistent.length > 1 ? s.profiles[profileId]?.name : undefined
  })
  const spaces = useOrbitShallow((s) => s.spaceOrder.filter((id) => s.spaces[id]?.profileId === profileId))
  const spaceNames = useOrbitShallow((s) => spaces.map((id) => s.spaces[id]?.name ?? ''))
  const spaceBadges = useSpaceBadges()
  const keepDays = useOrbit((s) => s.settings.archiveKeepDays)
  const [text, setText] = useState('')
  const [source, setSource] = useState<ArchiveSource>('all')
  const [spaceFilter, setSpaceFilter] = useState<SpaceId | ''>('')
  const [closedBy, setClosedBy] = useState<ArchiveClosedBy>('any')
  const spaceShown = spaceFilter && spaces.includes(spaceFilter) ? spaceFilter : ''

  const model = useMemo(() => new ArchiveListModel((q) => invoke('archive.query', q)), [])
  const data = useSyncExternalStore(model.subscribe, model.getSnapshot)
  const filters = useMemo(
    () => ({ text, source, profileId, closedBy, ...(spaceShown ? { spaceId: spaceShown } : {}) }),
    [text, source, profileId, closedBy, spaceShown],
  )
  const key = filtersKey(filters)
  useEffect(() => {
    if (filters.profileId) model.setFilters(filters)
  }, [model, filters])

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
    if (range) model.setRange(range[0], range[1])
  }, [model, items])

  // ---- Highlight (keyboard) and selection (click, ⌘-click, ⇧-click) ----
  const [highlight, setHighlight] = useState(0)
  const [keyboard, setKeyboard] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const anchor = useRef(0)
  const hl = data.total === 0 ? -1 : Math.min(highlight, data.total - 1)
  // New filters: back to the top match (AR-04: Enter takes the top match).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the filters change
  useEffect(() => {
    setHighlight(0)
    setSelected(clearSet)
    scrollerRef.current?.scrollTo({ top: 0 })
  }, [key])

  // ---- Clear Archive (AR-07): always asked here first, from the menu, the command bar or the list ----
  const [clearAsk, setClearAsk] = useState<{ count: number } | null>(null)
  // The profile shown here is the one asked about and cleared (main picks the window's otherwise).
  const shownProfile = profileId ? { profileId } : {}
  const askClear = async () => {
    const page = await invoke('archive.query', { ...shownProfile, limit: 1 })
    if (page.total === 0) libraryToast('The Archive is already empty')
    else setClearAsk({ count: page.total })
  }
  const clearArchive = async () => {
    setClearAsk(null)
    const n = await invoke('archive.clear', shownProfile)
    libraryToast(n === 1 ? 'Cleared 1 archived tab' : `Cleared ${n.toLocaleString()} archived tabs`)
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs for each open of the Library
  useEffect(() => {
    // A fresh open starts from the whole list, at its top match; the filters stay as they were.
    if (show.entering) {
      setText('')
      setHighlight(0)
      setSelected(clearSet)
      scrollerRef.current?.scrollTo({ top: 0 })
    }
    inputRef.current?.focus()
    inputRef.current?.select()
    if (show.confirmClear && show.nonce !== askedClearNonce) {
      askedClearNonce = show.nonce
      void askClear()
    }
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

  // ---- Restore (AR-05) ----
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set())
  const [animate, setAnimate] = useState(false)
  const animateTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  /** The list waits for leaving rows to fade before it closes the gap (FL-09). */
  const holdUntil = useRef(0)
  const leave = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return
    holdUntil.current = Math.max(holdUntil.current, Date.now() + LEAVE_MS)
    setLeaving((set) => (ids.every((id) => set.has(id)) ? set : new Set([...set, ...ids])))
    // The rows below rise into the gap when the list answers without them.
    setAnimate(true)
    clearTimeout(animateTimer.current)
    animateTimer.current = setTimeout(() => setAnimate(false), LEAVE_MS + 400)
    setSelected((set) => (ids.some((id) => set.has(id)) ? new Set() : set))
    setTimeout(
      () =>
        setLeaving((set) => {
          const next = new Set(set)
          for (const id of ids) next.delete(id)
          return next
        }),
      LEAVE_MS + 300,
    )
  }, [])
  const restore = useCallback(
    (ids: string[], open: boolean) => {
      if (ids.length === 0) return
      leave(ids)
      void invoke('archive.restore', { ids, open })
    },
    [leave],
  )
  useEffect(() => {
    const offChanged = window.orbit.on('archive.changed', (payload) => {
      const version = (payload as { version: number }).version
      const wait = holdUntil.current - Date.now()
      if (wait > 0) setTimeout(() => model.changed(version), wait)
      else model.changed(version)
    })
    // Main says which entries went back (from here or the row menu), so a toast can say where (AR-05).
    const offRestored = window.orbit.on('archive:restored', (payload) => {
      const result = payload as ArchiveRestoreResult
      leave(result.ids)
      const state = getOrbitState()
      const here = state.windows[window.orbit.windowId]?.spaceId
      const away = result.spaceIds
        .map((spaceId, i) => ({ spaceId, tabId: result.tabIds[i] }))
        .filter((r) => r.spaceId !== here)
      const spaces = [...new Set(away.map((r) => r.spaceId))]
      const target = spaces[0]
      if (!target) return
      if (spaces.length > 1) {
        libraryToast(`${away.length} tabs restored to ${spaces.length} Spaces`)
        return
      }
      const name = state.spaces[target]?.name ?? 'another Space'
      const tabId = away.length === 1 ? away[0]?.tabId : undefined
      libraryToast(away.length > 1 ? `${away.length} tabs restored to ${name}` : `Restored to ${name}`, {
        label: 'Go to Space',
        run: () => void (tabId ? invoke('tabs.activate', { tabId }) : invoke('spaces.switch', { spaceId: target })),
      })
    })
    // Entries deleted from the row menu leave the selection.
    const offDeleted = window.orbit.on('archive:deleted', (payload) => {
      const ids = (payload as { ids: string[] }).ids
      setSelected((set) => {
        if (!ids.some((id) => set.has(id))) return set
        const next = new Set(set)
        for (const id of ids) next.delete(id)
        return next
      })
    })
    return () => {
      offChanged()
      offRestored()
      offDeleted()
    }
  }, [model, leave])

  // Row callbacks read the selection through a ref, so they stay the same and rows only render
  // again when what they show changes.
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const selectionIds = useCallback((row: ArchiveRow): string[] => {
    const set = selectedRef.current
    return set.has(row.id) && set.size > 1 ? [...set] : [row.id]
  }, [])

  const onRowClick = useCallback(
    (offset: number, row: ArchiveRow, e: MouseEvent) => {
      setHighlight(offset)
      setKeyboard(false)
      if (e.metaKey || e.ctrlKey) {
        setSelected((set) => {
          const next = new Set(set)
          if (next.has(row.id)) next.delete(row.id)
          else next.add(row.id)
          return next
        })
        anchor.current = offset
        return
      }
      if (e.shiftKey) {
        const [from, to] = anchor.current < offset ? [anchor.current, offset] : [offset, anchor.current]
        const ids = new Set<string>()
        for (let o = from; o <= to; o++) {
          const id = model.row(o)?.id
          if (id) ids.add(id)
        }
        setSelected(ids)
        return
      }
      anchor.current = offset
      setSelected(new Set([row.id]))
      // A click previews the page over the Library (AR-06); the Restore button puts it back. The
      // second click of a double click is not another preview.
      if (e.detail > 1) return
      const failed = () => libraryToast('This tab can’t be previewed here')
      invoke('archive.preview', { id: row.id })
        .then((shown) => {
          if (shown === null) failed()
        })
        .catch(failed)
    },
    [model],
  )
  const onRestore = useCallback((row: ArchiveRow) => restore(selectionIds(row), false), [restore, selectionIds])
  const onRowMenu = useCallback(
    (offset: number, row: ArchiveRow, e: MouseEvent) => {
      e.preventDefault()
      setHighlight(offset)
      const ids = selectionIds(row)
      if (!selectedRef.current.has(row.id)) setSelected(new Set([row.id]))
      void invoke('archive.contextMenu', { ids, x: Math.round(e.clientX), y: Math.round(e.clientY) })
    },
    [selectionIds],
  )

  const onKeyDown = (e: KeyboardEvent) => {
    const total = data.total
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (total === 0) return
      e.preventDefault()
      const next = Math.max(0, Math.min(total - 1, (hl < 0 ? -1 : hl) + (e.key === 'ArrowDown' ? 1 : -1)))
      setHighlight(next)
      setKeyboard(true)
      anchor.current = next
      if (!e.shiftKey) setSelected(clearSet)
      scrollToOffset(next)
      return
    }
    if (e.key === 'Enter') {
      const row = hl >= 0 ? model.row(hl) : undefined
      if (!row) return
      e.preventDefault()
      // Enter puts the top match (or the highlighted entry) back and shows it (AR-04).
      restore(selected.size > 1 && selected.has(row.id) ? [...selected] : [row.id], true)
      return
    }
    if (e.key === 'Escape') {
      if (text) {
        e.preventDefault()
        setText('')
      } else if (selected.size > 0) {
        e.preventDefault()
        setSelected(new Set())
      }
    }
  }

  const now = Date.now()
  const showHighlight = keyboard || text.trim() !== ''
  const empty = !data.loading && data.key === key && data.total === 0
  const filtered = text.trim() !== '' || source !== 'all' || spaceShown !== '' || closedBy !== 'any'

  return (
    <section className="archive" data-testid="archive-section" onKeyDown={onKeyDown}>
      <header className="archive__header">
        <div className="archive__heading">
          <h1 className="archive__title">Archive</h1>
          {profileName && (
            <span className="archive__profile" title="Archived tabs of this profile">
              {profileName}
            </span>
          )}
          <span className="archive__count" data-testid="archive-count">
            {data.key === key ? data.total.toLocaleString() : ''}
          </span>
        </div>
        <div className="archive__toolbar">
          <label className="archive__search">
            <Search size={15} className="archive__search-icon" />
            <input
              ref={inputRef}
              className="archive__search-input"
              data-testid="archive-search"
              placeholder="Search archived tabs"
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
          <button
            type="button"
            className="archive__button"
            data-testid="archive-recently-closed"
            title="Reopen a recently closed tab"
            aria-haspopup="menu"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              void invoke('archive.recentlyClosedMenu', { x: r.left, y: r.bottom + 4 })
            }}
          >
            <RotateCcw size={14} />
            <span>Recently Closed</span>
          </button>
        </div>
        <div className="archive__filters">
          <fieldset className="archive__segments" aria-label="Show">
            {SOURCES.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`archive__segment${source === s.id ? ' is-active' : ''}`}
                aria-pressed={source === s.id}
                data-testid={`archive-source-${s.id}`}
                onClick={() => setSource(s.id)}
              >
                {s.label}
              </button>
            ))}
          </fieldset>
          <select
            className="archive__select"
            aria-label="Space"
            data-testid="archive-space-filter"
            value={spaceShown}
            onChange={(e) => setSpaceFilter(e.target.value)}
          >
            <option value="">All Spaces</option>
            {spaces.map((id, i) => (
              <option key={id} value={id}>
                {spaceNames[i]}
              </option>
            ))}
          </select>
          <select
            className="archive__select"
            aria-label="How the tabs closed"
            data-testid="archive-closed-filter"
            value={closedBy}
            onChange={(e) => setClosedBy(e.target.value as ArchiveClosedBy)}
          >
            {CLOSED_BY.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        {selected.size > 1 && (
          <div className="archive__selection" data-testid="archive-selection">
            <span>{selected.size} selected</span>
            <button type="button" onClick={() => restore([...selected], false)} data-testid="archive-restore-selected">
              Restore
            </button>
            <button
              type="button"
              onClick={() => void invoke('archive.delete', { ids: [...selected] }).then(() => setSelected(new Set()))}
            >
              Delete
            </button>
            <button type="button" onClick={() => setSelected(new Set())}>
              Cancel
            </button>
          </div>
        )}
      </header>
      <div
        ref={scrollerRef}
        className={`archive__scroller${animate ? ' is-animating' : ''}`}
        role="listbox"
        aria-label="Archived tabs"
        aria-multiselectable
        tabIndex={-1}
        data-testid="archive-list"
        data-answered={data.key === key ? 'true' : 'false'}
        data-query={text}
      >
        <div className="archive__canvas" style={{ height: geometry.height }}>
          {items.map((item) =>
            item.kind === 'day' ? (
              <DayHeading key={`d${item.at}`} item={item} now={now} />
            ) : (
              <Row
                key={model.row(item.offset)?.id ?? `p${item.offset}`}
                row={model.row(item.offset)}
                space={spaceBadges.get(model.row(item.offset)?.spaceId as SpaceId)}
                offset={item.offset}
                top={item.top}
                highlighted={showHighlight && item.offset === hl}
                selected={(() => {
                  const id = model.row(item.offset)?.id
                  return !!id && selected.has(id)
                })()}
                leaving={(() => {
                  const id = model.row(item.offset)?.id
                  return !!id && leaving.has(id)
                })()}
                onRowClick={onRowClick}
                onRestore={onRestore}
                onRowMenu={onRowMenu}
              />
            ),
          )}
        </div>
        {empty && (
          <div className="archive__empty" data-testid="archive-empty">
            {filtered ? (
              <p>No archived tabs match.</p>
            ) : (
              <>
                <p className="archive__empty-title">Nothing in the Archive</p>
                <p>Tabs you close, clear or that are archived after a while show up here.</p>
                <p data-testid="archive-kept-for">They are {keptFor(keepDays)}.</p>
              </>
            )}
          </div>
        )}
      </div>
      {clearAsk && (
        <ConfirmDialog
          title="Clear the Archive?"
          confirmLabel="Clear Archive"
          destructive
          testId="archive-clear"
          onConfirm={() => void clearArchive()}
          onCancel={() => setClearAsk(null)}
        >
          <p>
            {clearAsk.count === 1 ? 'The archived tab' : `All ${clearAsk.count.toLocaleString()} archived tabs`}
            {profileName ? ` in ${profileName}` : ''} will be deleted. This can’t be undone.
          </p>
          <p>Your browsing history is kept.</p>
        </ConfirmDialog>
      )}
    </section>
  )
}
