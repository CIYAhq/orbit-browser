import { Braces, Paintbrush, X } from 'lucide-react'
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TWEAK_EDITOR, type TweakEditorState } from '../../../shared/commands/tweaks'
import type { Tweak } from '../../../shared/state'
import { subdomainsPossible } from '../../../shared/tweaks'
import { invoke } from '../api'
import { useOrbit, useWindow } from '../store'
import { paletteVars, usePalette } from '../theme'
import { CodeArea } from './CodeArea'
import { ColorArea } from './ColorArea'
import { flushTweakEdits, updateTweak } from './edit'
import { HideArea, HideButton } from './HideArea'
import { SizeControl } from './SizeControl'
import { TitleMenu } from './TitleMenu'
import { CaseControl, FontPresets } from './TypeControls'
import './code.css'
import './controls.css'
import './tweaks.css'

/**
 * The Tweak editor panel's view (BO-02): main keeps it over the top-right corner of the page the
 * Tweak edits and sizes it to the panel, so the page around it stays live. Main says what to show
 * (`tweakEditor`); the Tweak itself comes from the state.
 */
export function TweakEditorApp() {
  const win = useWindow()
  const palette = usePalette(win?.spaceId)
  const [state, setState] = useState<TweakEditorState | null>(null)
  useEffect(() => {
    let alive = true
    let pushed = false
    const off = window.orbit.on('tweakEditor', (payload) => {
      pushed = true
      setState(payload as TweakEditorState)
    })
    // Main may have opened the panel before this page could hear it.
    void invoke('tweaks.editorState', {}).then((s) => {
      if (alive && !pushed) setState(s)
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  const tweak = useOrbit((s) => (state?.tweakId ? s.tweaks[state.tweakId] : undefined))
  const introSeen = useOrbit((s) => s.settings.tweakIntroSeen)
  return (
    <div
      className={`tweak-view${palette?.dark ? ' is-dark' : ''}`}
      style={paletteVars(palette) as CSSProperties}
      data-testid="tweak-view"
    >
      {state?.open && tweak && <TweakPanel key={state.nonce} state={state} tweak={tweak} intro={!introSeen} />}
    </div>
  )
}

function TweakPanel({ state, tweak, intro }: { state: TweakEditorState; tweak: Tweak; intro: boolean }) {
  const panel = useRef<HTMLElement>(null)
  const head = useRef<HTMLElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const foot = useRef<HTMLElement>(null)
  // The code area (BO-11) widens the panel; a Tweak with code opens with it.
  const [code, setCode] = useState(() => !!(tweak.css.trim() || tweak.js.trim()))
  const width = code && !intro ? TWEAK_EDITOR.wideWidth : TWEAK_EDITOR.width

  // Main sizes the view to the panel: its natural height, whatever room the view has now.
  useLayoutEffect(() => {
    const parts = [head.current, content.current, foot.current]
    const report = () => {
      const height = parts.reduce((sum, el) => sum + (el?.offsetHeight ?? 0), 0) + 2
      void invoke('tweaks.editorLayout', { width, height })
    }
    report()
    const observer = new ResizeObserver(report)
    for (const el of parts) if (el) observer.observe(el)
    return () => observer.disconnect()
  }, [width])

  // Each opening starts with the keyboard in the panel (KS-19), and so does the controls' first
  // showing after the intro: its button is gone, and the keyboard would be nowhere.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on opening, and as the intro goes
  useEffect(() => {
    panel.current?.focus({ preventScroll: true })
  }, [intro])

  // Esc anywhere in the panel steps back (BO-02, BO-10): a pick in Hide-element mode, then the
  // mode, then the panel; unless a field used it (a rename it cancels, say).
  const hide = useRef(state.hide)
  hide.current = state.hide
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return
      e.preventDefault()
      if (hide.current.pick) void invoke('tweaks.hideCancel', {})
      else if (hide.current.on) void invoke('tweaks.hideMode', { on: false })
      else closeEditor()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const close = closeEditor
  const drag = useDrag()

  return (
    <section
      ref={panel}
      className="tweak-panel"
      data-testid="tweak-panel"
      data-tweak={tweak.id}
      aria-label={`Tweak: ${tweak.name}`}
      tabIndex={-1}
      style={{ width }}
    >
      <header ref={head} className="tweak-panel__head" {...drag}>
        <span className="tweak-panel__badge" aria-hidden>
          <Paintbrush size={14} />
        </span>
        <TitleMenu tweak={tweak} host={state.host} intro={intro} />
        <button
          type="button"
          className="tweak-panel__icon"
          data-testid="tweak-close"
          aria-label="Close"
          title="Close (Esc)"
          onClick={close}
        >
          <X size={15} />
        </button>
      </header>
      <div className="tweak-panel__body">
        <div ref={content} className="tweak-panel__content">
          {intro ? (
            <Intro host={state.host ?? tweak.host} />
          ) : (
            <>
              <Controls tweak={tweak} state={state} code={code} onCode={() => setCode(!code)} />
              {code && <CodeArea tweak={tweak} state={state} />}
            </>
          )}
        </div>
      </div>
      <footer ref={foot} className="tweak-panel__foot">
        {!intro && (
          <>
            <Scope tweak={tweak} host={state.host} />
            <button type="button" className="tweak-button is-primary" data-testid="tweak-done" onClick={close}>
              Done
            </button>
          </>
        )}
      </footer>
    </section>
  )
}

/** The first-use intro (BO-01): read once, then never again. */
function Intro({ host }: { host: string }) {
  return (
    <div className="tweak-intro" data-testid="tweak-intro">
      <div className="tweak-intro__art" aria-hidden>
        <Paintbrush size={22} />
      </div>
      <h2 className="tweak-intro__title">Tweak any website</h2>
      <p className="tweak-intro__text">
        Change how <strong>{host}</strong> looks: its colours, fonts and size, or hide what you don't need. Every change
        shows at once and is saved as you go.
      </p>
      <p className="tweak-intro__text">
        Tweaks stay on this device and come back each time you visit. Turn them off any time from the site controls.
      </p>
      <button
        type="button"
        className="tweak-button is-primary is-wide"
        data-testid="tweak-intro-start"
        onClick={() => void invoke('tweaks.dismissIntro', {})}
      >
        Start Tweaking
      </button>
    </div>
  )
}

/** Closes the panel, once the code still being typed is saved (BO-02, BO-11). */
function closeEditor(): void {
  flushTweakEdits()
  void invoke('tweaks.closeEditor', {})
}

/** The controls, top to bottom as BO-02 lists them: colours, font, size, case, hiding and code. */
function Controls({
  tweak,
  state,
  code,
  onCode,
}: {
  tweak: Tweak
  state: TweakEditorState
  code: boolean
  onCode: () => void
}) {
  return (
    <>
      <ColorArea tweak={tweak} />
      <Row label="Font">
        <FontPresets tweak={tweak} />
      </Row>
      <Row label="Size">
        <SizeControl tweak={tweak} />
      </Row>
      <Row label="Text case">
        <CaseControl tweak={tweak} />
      </Row>
      <div className="tweak-tools">
        <HideButton on={state.hide.on} />
        <button
          type="button"
          className="tweak-color__tool tweak-tools__button"
          data-testid="tweak-code-button"
          aria-pressed={code}
          title={code ? 'Hide the code' : 'CSS and JavaScript'}
          onClick={onCode}
        >
          <Braces size={15} aria-hidden />
          Code
        </button>
      </div>
      <HideArea tweak={tweak} state={state} />
    </>
  )
}

/**
 * Which pages the Tweak is for (BO-17): its site's, and with the box ticked its subdomains' too.
 * Not offered for an address by number; fixed while the page is on a subdomain the box brings in.
 */
function Scope({ tweak, host }: { tweak: Tweak; host: string | null }) {
  if (!subdomainsPossible(tweak.host)) return <span className="tweak-panel__spacer" />
  const viaParent = !!host && host !== tweak.host
  return (
    <label
      className="tweak-check tweak-panel__spacer"
      title={viaParent ? `This page is on a subdomain of ${tweak.host}` : `Pages on any subdomain of ${tweak.host} too`}
    >
      <input
        type="checkbox"
        data-testid="tweak-subdomains"
        checked={tweak.subdomains}
        disabled={viaParent}
        onChange={(e) => updateTweak(tweak.id, { subdomains: e.currentTarget.checked })}
      />
      <span>Also apply to subdomains</span>
    </label>
  )
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="tweak-row">
      <span className="tweak-row__label">{label}</span>
      <div className="tweak-row__control">{children}</div>
    </div>
  )
}

/** How far the pointer moves on the name before the press is a drag, not a click on its menu. */
const DRAG_SLOP = 4

/**
 * Dragging the panel by its title (BO-02): main moves the view, so positions go as screen points
 * (the view moves under the pointer; the screen doesn't). The name drags too once the pointer
 * moves; pressed and let go where it was, it opens its menu. Other controls never drag.
 */
function useDrag() {
  const press = useRef<{ x: number; y: number; dragging: boolean } | null>(null)
  const dragged = useRef(false)
  const send = (phase: 'start' | 'move' | 'end', at: { screenX: number; screenY: number }) =>
    window.orbit.send('tweaks.editorDrag', { phase, x: at.screenX, y: at.screenY })
  const begin = () => {
    const p = press.current
    if (!p || p.dragging) return
    p.dragging = true
    send('start', { screenX: p.x, screenY: p.y })
  }
  const end = (e: React.PointerEvent<HTMLElement>) => {
    const p = press.current
    press.current = null
    if (!p?.dragging) return
    dragged.current = true
    send('end', e)
  }
  return {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return
      const control = (e.target as HTMLElement).closest('button, input, select, textarea')
      if (control && !control.matches('.tweak-panel__name:not(:disabled)')) return
      dragged.current = false
      press.current = { x: e.screenX, y: e.screenY, dragging: false }
      // The pointer stays with what it pressed, wherever it goes: the title, or the name, which
      // keeps its own click.
      ;(control ?? e.currentTarget).setPointerCapture(e.pointerId)
      if (!control) begin()
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const p = press.current
      if (!p) return
      if (!p.dragging && Math.hypot(e.screenX - p.x, e.screenY - p.y) < DRAG_SLOP) return
      begin()
      send('move', e)
    },
    onPointerUp: end,
    onPointerCancel: end,
    // A drag that started on the name doesn't open its menu as it ends.
    onClickCapture: (e: React.MouseEvent<HTMLElement>) => {
      if (!dragged.current) return
      dragged.current = false
      e.stopPropagation()
      e.preventDefault()
    },
  }
}
