import { ArrowDown, ArrowUp, ChevronDown, Plus } from 'lucide-react'
import { AnimatePresence, cubicBezier, motion } from 'motion/react'
import {
  memo,
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
import { containerItems, containerKey, locate, sectionOf, splitOfTab } from '../../../../shared/tree'
import { invoke, runAction } from '../../api'
import { importPastedLinks, revealInSidebar } from '../../import/sidebar'
import { useShortcutLabel } from '../../keys/live'
import { AT_ONCE, EASE, OrbitMotionConfig, reducedMotion, useReducedMotion } from '../../motion'
import { activeTabId } from '../../selectors'
import { getOrbitState, useOrbit } from '../../store'
import { DragGhost } from './DragGhost'
import { setDragContext } from './drag'
import { Favorites } from './Favorites'
import { FolderSearch } from './FolderSearch'
import { IconPicker } from './IconPicker'
import { CHEVRON, ItemList, RevealBox, TabRow, useRowShift } from './ItemList'
import { RowWindow, RowWindowContext } from './row-window'
import { clearSelection, startRename, useIconPicker, useKeyboardFocus, useSelection } from './ui-state'
import { sidebarUndoKey } from './undo-keys'

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
  const scrollTop = useScrollMemory(scrollRef, spaceId)
  const rows = useRowWindow(scrollRef, scrollTop)
  const reveal = useAutoReveal(scrollRef, active, rows)
  const onKeyDown = useKeyboardNav(scrollRef)
  if (!space) return null

  return (
    <ListScope rows={rows}>
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
          onPaste={importPastedLinks}
          onContextMenu={(e) => {
            if (!e.defaultPrevented) onContextMenu?.(e)
          }}
        >
          {simple ? header : <SpaceHeader space={space}>{header}</SpaceHeader>}
          {!simple && <PinnedSection space={space} />}
          <TodayBlock space={space} clear={!simple} />
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
    </ListScope>
  )
})

/** Motion settings and the row window for everything in the sidebar's lists. */
function ListScope({ rows, children }: { rows: RowWindow; children: ReactNode }) {
  return (
    <OrbitMotionConfig>
      <RowWindowContext value={rows}>{children}</RowWindowContext>
    </OrbitMotionConfig>
  )
}

/**
 * The rows drawn in this scroller (FL-21). Measured after every render of the sidebar, once the
 * lists and the remembered scroll position are in place, so the first frame of a Space already
 * draws the rows on screen and nothing else. `scrollTop` is where this render leaves the list.
 */
function useRowWindow(scrollRef: React.RefObject<HTMLDivElement | null>, scrollTop: number): RowWindow {
  const [rows] = useState(() => new RowWindow())
  // Rows mounting in this render are placed by their order until they are measured.
  rows.expect(scrollTop)
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    return scroll ? rows.attach(scroll) : undefined
  }, [rows, scrollRef])
  useLayoutEffect(() => rows.update())
  return rows
}

/** Space title row with the pinned-section caret (PN-09). */
function SpaceHeader({ space, children }: { space: Space; children: ReactNode }) {
  const activePinned = useOrbit((s) => {
    const a = activeTabId(s)
    return !!a && sectionOf(s, a) === 'pinned'
  })
  const collapsed = !!space.pinnedCollapsed
  // The caret turns at once with reduced motion, also after the header was drawn (FL-28).
  const reduced = useReducedMotion()
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
          transition={reduced ? AT_ONCE : CHEVRON}
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
    const size = loc ? (containerItems(s, loc.container)?.length ?? 0) : 0
    return loc ? `${a}|${containerKey(loc.container)}|${loc.index}|${size}` : null
  })
  // Drawn before: the section shown from now on was opened by the user (FL-12).
  const shown = useRef(false)
  useEffect(() => {
    shown.current = true
  }, [])
  const [peekId, peekContainer, peekIndex, peekSize] = peekKey ? peekKey.split('|') : []
  const peek =
    peekId && peekContainer
      ? { id: peekId, key: peekContainer, index: Number(peekIndex), size: Number(peekSize) }
      : null
  return (
    <>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <RevealBox key="pinned" className="pinned-section" stagger={shown.current}>
            <ItemList
              key={`pinned:${space.id}`}
              containerKey={`pinned:${space.id}`}
              items={space.pinned}
              testId="pinned-list"
            />
          </RevealBox>
        )}
      </AnimatePresence>
      {peek && (
        <div className="pinned-peek" data-testid="pinned-peek">
          <TabRow tabId={peek.id} depth={0} containerKey={peek.key} index={peek.index} size={peek.size} ancestors="" />
        </div>
      )}
    </>
  )
})

/**
 * Divider with Clear (TD-04) and the "+ New Tab" row (SB-07): one drop slot between pinned and Today.
 * A private window's list has no Clear: its tabs have no Archive to go to (SB-25, KS-20).
 */
function TodayBlock({ space, clear }: { space: Space; clear: boolean }) {
  const y = useRowShift('divider')
  const hasToday = clear && space.today.length > 0
  // The button's tooltip follows a remapped shortcut (KS-18).
  const clearShortcut = useShortcutLabel('tabs.clearToday')
  // With reduced motion the "+" doesn't nudge (FL-28: decorative motion is off).
  const reduced = useReducedMotion()
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
            title={clearShortcut ? `Archive all Today tabs (${clearShortcut})` : 'Archive all Today tabs'}
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
        {/* FL-15: the "+" scales to about 0.92 and back in about 150 ms (its own timing). */}
        <motion.span
          className="new-tab-button__plus"
          whileTap={reduced ? undefined : { scale: 0.92 }}
          transition={{ duration: 0.15 }}
        >
          <Plus size={16} strokeWidth={2} />
        </motion.span>
        <span>New Tab</span>
      </button>
    </motion.div>
  )
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
      window.orbit.on('sidebar:reveal', (p) => revealInSidebar(scrollRef.current, (p as { id: string }).id)),
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

/**
 * ⌘Z with focus in Orbit's UI (not a text field) undoes the last sidebar change, ⌘⇧Z redoes it
 * (TB-18): the keys as the keymap has them (KS-05).
 */
function useShellUndo() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const inField = !!target?.closest('input, textarea, [contenteditable="true"]')
      if (e.key === 'Escape') {
        if (!inField) clearSelection()
        return
      }
      // A key that edits text (⌘Z) is a text field's own undo inside one (KS-16).
      const undo = sidebarUndoKey(e)
      if (!undo || (undo.outsideText && inField)) return
      e.preventDefault()
      void invoke(undo.redo ? 'tabs.redo' : 'tabs.undo', {})
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

/** Each Space keeps its own scroll position in this window (SP-10); returns the one this render shows. */
function useScrollMemory(scrollRef: React.RefObject<HTMLDivElement | null>, spaceId: string): number {
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
  return positions.current.get(spaceId) ?? 0
}

/**
 * FL-05: a newly selected row out of sight scrolls into view with an ease-out of 200–250 ms, and at
 * once when it is more than two screens away, or with reduced motion (FL-28). The curve is the
 * instant token's, CSS's ease-out: it moves until its end, so the scroll shows its whole 225 ms
 * (the snappy curve covers 95 % of the way in half that and then barely moves).
 */
const REVEAL_MS = 225
const REVEAL_EASE = cubicBezier(...EASE.instant)
const REVEAL_JUMP_SCREENS = 2

/**
 * Scrolls the list so `el` shows, where `scrollIntoView({ block: 'nearest' })` would put it, on
 * FL-05's ease-out or at once; returns the cancel. Run in a frame callback (`now` is its time): the
 * first step is drawn in this frame, and each step draws the rows it brings on screen before the
 * frame (FL-21), where a scroll set in a frame callback would show them only in the next.
 */
function revealRow(scroll: HTMLElement, el: HTMLElement, rows: RowWindow, now: number): () => void {
  const view = scroll.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  const by = r.top < view.top ? r.top - view.top : r.bottom > view.bottom ? r.bottom - view.bottom : 0
  const from = scroll.scrollTop
  const to = Math.min(Math.max(0, from + by), scroll.scrollHeight - scroll.clientHeight)
  const none = () => {}
  if (view.height === 0 || Math.abs(to - from) < 1) return none
  if (reducedMotion() || Math.abs(to - from) > REVEAL_JUMP_SCREENS * scroll.clientHeight) {
    scroll.scrollTop = to
    rows.update(true)
    return none
  }
  // One frame along, so the frame drawn now already moves (as ONE_FRAME_S does for entrances).
  const start = now - 1000 / 60
  let raf = 0
  const step = (t: number) => {
    const p = Math.min(1, (t - start) / REVEAL_MS)
    scroll.scrollTop = from + (to - from) * REVEAL_EASE(p)
    rows.update(true)
    if (p < 1) raf = requestAnimationFrame(step)
  }
  step(now)
  return () => cancelAnimationFrame(raf)
}

/**
 * Scrolls a newly selected tab into view (FL-05, SB-23) and, while the selected tab is scrolled out
 * of sight, shows a small pill pointing to it (SB-23).
 */
function useAutoReveal(scrollRef: React.RefObject<HTMLDivElement | null>, selected: string | null, rows: RowWindow) {
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
    let stop = () => {}
    const raf = requestAnimationFrame((now) => {
      const el = outside()
      const scroll = scrollRef.current
      if (el && scroll) stop = revealRow(scroll, el, rows, now)
    })
    // Rows that were still growing in may have moved the target: settle on the final position,
    // unless the user has started scrolling in the meantime (never fight the user), or the row has
    // since moved to another section, e.g. pinned out of sight (FL-07: the list does not scroll).
    const home = rowIn(scrollRef.current, active)?.dataset.container
    const settle = setTimeout(() => {
      const el = outside()
      if (el && (home === undefined || el.dataset.container === home)) el.scrollIntoView({ block: 'nearest' })
    }, 450)
    const scroll = scrollRef.current
    const userScroll = () => {
      clearTimeout(settle)
      stop()
    }
    const inputs = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
    for (const type of inputs) scroll?.addEventListener(type, userScroll, { passive: true })
    return () => {
      cancelAnimationFrame(raf)
      stop()
      clearTimeout(settle)
      for (const type of inputs) scroll?.removeEventListener(type, userScroll)
    }
  }, [active, scrollRef, rows])
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
