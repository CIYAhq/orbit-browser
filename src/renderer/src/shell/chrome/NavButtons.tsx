import { ArrowLeft, ArrowRight, RotateCw, X } from 'lucide-react'
import { type MouseEvent, type PointerEvent, useEffect, useRef } from 'react'
import type { NavDirection } from '../../../../shared/commands/nav'
import { shownTabId } from '../../../../shared/nav'
import { sectionOf } from '../../../../shared/tree'
import { invoke, isMac } from '../../api'
import { useOrbitShallow } from '../../store'
import { playPress } from './press'
import { rasterizeSvgIcons } from './raster'
import { withShortcut } from './shortcut-label'

/** Holding Back or Forward this long opens its history menu (NV-01). */
export const LONG_PRESS_MS = 400

interface NavState {
  hasTab: boolean
  back: boolean
  forward: boolean
  loading: boolean
}

/** ⌘-click on macOS, Ctrl-click elsewhere: the button's action goes to a new tab (SB-03). */
const newTabClick = (e: MouseEvent) => (isMac ? e.metaKey : e.ctrlKey)

/**
 * Back, Forward and Reload for the window's active tab (the focused pane in split view), with
 * their enabled, disabled and loading states (SB-03).
 */
export function NavButtons({ windowId }: { windowId: string }) {
  // Only these four flags: title, favicon and progress updates don't re-render the buttons.
  const nav = useOrbitShallow((s): NavState => {
    // An open Peek's page while one shows (PK-11), else the active tab.
    const id = shownTabId(s, windowId)
    const tab = id ? s.tabs[id] : undefined
    if (!id || !tab) return { hasTab: false, back: false, forward: false, loading: false }
    // Back on a fresh tab opened from a link closes it and returns to its opener (TB-19).
    const backToOpener = !tab.canGoBack && !!tab.openerTabId && !!s.tabs[tab.openerTabId]
    return {
      hasTab: true,
      back: tab.canGoBack || (backToOpener && sectionOf(s, id) === 'today'),
      forward: tab.canGoForward,
      loading: tab.loading,
    }
  })
  return (
    <>
      <HistoryButton direction="back" enabled={nav.back} />
      <HistoryButton direction="forward" enabled={nav.forward} />
      <ReloadButton enabled={nav.hasTab} loading={nav.loading} />
    </>
  )
}

/**
 * Back or Forward. Click goes there; ⌘-click or middle-click opens that page in a new tab;
 * long-press or right-click shows the tab's history in that direction (NV-01).
 */
function HistoryButton({ direction, enabled }: { direction: NavDirection; enabled: boolean }) {
  const ref = useRef<HTMLButtonElement>(null)
  const hold = useRef<{ timer: number; opened: boolean } | null>(null)
  const label = direction === 'back' ? 'Back' : 'Forward'

  const cancelHold = () => {
    if (hold.current) window.clearTimeout(hold.current.timer)
  }
  useEffect(
    () => () => {
      if (hold.current) window.clearTimeout(hold.current.timer)
    },
    [],
  )

  const showMenu = async () => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    const entries = await invoke('nav.history', { direction })
    if (entries.length === 0) return
    // Native menus can't draw SVG favicons: send PNG renderings along.
    const icons = await rasterizeSvgIcons(entries.map((entry) => entry.favicon))
    await invoke('nav.historyMenu', { direction, x: rect.left, y: rect.bottom + 4, icons })
  }
  const press = (newTab: boolean, foreground: boolean) => {
    playPress(ref.current, direction)
    void invoke('nav.press', { button: direction, newTab, foreground })
  }

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    cancelHold()
    hold.current = null
    if (e.button !== 0 || newTabClick(e) || !enabled) return
    const current = {
      opened: false,
      timer: window.setTimeout(() => {
        current.opened = true
        void showMenu()
      }, LONG_PRESS_MS),
    }
    hold.current = current
  }
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    const longPress = hold.current?.opened
    cancelHold()
    hold.current = null
    // The press became a long-press: the menu is the answer, not a navigation.
    if (longPress) return
    const newTab = newTabClick(e)
    press(newTab, newTab && e.shiftKey)
  }
  const onAuxClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (e.button !== 1) return
    e.preventDefault()
    press(true, e.shiftKey)
  }
  const onContextMenu = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    cancelHold()
    if (enabled) void showMenu()
  }

  return (
    <button
      ref={ref}
      type="button"
      className="icon-button nav-button"
      aria-label={label}
      title={withShortcut(label, direction === 'back' ? 'nav.back' : 'nav.forward')}
      data-testid={direction === 'back' ? 'nav-back' : 'nav-forward'}
      disabled={!enabled}
      onPointerDown={onPointerDown}
      onPointerLeave={cancelHold}
      onPointerCancel={cancelHold}
      onClick={onClick}
      onAuxClick={onAuxClick}
      onContextMenu={onContextMenu}
    >
      {direction === 'back' ? <ArrowLeft size={16} /> : <ArrowRight size={16} />}
    </button>
  )
}

/**
 * Reload, or Stop (×) while the page loads. Double-clicking Reload stops the load it started;
 * ⌘-click or middle-click duplicates the tab (SB-03, NV-03, NV-04).
 */
function ReloadButton({ enabled, loading }: { enabled: boolean; loading: boolean }) {
  const ref = useRef<HTMLButtonElement>(null)
  const duplicate = (foreground: boolean) => {
    playPress(ref.current, 'reload')
    void invoke('nav.press', { button: 'reload', newTab: true, foreground })
  }
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (newTabClick(e)) {
      duplicate(e.shiftKey)
      return
    }
    // The second click of a double-click stops, whether or not the loading state has arrived yet.
    if (loading || e.detail >= 2) {
      void invoke('nav.press', { button: 'stop' })
      return
    }
    playPress(ref.current, 'reload')
    void invoke('nav.press', { button: 'reload' })
  }
  const onAuxClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (e.button !== 1) return
    e.preventDefault()
    duplicate(e.shiftKey)
  }
  const label = loading ? 'Stop' : 'Reload'
  return (
    <button
      ref={ref}
      type="button"
      className="icon-button nav-button"
      aria-label={label}
      title={loading ? 'Stop (Esc)' : withShortcut(label, 'nav.reload')}
      data-testid="nav-reload"
      data-loading={loading || undefined}
      disabled={!enabled}
      onClick={onClick}
      onAuxClick={onAuxClick}
    >
      {loading ? <X size={16} /> : <RotateCw size={15} />}
    </button>
  )
}
