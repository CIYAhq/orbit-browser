import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useLayoutEffect,
  useRef,
} from 'react'
import { DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from '../../../../shared/defaults'
import type { WindowState } from '../../../../shared/state'
import { invoke } from '../../api'
import { UpdateBanner } from '../../settings/UpdateBanner'
import { useOrbit } from '../../store'
import { PrivateSidebar } from '../chrome/PrivateSidebar'
import { MediaTray } from '../media/MediaTray'
import { SpaceStrip } from '../spaces/SpaceStrip'
import { UndoToast } from '../spaces/UndoToast'
import { SpaceBar } from './SpaceBar'
import { TopBar } from './TopBar'

/**
 * The vertical sidebar: top bar and address, then the per-Space strip
 * (Favorites, title row, pinned, Today; swipeable between Spaces), then the
 * Space switcher. Space content lives in ../spaces/. `floating` is the hidden
 * sidebar's card shown over the page (SB-12), which has no resize edge.
 * A private window's sidebar has only its own tabs under a "Private" label (SB-25).
 */
export function Sidebar({ win, floating = false }: { win: WindowState; floating?: boolean }) {
  const exists = useOrbit((s) => !!s.spaces[win.spaceId])
  if (!exists) return null
  const isPrivate = win.kind === 'private'
  return (
    <aside
      className={`sidebar${floating ? ' sidebar--floating' : ''}${isPrivate ? ' sidebar--private' : ''}`}
      data-testid="sidebar"
      aria-hidden={!floating && !win.sidebar.visible}
      onMouseUp={isPrivate ? undefined : onSideButtons}
      onAuxClick={preventSideButtons}
    >
      <TopBar win={win} floating={floating} />
      {isPrivate ? (
        <PrivateSidebar spaceId={win.spaceId} />
      ) : (
        <>
          <SpaceStrip windowId={win.id} spaceId={win.spaceId} />
          <UndoToast />
          {/* Settings lane: the update and What's new banner above the Space switcher (UP-02, UP-06). */}
          <UpdateBanner />
          {/* Media lane: transient media tray above the bottom bar (SB-10, MD-09). */}
          <MediaTray windowId={win.id} />
          <SpaceBar win={win} />
        </>
      )}
      {!floating && <ResizeHandle win={win} />}
    </aside>
  )
}

/** Mouse back/forward buttons over the sidebar move between Spaces (SP-09). */
function onSideButtons(e: ReactMouseEvent) {
  if (e.button !== 3 && e.button !== 4) return
  e.preventDefault()
  void invoke('spaces.step', { delta: e.button === 3 ? -1 : 1 })
}

function preventSideButtons(e: ReactMouseEvent) {
  if (e.button === 3 || e.button === 4) e.preventDefault()
}

/** Dragging this far left past the minimum width hides the sidebar (SB-14). */
export const COLLAPSE_PAST = 40

const clampWidth = (w: number) => Math.round(Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, w)))

interface Drag {
  x: number
  /** The width when the drag began: the width follows the pointer's distance from there (no drift). */
  width: number
  live: number
  collapsed: boolean
  shell: HTMLElement | null
}

/**
 * The sidebar's right edge (SB-14). Dragging it sets the width 1:1 with the pointer (the shell
 * shows the drag's width at once, `--sidebar-live-w`, with no animation), clamped to the limits;
 * dragging on 40 px past the minimum hides the sidebar as ⌘S does, and back out shows it again.
 * The window's width is saved when the drag ends; a drag that hid the sidebar keeps the width it
 * had, so it comes back the same. Double-click resets the default width.
 */
function ResizeHandle({ win }: { win: WindowState }) {
  const drag = useRef<Drag | null>(null)
  /** The width a finished drag sent; the live width goes once the window's state has it. */
  const pending = useRef<{ width: number; shell: HTMLElement | null } | null>(null)
  const storeWidth = win.sidebar.width

  useLayoutEffect(() => {
    const p = pending.current
    if (p && p.width === storeWidth) {
      pending.current = null
      endLive(p.shell)
    }
  }, [storeWidth])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const shell = e.currentTarget.closest<HTMLElement>('.shell')
    pending.current = null
    drag.current = { x: e.clientX, width: storeWidth, live: storeWidth, collapsed: false, shell }
    e.currentTarget.setPointerCapture(e.pointerId)
    document.documentElement.classList.add('is-resizing')
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const raw = d.width + e.clientX - d.x
    if (raw < MIN_SIDEBAR_WIDTH - COLLAPSE_PAST) {
      if (d.collapsed) return
      d.collapsed = true
      // The hide animates (FL-02); the width it had stays the window's.
      d.shell?.classList.remove('shell--resizing')
      void invoke('window.setSidebar', { visible: false })
      return
    }
    d.live = clampWidth(raw)
    setLive(d.shell, d.live)
    if (d.collapsed) {
      d.collapsed = false
      void invoke('window.setSidebar', { visible: true })
    }
  }
  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    document.documentElement.classList.remove('is-resizing')
    if (!d) return
    if (d.collapsed) {
      // Hidden by the drag: back to the width it had once the slide is over.
      window.setTimeout(() => endLive(d.shell), 320)
      return
    }
    if (d.live === storeWidth) {
      endLive(d.shell)
      return
    }
    pending.current = { width: d.live, shell: d.shell }
    void invoke('window.setSidebar', { width: d.live })
    // Should the state never echo the width back (window closing), don't keep the drag's width forever.
    window.setTimeout(() => {
      if (pending.current?.width === d.live) {
        pending.current = null
        endLive(d.shell)
      }
    }, 1000)
  }
  return (
    <div
      className="sidebar__resize"
      data-testid="sidebar-resize"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => void invoke('window.setSidebar', { width: DEFAULT_SIDEBAR_WIDTH })}
    />
  )
}

function setLive(shell: HTMLElement | null, width: number): void {
  if (!shell) return
  shell.classList.add('shell--resizing')
  shell.style.setProperty('--sidebar-live-w', `${width}px`)
}

function endLive(shell: HTMLElement | null): void {
  if (!shell) return
  shell.classList.remove('shell--resizing')
  shell.style.removeProperty('--sidebar-live-w')
}
