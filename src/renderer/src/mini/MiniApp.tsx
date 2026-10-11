import { ChevronDown, Lock, UserRound } from 'lucide-react'
import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { Tab } from '../../../shared/state'
import { NEUTRAL_THEME, paletteFor } from '../../../shared/theme'
import { displayHost } from '../../../shared/url'
import { invoke, isMac, perfMark } from '../api'
import { useShortcutLabel } from '../keys/live'
import { CommandBar, type MiniBar } from '../overlay/CommandBar'
import { activeTabId } from '../selectors'
import { useOrbit, useWindow } from '../store'
import { paletteVars, useDark } from '../theme'
import { Favicon } from '../ui/Favicon'
import './mini.css'

/** Kept in step with MINI_BAR / MINI_INSET / MINI_RADIUS in src/main/miniwindow. */
const CARD_RADIUS = 10

/**
 * A Mini Window's chrome (MW-03): a slim top bar (window controls, the page's host which edits
 * the URL, "Open in…" and the profile when there are several) over the page card. Without a page
 * it shows the lookup bar, focused (MW-06). The page is a native view main keeps on the card.
 * The lookup bar and the address field are the command bar's compact variant (CB-23).
 */
export function MiniApp() {
  const win = useWindow()
  // "Open in…" shows the shortcut that moves the page into a Space, as the user has it (MW-05, KS-18).
  const moveShortcut = useShortcutLabel('peek.expand')
  const live = useOrbit((s) => {
    const id = win ? activeTabId(s, win.id) : null
    return id ? s.tabs[id] : undefined
  })
  // After "Open in…" the page belongs to the main window, but this window keeps its bar as it was
  // while it shrinks and fades away, rather than flashing the blank lookup bar (MW-15).
  const [leftWith, setLeftWith] = useState<Tab | undefined>()
  const liveRef = useRef(live)
  useEffect(() => {
    liveRef.current = live
  }, [live])
  useEffect(() => window.orbit.on('mini:leaving', () => setLeftWith(liveRef.current)), [])
  const tab = leftWith ?? live
  const profileCount = useOrbit((s) => Object.keys(s.profiles).length)
  const profileName = useOrbit((s) => (tab ? s.profiles[tab.profileId]?.name : undefined))
  // A Mini Window has no Space yet: the neutral theme, light or dark as the app is (MW-03).
  const dark = useDark()
  const palette = useMemo(() => paletteFor(NEUTRAL_THEME, dark), [dark])
  const frameRef = useRef<HTMLDivElement>(null)
  useCardReporter(frameRef)
  const [editing, setEditing] = useState(false)
  const openInRef = useRef<HTMLButtonElement>(null)

  useEffect(() => window.orbit.on('mini:edit-url', () => setEditing(true)), [])
  /** The bar over the page is done; the page gets the keyboard back unless it went to another window. */
  const closeBar = useCallback((how: 'chosen' | 'dismissed' | 'away') => {
    setEditing(false)
    if (how !== 'away') void invoke('mini.focusPage', {})
  }, [])
  // ⌘W or ⌘L while the bar is open closes it, as in the main window (KS-19).
  useEffect(() => window.orbit.on('mini:close-bar', () => closeBar('dismissed')), [closeBar])
  const barOpen = !!tab && editing && !leftWith
  const cover = usePageCover(barOpen)
  const pageBar = useMemo<MiniBar>(() => ({ blank: false, onClose: closeBar }), [closeBar])
  const address = tab ? (tab.pendingUrl ?? tab.url) : ''
  useEffect(
    () =>
      window.orbit.on('mini:choose-space', () => {
        const r = openInRef.current?.getBoundingClientRect()
        void invoke('mini.menu', { menu: 'open-in', x: r ? r.left : 80, y: r ? r.bottom + 4 : 40 })
      }),
    [],
  )
  useEffect(() => {
    if (!tab) setEditing(false)
  }, [tab])

  return (
    <div
      className={`mini${win?.focused === false ? ' mini--blurred' : ''}`}
      style={paletteVars(palette) as CSSProperties}
      data-testid="mini"
    >
      <header className="mini__bar">
        {isMac ? <div className="mini__traffic-space" /> : <MiniWindowControls />}
        {tab && editing ? (
          <CommandBar
            mode={address && address !== 'about:blank' ? 'edit-url' : 'new-tab'}
            initialQuery={address === 'about:blank' ? '' : address}
            dark={dark}
            mini={pageBar}
          />
        ) : tab ? (
          <Address tab={tab} onEdit={() => setEditing(true)} />
        ) : (
          <span className="mini__title">Mini Window</span>
        )}
        <div className="mini__spacer" />
        {tab && profileCount > 1 && (
          <button
            type="button"
            className="mini__pill"
            data-testid="mini-profile"
            title="Open this page in another profile"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              void invoke('mini.menu', { menu: 'profile', x: r.left, y: r.bottom + 4 })
            }}
          >
            <UserRound size={13} />
            <span>{profileName}</span>
          </button>
        )}
        {tab && (
          <button
            ref={openInRef}
            type="button"
            className="mini__pill mini__open-in"
            data-testid="mini-open-in"
            title={moveShortcut ? `Move this page into a Space (${moveShortcut})` : 'Move this page into a Space'}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              void invoke('mini.menu', { menu: 'open-in', x: r.left, y: r.bottom + 4 })
            }}
          >
            <span>Open in…</span>
            <ChevronDown size={13} />
          </button>
        )}
      </header>
      <main
        className="mini__frame"
        ref={frameRef}
        data-testid="mini-frame"
        onMouseDown={(e) => {
          // A click on the page's still image dismisses the bar over it (as the main bar's backdrop does).
          if (!barOpen) return
          e.preventDefault()
          closeBar('dismissed')
        }}
      >
        {barOpen && cover.src && (
          <div className="mini__cover" data-testid="mini-cover">
            <img src={cover.src} alt="" draggable={false} onLoad={cover.onShown} />
          </div>
        )}
        {!tab && <LookupBar dark={dark} />}
      </main>
    </div>
  )
}

function Address({ tab, onEdit }: { tab: Tab; onEdit: () => void }) {
  const secure = tab.url.startsWith('https://')
  return (
    <button
      type="button"
      className={`mini__address${tab.loading ? ' mini__address--loading' : ''}`}
      data-testid="mini-address"
      title={tab.url}
      onClick={onEdit}
    >
      <Favicon src={tab.favicon} size={14} />
      {secure && <Lock size={10} className="mini__lock" />}
      <span className="mini__host">{displayHost(tab.url) || tab.title}</span>
    </button>
  )
}

/** The quick lookup bar of a blank Mini Window: type, Enter, and the result loads here (MW-06, CB-23). */
function LookupBar({ dark }: { dark: boolean }) {
  useEffect(() => {
    perfMark('mini:lookup-ready')
  }, [])
  const bar = useMemo<MiniBar>(
    () => ({
      blank: true,
      // Escape on the empty bar closes the window (MW-06); a choice loads here and replaces the bar.
      onClose: (how) => {
        if (how === 'dismissed') void invoke('mini.control', { op: 'close' })
      },
    }),
    [],
  )
  return <CommandBar mode="new-tab" initialQuery="" dark={dark} mini={bar} />
}

/**
 * While the bar over the page is open its list covers the page (CB-23). The page is a native
 * view above the card, so the card shows a still image of it and main hides the view until the
 * bar closes. Main also learns that the bar is open: ⌘W and ⌘L close the bar first (KS-19).
 */
function usePageCover(open: boolean): { src: string | null; onShown: () => void } {
  const [src, setSrc] = useState<string | null>(null)
  const live = useRef(false)
  useEffect(() => {
    if (!open) return
    live.current = true
    void invoke('mini.bar', { open: true }).then((image) => {
      if (live.current && image) setSrc(image)
    })
    return () => {
      live.current = false
      setSrc(null)
      void invoke('mini.bar', { open: false })
    }
  }, [open])
  // The view steps aside only once the image is on screen, so the card never shows empty.
  const onShown = useCallback(() => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (live.current) void invoke('mini.hidePage', {})
      }),
    )
  }, [])
  return { src, onShown }
}

function MiniWindowControls() {
  return (
    <div className="window-controls mini__controls">
      <button
        type="button"
        className="window-controls__btn window-controls__btn--close"
        aria-label="Close"
        data-testid="mini-close"
        onClick={() => invoke('mini.control', { op: 'close' })}
      />
      <button
        type="button"
        className="window-controls__btn window-controls__btn--min"
        aria-label="Minimize"
        onClick={() => invoke('mini.control', { op: 'minimize' })}
      />
      <button
        type="button"
        className="window-controls__btn window-controls__btn--max"
        aria-label="Maximize"
        onClick={() => invoke('mini.control', { op: 'maximize' })}
      />
    </div>
  )
}

/** Reports where the page card is whenever it moves or resizes; main keeps the page view on it. */
function useCardReporter(ref: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let last = ''
    const report = () => {
      const r = el.getBoundingClientRect()
      const rect = { x: r.left, y: r.top, width: r.width, height: r.height }
      const key = JSON.stringify(rect)
      if (key === last) return
      last = key
      window.orbit.send('mini.layout', { rect, radius: CARD_RADIUS })
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [ref])
}
