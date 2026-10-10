import { type CSSProperties, useEffect } from 'react'
import { invoke } from '../../api'
import { useWindow } from '../../store'
import { useShellTheme } from '../../theme'
import { Sidebar } from '../sidebar/Sidebar'
import './chrome.css'

/**
 * The hidden sidebar's floating card (SB-12, FL-03). Pages are native views above the shell, so the
 * card lives in a transparent view of its own at the window's left edge, which main places while the
 * card is out. It holds everything the docked sidebar has, in the Space's theme, and slides in and
 * out on `sidebar.peeking`.
 */
export function FloatingSidebarApp() {
  const win = useWindow()
  const theme = useShellTheme(win?.spaceId)
  usePointerReports(!!win?.sidebar.peeking)
  if (!win) return null
  // Docking from here (⌘S): the card stays put while the docked sidebar slides in beneath it.
  const out = win.sidebar.peeking || win.sidebar.visible
  const style = { '--sidebar-w': `${win.sidebar.width}px` } as CSSProperties
  return (
    <div
      className={`shell float-sidebar${out ? ' is-out' : ''}${win.focused ? '' : ' shell--blurred'}`}
      style={style}
      ref={theme.shellRef}
      data-testid="floating-sidebar"
      data-out={out ? 'true' : 'false'}
      onMouseDown={(e) => {
        // Beside the card is the page: the card goes at once and the click goes on to the page.
        if (e.target !== e.currentTarget) return
        e.preventDefault()
        const button = e.button === 1 ? 'middle' : e.button === 2 ? 'right' : 'left'
        void invoke('sidebar.peekDismiss', { x: e.clientX, y: e.clientY, button })
      }}
    >
      <div className="float-sidebar__slide">
        <div className="float-sidebar__shadow" aria-hidden />
        <div className="float-sidebar__card">
          <div className="shell-bg" ref={theme.backgroundRef} aria-hidden>
            <div className="shell-bg__grain" />
          </div>
          <Sidebar win={win} floating />
        </div>
      </div>
    </div>
  )
}

/** How often a pointer moving over the card says so again (well inside main's grace delay). */
const REASSERT_MS = 250

const isEditable = (el: Element | null) =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement | null)?.isContentEditable

/**
 * Tells main whether the pointer is over the card (or just beside it) and whether a text field in it
 * has focus. The view reaches the window's top, left and bottom edges and ends beside the card, so
 * the pointer leaves it through an edge. A leave short of the edge says nothing about where the
 * pointer went: on over the window's resize border or the card's drag region, where nothing hears
 * it, or nowhere, as a menu or the command bar came up over the card. The card says so (`over:
 * null`), and main reads the pointer until a view hears it (round 2 fix check, M4).
 */
function usePointerReports(peeking: boolean) {
  useEffect(() => {
    if (!peeking) return
    let over: boolean | null = null
    let editing: boolean | null = null
    let said = 0
    let unsure = false
    const setOver = (value: boolean) => {
      // While the pointer moves over the card, say so now and then: main may have heard otherwise.
      const now = performance.now()
      if (value === over && (!value || now - said < REASSERT_MS)) return
      over = value
      said = now
      unsure = false
      void invoke('sidebar.peekState', { over: value })
    }
    const setEditing = (value: boolean) => {
      if (value === editing) return
      editing = value
      void invoke('sidebar.peekState', { editing: value })
    }
    const onMove = () => setOver(true)
    const onOut = (e: MouseEvent) => {
      if (e.relatedTarget || e.buttons) return
      const atEdge = e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth - 1 || e.clientY >= innerHeight - 1
      if (atEdge) {
        setOver(false)
        return
      }
      over = null
      if (unsure) return
      unsure = true
      void invoke('sidebar.peekState', { over: null })
    }
    let focusTimer = 0
    const onFocus = () => {
      clearTimeout(focusTimer)
      // After a blur, focus lands on the next element a moment later.
      focusTimer = window.setTimeout(() => setEditing(!!isEditable(document.activeElement)), 0)
    }
    document.addEventListener('mousemove', onMove, { passive: true })
    document.addEventListener('mouseout', onOut)
    document.addEventListener('focusin', onFocus)
    document.addEventListener('focusout', onFocus)
    onFocus()
    return () => {
      clearTimeout(focusTimer)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseout', onOut)
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('focusout', onFocus)
    }
  }, [peeking])
}
