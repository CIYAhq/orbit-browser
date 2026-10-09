import { type PointerEvent as ReactPointerEvent, useMemo, useRef } from 'react'
import type { WindowState } from '../../../../shared/state'
import { invoke } from '../../api'
import { useOrbit } from '../../store'
import { MediaTray } from '../media/MediaTray'
import { SidebarItems } from './SidebarItems'
import { SpaceBar } from './SpaceBar'
import { TopBar } from './TopBar'

/** The vertical sidebar: top bar, address, favorites, pinned + Today lists, Space switcher. */
export function Sidebar({ win }: { win: WindowState }) {
  const name = useOrbit((s) => s.spaces[win.spaceId]?.name)
  const icon = useOrbit((s) => s.spaces[win.spaceId]?.icon)
  // A stable header element, so the memoized tab lists skip window-only changes (review F5).
  const header = useMemo(
    () => (
      <div className="sidebar__space-name" data-testid="space-name">
        {icon ? <span className="sidebar__space-icon">{icon}</span> : null}
        {name}
      </div>
    ),
    [name, icon],
  )
  if (name === undefined) return null
  return (
    <aside className="sidebar" data-testid="sidebar" aria-hidden={!win.sidebar.visible}>
      <TopBar win={win} />
      <SidebarItems spaceId={win.spaceId} header={header} />
      {/* Media lane: transient media tray above the bottom bar (SB-10, MD-09). */}
      <MediaTray />
      <SpaceBar win={win} />
      <ResizeHandle width={win.sidebar.width} />
    </aside>
  )
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
