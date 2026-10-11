import { Paintbrush, X } from 'lucide-react'
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TWEAK_EDITOR, type TweakEditorState } from '../../../shared/commands/tweaks'
import type { Tweak } from '../../../shared/state'
import { invoke } from '../api'
import { useOrbit, useWindow } from '../store'
import { paletteVars, usePalette } from '../theme'
import { SizeControl } from './SizeControl'
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

  // Main sizes the view to the panel: its natural height, whatever room the view has now.
  useLayoutEffect(() => {
    const parts = [head.current, content.current, foot.current]
    const report = () => {
      const height = parts.reduce((sum, el) => sum + (el?.offsetHeight ?? 0), 0) + 2
      void invoke('tweaks.editorLayout', { width: TWEAK_EDITOR.width, height })
    }
    report()
    const observer = new ResizeObserver(report)
    for (const el of parts) if (el) observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Each opening starts with the keyboard in the panel (KS-19), and so does the controls' first
  // showing after the intro: its button is gone, and the keyboard would be nowhere.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on opening, and as the intro goes
  useEffect(() => {
    panel.current?.focus({ preventScroll: true })
  }, [intro])

  // Esc anywhere in the panel closes it (BO-02), unless a field used it (a rename it cancels, say).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return
      e.preventDefault()
      void invoke('tweaks.closeEditor', {})
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const close = () => void invoke('tweaks.closeEditor', {})
  const drag = useDrag()

  return (
    <section
      ref={panel}
      className="tweak-panel"
      data-testid="tweak-panel"
      data-tweak={tweak.id}
      aria-label={`Tweak: ${tweak.name}`}
      tabIndex={-1}
      style={{ width: TWEAK_EDITOR.width }}
    >
      <header ref={head} className="tweak-panel__head" {...drag}>
        <span className="tweak-panel__badge" aria-hidden>
          <Paintbrush size={14} />
        </span>
        <div className="tweak-panel__title">
          <span className="tweak-panel__name" data-testid="tweak-name">
            {tweak.name}
          </span>
          {tweak.name !== state.host && <span className="tweak-panel__host">{state.host}</span>}
        </div>
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
          {intro ? <Intro host={state.host ?? tweak.host} /> : <Controls tweak={tweak} />}
        </div>
      </div>
      <footer ref={foot} className="tweak-panel__foot">
        {!intro && (
          <button type="button" className="tweak-button is-primary" data-testid="tweak-done" onClick={close}>
            Done
          </button>
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

function Controls({ tweak }: { tweak: Tweak }) {
  return (
    <Row label="Size">
      <SizeControl tweak={tweak} />
    </Row>
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

/**
 * Dragging the panel by its title (BO-02): main moves the view, so positions go as screen points
 * (the view moves under the pointer; the screen doesn't).
 */
function useDrag() {
  const dragging = useRef(false)
  const send = (phase: 'start' | 'move' | 'end', e: React.PointerEvent<HTMLElement>) =>
    window.orbit.send('tweaks.editorDrag', { phase, x: e.screenX, y: e.screenY })
  const end = (e: React.PointerEvent<HTMLElement>) => {
    if (!dragging.current) return
    dragging.current = false
    send('end', e)
  }
  return {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('button, input, select, textarea')) return
      dragging.current = true
      e.currentTarget.setPointerCapture(e.pointerId)
      send('start', e)
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      if (dragging.current) send('move', e)
    },
    onPointerUp: end,
    onPointerCancel: end,
  }
}
