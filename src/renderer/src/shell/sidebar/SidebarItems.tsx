import { ArrowDown, ArrowUp, ChevronDown, Plus } from 'lucide-react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import {
  memo,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { isFolderId, isTabId } from '../../../../shared/ids'
import type { Space, SpaceId } from '../../../../shared/state'
import { containerKey, locate, sectionOf, splitOfTab } from '../../../../shared/tree'
import { engineForSpace, parseInput } from '../../../../shared/url'
import { invoke, isMac, runAction } from '../../api'
import { activeTabId } from '../../selectors'
import { getOrbitState, useOrbit } from '../../store'
import { DragGhost } from './DragGhost'
import { setDragContext } from './drag'
import { Favorites } from './Favorites'
import { FolderSearch } from './FolderSearch'
import { IconPicker } from './IconPicker'
import { ItemList, TabRow, useRowShift } from './ItemList'
import { clearSelection, startRename, useDrag, useIconPicker, useKeyboardFocus, useSelection } from './ui-state'

/**
 * Everything between the address bar and the Space switcher (SB-02 regions 3–9):
 * Favorites, then one scrolling list with the Space title, pinned section, divider with
 * Clear, "+ New Tab" and Today. Owns drag and drop, keyboard navigation and auto-reveal.
 */
export const SidebarItems = memo(function SidebarItems({
  spaceId,
  header,
  onContextMenu,
  simple = false,
}: {
  spaceId: SpaceId
  /** The Space title row (owned by the Spaces lane), drawn at the top of the scrolling list. */
  header?: ReactNode
  /** Right-click on empty list space (rows handle their own menus first). */
  onContextMenu?: (e: ReactMouseEvent) => void
  /** A private window's list (SB-25): Today only, no Favorites or pinned section. */
  simple?: boolean
}) {
  const space = useOrbit((s) => s.spaces[spaceId])
  const active = useOrbit((s) => activeTabId(s))
  const scrollRef = useRef<HTMLDivElement>(null)
  const favRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!space) return
    setDragContext({
      scroll: scrollRef.current,
      favorites: favRef.current,
      sidebar: rootRef.current?.closest<HTMLElement>('.sidebar') ?? rootRef.current,
      spaceId: space.id,
      profileId: space.profileId,
    })
  })

  useMainMessages(scrollRef)
  useShellUndo()
  // A selection belongs to what the window shows: switching Space, or selecting a tab outside it,
  // ends it (lane review MF-3).
  const shownSpace = useRef(spaceId)
  useEffect(() => {
    if (shownSpace.current === spaceId) return
    shownSpace.current = spaceId
    clearSelection()
  }, [spaceId])
  useEffect(() => {
    const ids = useSelection.getState().ids
    if (active && ids.length > 0 && !ids.includes(active)) clearSelection()
  }, [active])
  useScrollMemory(scrollRef, spaceId)
  const reveal = useAutoReveal(scrollRef, active)
  const onKeyDown = useKeyboardNav(scrollRef)
  if (!space) return null

  return (
    <MotionConfig reducedMotion="user">
      <div className="sidebar-items" ref={rootRef}>
        {!simple && (
          <div className="sidebar-items__favorites" data-favorites-layer>
            <Favorites ref={favRef} profileId={space.profileId} />
          </div>
        )}
        <div
          className="sidebar__scroll"
          ref={scrollRef}
          data-testid="sidebar-scroll"
          tabIndex={-1}
          role="tree"
          aria-label="Tabs"
          onKeyDown={onKeyDown}
          onDragOver={onLinkDragOver}
          onDrop={(e) => onLinkDrop(e, space.id)}
          onContextMenu={(e) => {
            if (!e.defaultPrevented) onContextMenu?.(e)
          }}
        >
          {simple ? header : <SpaceHeader space={space}>{header}</SpaceHeader>}
          {!simple && <PinnedSection space={space} />}
          <TodayBlock space={space} />
          <ItemList
            key={`today:${space.id}`}
            containerKey={`today:${space.id}`}
            items={space.today}
            testId="today-list"
          />
          <div
            className="sidebar__fill"
            data-testid="sidebar-empty-area"
            onDoubleClick={() => runAction('tab.new')}
            onPointerDown={() => clearSelection()}
          />
        </div>
        {reveal && (
          <button
            type="button"
            className={`reveal-pill reveal-pill--${reveal.side}`}
            data-testid="reveal-active"
            onClick={reveal.go}
          >
            {reveal.side === 'above' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
            <span>Current tab</span>
          </button>
        )}
        <IconPicker />
        <FolderSearch />
        <DragGhost />
      </div>
    </MotionConfig>
  )
})

/** Space title row with the pinned-section caret (PN-09). */
function SpaceHeader({ space, children }: { space: Space; children: ReactNode }) {
  const activePinned = useOrbit((s) => {
    const a = activeTabId(s)
    return !!a && sectionOf(s, a) === 'pinned'
  })
  const collapsed = !!space.pinnedCollapsed
  return (
    <div
      className={`space-header${collapsed ? ' is-collapsed' : ''}${collapsed && activePinned ? ' has-hidden-active' : ''}`}
      data-testid="space-header"
    >
      {children}
      <button
        type="button"
        className="space-header__caret"
        data-testid="pinned-toggle"
        aria-label={collapsed ? 'Expand pinned tabs' : 'Collapse pinned tabs'}
        aria-expanded={!collapsed}
        title={collapsed ? 'Expand Pinned' : 'Collapse Pinned'}
        onClick={() => void invoke('tabs.setPinnedCollapsed', { spaceId: space.id, collapsed: !collapsed })}
      >
        <motion.span
          className="space-header__caret-glyph"
          initial={false}
          animate={{ rotate: collapsed ? -90 : 0 }}
          transition={{ duration: 0.16 }}
        >
          <ChevronDown size={13} />
        </motion.span>
      </button>
    </div>
  )
}

/** Pinned tabs and folders (PN-01); collapsed, only the selected pinned tab stays visible (PN-09). */
const PinnedSection = memo(function PinnedSection({ space }: { space: Space }) {
  const collapsed = !!space.pinnedCollapsed
  // Primitive selector result (a fresh object per call would re-render forever).
  const peekKey = useOrbit((s) => {
    if (!collapsed) return null
    const a = activeTabId(s)
    if (!a || sectionOf(s, a) !== 'pinned' || s.tabs[a]?.spaceId !== space.id) return null
    const loc = locate(s, a)
    return loc ? `${a}|${containerKey(loc.container)}|${loc.index}` : null
  })
  const [peekId, peekContainer, peekIndex] = peekKey ? peekKey.split('|') : []
  const peek = peekId && peekContainer ? { id: peekId, key: peekContainer, index: Number(peekIndex) } : null
  return (
    <>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="pinned"
            className="pinned-section"
            initial={{ height: 0, opacity: 0 }}
            animate={{
              height: 'auto',
              opacity: 1,
              transition: { height: { duration: 0.2 }, opacity: { duration: 0.12 } },
            }}
            exit={{ height: 0, opacity: 0, transition: { height: { duration: 0.18 }, opacity: { duration: 0.1 } } }}
          >
            <ItemList
              key={`pinned:${space.id}`}
              containerKey={`pinned:${space.id}`}
              items={space.pinned}
              testId="pinned-list"
            />
          </motion.div>
        )}
      </AnimatePresence>
      {peek && (
        <div className="pinned-peek" data-testid="pinned-peek">
          <TabRow tabId={peek.id} depth={0} containerKey={peek.key} index={peek.index} ancestors="" />
        </div>
      )}
    </>
  )
})

/** Divider with Clear (TD-04) and the "+ New Tab" row (SB-07): one drop slot between pinned and Today. */
function TodayBlock({ space }: { space: Space }) {
  const y = useRowShift('divider')
  const hasToday = space.today.length > 0
  return (
    <motion.div
      className="today-block"
      style={{ y }}
      data-slot="divider"
      data-key="divider"
      data-container={`today:${space.id}`}
      data-index={0}
      data-depth={0}
    >
      <div className="sidebar__divider" data-testid="today-divider">
        <span className="sidebar__divider-line" />
        {hasToday && (
          <button
            type="button"
            className="sidebar__clear"
            data-testid="clear-today"
            title={`Archive all Today tabs (${isMac ? '⌘⇧K' : 'Ctrl+Shift+K'})`}
            onClick={() => void invoke('tabs.clearToday', { spaceId: space.id })}
          >
            <ArrowDown size={11} strokeWidth={2.4} />
            <span>Clear</span>
          </button>
        )}
      </div>
      <button
        type="button"
        className="new-tab-button"
        data-testid="new-tab-button"
        onClick={() => runAction('tab.new')}
      >
        <motion.span className="new-tab-button__plus" whileTap={{ scale: 0.92 }} transition={{ duration: 0.15 }}>
          <Plus size={16} strokeWidth={2} />
        </motion.span>
        <span>New Tab</span>
      </button>
    </motion.div>
  )
}

// ---- Links dropped on the sidebar open as new tabs (TB-02) ----

function onLinkDragOver(e: ReactDragEvent) {
  if (useDrag.getState().phase !== 'idle') return
  const types = e.dataTransfer.types
  if (types.includes('text/uri-list') || types.includes('text/plain')) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
}

function onLinkDrop(e: ReactDragEvent, spaceId: string) {
  const uri = e.dataTransfer
    .getData('text/uri-list')
    .split('\n')
    .find((l) => l && !l.startsWith('#'))
  const text = uri?.trim() || e.dataTransfer.getData('text/plain').trim()
  if (!text) return
  e.preventDefault()
  const parsed = parseInput(text, engineForSpace(getOrbitState(), spaceId))
  void invoke('tabs.create', { url: parsed.url, spaceId })
}

// ---- Messages from main (context menu items that need the sidebar) ----

function useMainMessages(scrollRef: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const offs = [
      window.orbit.on('sidebar:rename', (p) => {
        const { id, isNew } = p as { id: string; isNew?: boolean }
        startRename(id, { isNew })
        requestAnimationFrame(() =>
          scrollRef.current
            ?.querySelector(`[data-slot][data-key="${id}"]`)
            ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
        )
      }),
      window.orbit.on('sidebar:edit-pinned-url', (p) => startRename((p as { id: string }).id, { mode: 'url' })),
      window.orbit.on('sidebar:icon', (p) => useIconPicker.setState({ id: (p as { id: string }).id })),
      window.orbit.on('sidebar:clear-selection', () => clearSelection()),
      window.orbit.on('sidebar:focus', () => {
        const el = scrollRef.current
        if (!el) return
        el.focus()
        const state = getOrbitState()
        useKeyboardFocus.setState({ id: activeTabId(state) ?? firstRowKey(el) })
      }),
    ]
    return () => {
      for (const off of offs) off()
    }
  }, [scrollRef])
}

/** ⌘Z with focus in Orbit's UI (not a text field) undoes the last sidebar change (TB-18). */
function useShellUndo() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      if (e.key === 'Escape') {
        clearSelection()
        return
      }
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      if (mod && !e.altKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        void invoke(e.shiftKey ? 'tabs.redo' : 'tabs.undo', {})
      }
    }
    // Releasing Control settles a recent-tab switch (TB-05) when the sidebar has focus.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') void invoke('tabs.endRecentSwitch', {})
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])
}

/** Each Space keeps its own scroll position in this window (SP-10). */
function useScrollMemory(scrollRef: React.RefObject<HTMLDivElement | null>, spaceId: string) {
  const positions = useRef(new Map<string, number>())
  const current = useRef(spaceId)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (current.current !== spaceId) {
      el.scrollTop = positions.current.get(spaceId) ?? 0
      current.current = spaceId
    }
    const onScroll = () => positions.current.set(spaceId, el.scrollTop)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [scrollRef, spaceId])
}

/**
 * Scrolls a newly selected tab into view and, while the selected tab is scrolled out of
 * sight, shows a small pill pointing to it (SB-23).
 */
function useAutoReveal(scrollRef: React.RefObject<HTMLDivElement | null>, selected: string | null) {
  const [side, setSide] = useState<'above' | 'below' | null>(null)
  // The row that stands for the selected tab: its split view's row; none for a Favorite.
  const active = useOrbit((s) =>
    selected && sectionOf(s, selected) !== 'favorite' ? (splitOfTab(s, selected) ?? selected) : null,
  )
  const rowOf = (id: string) => rowIn(scrollRef.current, id)
  useEffect(() => {
    if (!active) return
    const outside = () => {
      const scroll = scrollRef.current
      const el = rowIn(scroll, active)
      if (!el || !scroll) return null
      const r = el.getBoundingClientRect()
      const s = scroll.getBoundingClientRect()
      return r.top < s.top || r.bottom > s.bottom ? el : null
    }
    const raf = requestAnimationFrame(() =>
      outside()?.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }),
    )
    // Rows that were still growing in may have moved the target: settle on the final position,
    // unless the user has started scrolling in the meantime (never fight the user).
    const settle = setTimeout(() => outside()?.scrollIntoView({ block: 'nearest' }), 450)
    const scroll = scrollRef.current
    const userScroll = () => clearTimeout(settle)
    const inputs = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
    for (const type of inputs) scroll?.addEventListener(type, userScroll, { passive: true })
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(settle)
      for (const type of inputs) scroll?.removeEventListener(type, userScroll)
    }
  }, [active, scrollRef])
  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || !active) {
      setSide(null)
      return
    }
    let observer: IntersectionObserver | undefined
    let tries = 0
    let raf = requestAnimationFrame(function attach() {
      const el = rowIn(scroll, active)
      if (!el) {
        // The row may mount a frame later; give up after a few frames (e.g. a collapsed section).
        if (++tries < 10) raf = requestAnimationFrame(attach)
        return
      }
      observer = new IntersectionObserver(
        ([entry]) => {
          if (!entry || entry.isIntersecting) setSide(null)
          else setSide(entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0) ? 'above' : 'below')
        },
        { root: scroll, threshold: 0.6 },
      )
      observer.observe(el)
    })
    return () => {
      cancelAnimationFrame(raf)
      observer?.disconnect()
    }
  }, [active, scrollRef])
  if (!side || !active) return null
  return {
    side,
    go: () => rowOf(active)?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
  }
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

function rowIn(scroll: HTMLElement | null, id: string): HTMLElement | null {
  return scroll?.querySelector<HTMLElement>(`[data-slot][data-key="${id}"]`) ?? null
}

function firstRowKey(scroll: HTMLElement): string | null {
  return scroll.querySelector<HTMLElement>('[data-slot="item"]')?.dataset.key ?? null
}

/** Arrow keys move between rows, Enter opens, Escape returns to the page (SB-22). */
function useKeyboardNav(scrollRef: React.RefObject<HTMLDivElement | null>) {
  return (e: ReactKeyboardEvent) => {
    const scroll = scrollRef.current
    if (!scroll || (e.target as HTMLElement).closest('input')) return
    const keys = [...scroll.querySelectorAll<HTMLElement>('[data-slot="item"]')]
      .filter((el) => !el.dataset.exiting)
      .map((el) => el.dataset.key as string)
    const current = useKeyboardFocus.getState().id
    const i = current ? keys.indexOf(current) : -1
    const focus = (id: string | undefined) => {
      if (!id) return
      useKeyboardFocus.setState({ id })
      scroll.querySelector(`[data-slot][data-key="${id}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        focus(keys[Math.min(keys.length - 1, i + 1)])
        break
      case 'ArrowUp':
        e.preventDefault()
        focus(keys[Math.max(0, i - 1)])
        break
      case 'Home':
        e.preventDefault()
        focus(keys[0])
        break
      case 'End':
        e.preventDefault()
        focus(keys[keys.length - 1])
        break
      case 'ArrowRight':
      case 'ArrowLeft':
        if (current && isFolderId(current)) {
          e.preventDefault()
          void invoke('folders.setCollapsed', { folderId: current, collapsed: e.key === 'ArrowLeft' })
        }
        break
      case 'Enter':
      case ' ':
        if (!current) return
        e.preventDefault()
        if (isTabId(current)) {
          useKeyboardFocus.setState({ id: null })
          void invoke('tabs.activate', { tabId: current })
          void invoke('tabs.focusPage', {})
        } else if (isFolderId(current)) {
          const folder = getOrbitState().folders[current]
          if (folder) void invoke('folders.setCollapsed', { folderId: current, collapsed: !folder.collapsed })
        }
        break
      case 'Escape':
        e.preventDefault()
        useKeyboardFocus.setState({ id: null })
        clearSelection()
        void invoke('tabs.focusPage', {})
        break
      case 'F2':
        if (current) startRename(current)
        break
      default:
        return
    }
    if (useSelection.getState().ids.length > 0 && e.key.startsWith('Arrow')) clearSelection()
  }
}
