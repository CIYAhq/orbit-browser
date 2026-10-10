import { type MouseEvent, useEffect, useRef } from 'react'
import { invoke } from '../../api'

/**
 * The window's left edge while the sidebar is hidden (SB-12, FL-03): the pointer reaching it brings
 * the sidebar in as a floating card, at once. A drag passing by (a text selection, a tab) doesn't.
 * Main decides whether the pointer moved: one resting there when the sidebar is hidden (⌘S with the
 * pointer at the edge) doesn't bring it straight back. The event's own movement can't tell, as the
 * first event from a pointer coming off the page has none (review A-M2).
 */
export function SidebarEdge() {
  const last = useRef(0)
  useLeavingWindow()
  const onMove = (e: MouseEvent) => {
    if (e.buttons) return
    const now = performance.now()
    if (now - last.current < 100) return
    last.current = now
    void invoke('sidebar.reveal', {})
  }
  return <div className="sidebar-edge" data-testid="sidebar-edge" aria-hidden onMouseMove={onMove} />
}

/**
 * A pointer passing through the edge on its way out of the window (to a screen on the left) brings
 * the card in after it has gone, so the card never hears of it: the shell tells main it left.
 */
function useLeavingWindow() {
  useEffect(() => {
    const onOut = (e: globalThis.MouseEvent) => {
      if (e.relatedTarget || e.buttons) return
      const outside = e.clientX < 0 || e.clientY < 0 || e.clientX >= innerWidth || e.clientY >= innerHeight
      if (outside) void invoke('sidebar.peekState', { over: false })
    }
    document.addEventListener('mouseout', onOut)
    return () => document.removeEventListener('mouseout', onOut)
  }, [])
}
