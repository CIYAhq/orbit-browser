import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { type CSSProperties, useEffect, useRef, useState } from 'react'
import type { FindState, ZoomIndicator } from '../../../../shared/nav'
import { invoke, runAction } from '../../api'
import { withShortcut } from '../../shell/chrome/shortcut-label'
import { useWindow } from '../../store'
import { paletteVars, usePalette } from '../../theme'
import './find.css'

interface ToolsState {
  find: FindState
  zoom: ZoomIndicator | null
}

/** The last focus request the bar acted on: returning to a tab shows its bar without taking focus. */
let focusTaken = 0

/**
 * The page tools (NV-05, NV-06): a small transparent view main keeps over the top-right corner of
 * the active page. It holds the find bar while it is open for that tab and the zoom indicator for a
 * moment after each zoom change; main sizes and places the view to fit what shows.
 */
export function PageToolsApp() {
  const win = useWindow()
  const palette = usePalette(win?.spaceId)
  const [state, setState] = useState<ToolsState | null>(null)
  useEffect(() => {
    let alive = true
    let pushed = false
    const off = window.orbit.on('pageTools', (payload) => {
      pushed = true
      setState(payload as ToolsState)
    })
    // Main may have opened the bar before this renderer was ready to hear it.
    void invoke('pageTools.state', {}).then((s) => {
      if (alive && !pushed) setState(s)
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  const find = state?.find
  const zoom = state?.zoom
  return (
    <div
      className={`page-tools${palette?.dark ? ' page-tools--dark' : ''}`}
      style={paletteVars(palette) as CSSProperties}
      data-testid="page-tools"
    >
      {find?.open && <FindBar key={find.tabId ?? ''} state={find} />}
      {zoom && <ZoomPill key={zoom.nonce} zoom={zoom} />}
    </div>
  )
}

function FindBar({ state }: { state: FindState }) {
  const input = useRef<HTMLInputElement>(null)
  const composing = useRef(false)
  const [empty, setEmpty] = useState(state.query === '')

  // ⌘F (or a selection to search for): the field takes main's text, selected, and keyboard focus.
  useEffect(() => {
    const el = input.current
    if (!el) return
    if (state.focus > focusTaken) {
      focusTaken = state.focus
      el.value = state.query
      setEmpty(state.query === '')
      el.focus()
      el.select()
      // Keys typed for the bar before it had the keyboard come now.
      void invoke('find.focused', { focus: state.focus })
    } else if (document.activeElement !== el && el.value !== state.query) {
      el.value = state.query
      setEmpty(state.query === '')
    }
  }, [state.focus, state.query])

  const send = () => {
    const el = input.current
    if (!el) return
    setEmpty(el.value === '')
    void invoke('find.update', { query: el.value })
  }

  const count = !state.query
    ? ''
    : !state.searched
      ? ''
      : state.matches === 0
        ? 'No matches'
        : `${Math.max(state.active, 1)}/${state.matches}`
  const none = state.searched && !!state.query && state.matches === 0

  return (
    <div className={`find-bar${none ? ' find-bar--none' : ''}`} data-testid="find-bar" role="search">
      <input
        ref={input}
        className="find-bar__input"
        data-testid="find-input"
        type="text"
        defaultValue={state.query}
        placeholder="Find in page"
        aria-label="Find in page"
        spellCheck={false}
        autoComplete="off"
        onInput={() => {
          // An input method composes first: search for what it commits, not each step.
          if (!composing.current) send()
        }}
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={() => {
          composing.current = false
          send()
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || composing.current) return
          if (e.key === 'Enter') {
            e.preventDefault()
            void invoke('find.step', { forward: !e.shiftKey })
          } else if (e.key === 'Escape') {
            e.preventDefault()
            void invoke('find.close', {})
          }
        }}
      />
      <span
        className="find-bar__count"
        data-testid="find-count"
        data-empty={none ? 'true' : 'false'}
        aria-live="polite"
        hidden={empty && !count}
      >
        {count}
      </span>
      <span className="find-bar__sep" aria-hidden />
      <button
        type="button"
        className="find-bar__button"
        data-testid="find-prev"
        aria-label="Previous match"
        title={withShortcut('Previous match', 'page.findPrevious')}
        disabled={state.matches === 0}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void invoke('find.step', { forward: false })}
      >
        <ChevronUp size={16} />
      </button>
      <button
        type="button"
        className="find-bar__button"
        data-testid="find-next"
        aria-label="Next match"
        title={withShortcut('Next match', 'page.findNext')}
        disabled={state.matches === 0}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void invoke('find.step', { forward: true })}
      >
        <ChevronDown size={16} />
      </button>
      <button
        type="button"
        className="find-bar__button"
        data-testid="find-close"
        aria-label="Close find bar"
        title="Close (Esc)"
        onClick={() => void invoke('find.close', {})}
      >
        <X size={15} />
      </button>
    </div>
  )
}

function ZoomPill({ zoom }: { zoom: ZoomIndicator }) {
  return (
    <div
      className="zoom-pill"
      data-testid="zoom-indicator"
      role="status"
      onMouseEnter={() => void invoke('pageTools.hover', { over: true })}
      onMouseLeave={() => void invoke('pageTools.hover', { over: false })}
    >
      <span className="zoom-pill__percent" data-testid="zoom-percent">
        {zoom.percent}%
      </span>
      {zoom.percent !== 100 && (
        <button
          type="button"
          className="zoom-pill__reset"
          data-testid="zoom-reset"
          title={withShortcut('Reset zoom', 'page.zoomReset')}
          onClick={() => runAction('page.zoomReset')}
        >
          Reset
        </button>
      )}
    </div>
  )
}
