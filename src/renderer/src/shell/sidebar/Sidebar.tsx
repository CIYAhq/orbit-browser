import { type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, useRef } from 'react'
import type { WindowState } from '../../../../shared/state'
import { invoke } from '../../api'
import { DownloadsTray } from '../../downloads/DownloadsTray'
import { useOrbit } from '../../store'
import { MediaTray } from '../media/MediaTray'
import { SpaceStrip } from '../spaces/SpaceStrip'
import { UndoToast } from '../spaces/UndoToast'
import { SpaceBar } from './SpaceBar'
import { TopBar } from './TopBar'

/**
 * The vertical sidebar: top bar and address, then the per-Space strip
 * (Favorites, title row, pinned, Today; swipeable between Spaces), then the
 * Space switcher. Space content lives in ../spaces/.
 */
export function Sidebar({ win }: { win: WindowState }) {
  const exists = useOrbit((s) => !!s.spaces[win.spaceId])
  if (!exists) return null
  return (
    <aside
      className="sidebar"
      data-testid="sidebar"
      aria-hidden={!win.sidebar.visible}
      onMouseUp={onSideButtons}
      onAuxClick={preventSideButtons}
    >
      <TopBar win={win} />
      <SpaceStrip windowId={win.id} spaceId={win.spaceId} />
      <UndoToast />
      {/* Media lane: transient media tray above the bottom bar (SB-10, MD-09). */}
      <MediaTray />
      {/* Downloads lane: running downloads, just above the bottom bar (DL-03). */}
      <DownloadsTray win={win} />
      <SpaceBar win={win} />
      <ResizeHandle width={win.sidebar.width} />
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

function ResizeHandle({ width }: { width: number }) {
  const start = useRef<{ x: number; width: number } | null>(null)
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    start.current = { x: e.clientX, width }
    e.currentTarget.setPointerCapture(e.pointerId)
    document.documentElement.classList.add('is-resizing')
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return
    void invoke('window.setSidebar', { width: start.current.width + e.clientX - start.current.x })
  }
  const onPointerUp = () => {
    start.current = null
    document.documentElement.classList.remove('is-resizing')
  }
  return (
    <div
      className="sidebar__resize"
      data-testid="sidebar-resize"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  )
}
