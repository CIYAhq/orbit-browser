import { Columns2, Maximize2, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ACTIONS_BY_ID, formatAccelerator, shortcutsFor } from '../../../shared/actions'
import {
  type Box,
  FRAME_RADIUS,
  lerpBox,
  PEEK_RADIUS,
  peekCard,
  peekStart,
  scaleBox,
  splitTarget,
} from '../../../shared/peek-geometry'
import type { OverlayState } from '../../../shared/state'
import { invoke, perfMark } from '../api'
import './peek.css'

type PeekOverlay = Extract<OverlayState, { kind: 'peek' }>
type Phase = NonNullable<PeekOverlay['phase']> | 'open'

/** Springs from feel.md FL-01 (mass 1): the open is close to "standard", the expand "snappy". */
const OPEN_SPRING = { stiffness: 520, damping: 42 }
const EXPAND_SPRING = { stiffness: 632, damping: 45 }
const CLOSE_MS = 170
const FADE_MS = 130
const BUTTON = 28
const BUTTON_GAP = 8

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

/** One drawn frame of the card: where it is, its corners, and how visible the chrome and dim are. */
interface Frame {
  rect: Box
  radius: number
  /** Opacity of the backdrop dim. */
  dim: number
  /** Opacity of the card's shadow/placeholder and of the buttons. */
  chrome: number
  /** Whether the page view shows (it hides near the end of a close while the placeholder fades). */
  page: boolean
}

/**
 * Animates the Peek card. Each frame moves the chrome in the DOM and sends the same rect to main,
 * which moves the page's native view in step (FL-19, PK-06). Every phase starts from wherever the
 * card is, so a new phase retargets smoothly instead of jumping (FL-01).
 */
class PeekAnimator {
  overlay!: PeekOverlay
  backdrop: HTMLElement | null = null
  card: HTMLElement | null = null
  controls: HTMLElement | null = null
  private frame: Frame | null = null
  private raf = 0

  area(): { width: number; height: number } {
    const a = this.overlay.area
    return a && a.width > 0 ? a : { width: window.innerWidth, height: window.innerHeight }
  }

  stop(): void {
    cancelAnimationFrame(this.raf)
  }

  draw(f: Frame): void {
    this.frame = f
    const { rect, radius } = f
    if (this.card) {
      const style = this.card.style
      style.transform = `translate(${rect.x}px, ${rect.y}px)`
      style.width = `${rect.width}px`
      style.height = `${rect.height}px`
      style.borderRadius = `${radius}px`
      style.opacity = String(f.chrome)
    }
    if (this.backdrop) this.backdrop.style.opacity = String(f.dim)
    if (this.controls) {
      const x = Math.min(rect.x + rect.width + BUTTON_GAP, this.area().width - BUTTON - 4)
      this.controls.style.transform = `translate(${x}px, ${rect.y}px)`
      this.controls.style.opacity = String(Math.max(0, f.chrome * 2 - 1))
    }
    window.orbit.send('peek.frame', { nonce: this.overlay.nonce, rect, radius, visible: f.page })
  }

  /** The page area changed while open: the card takes its new place at once. */
  resize(width: number | undefined, height: number | undefined): void {
    const f = this.frame
    if (!f || (this.overlay.phase ?? 'open') !== 'open' || !width || !height) return
    this.draw({ ...f, rect: peekCard({ width, height }) })
  }

  play(phase: Phase): void {
    this.stop()
    const nonce = this.overlay.nonce
    const a = this.area()
    const card = peekCard(a)
    const reduced = reduceMotion.matches
    const settled = () => void invoke('peek.settled', { nonce })

    if (phase === 'open') {
      if (reduced) {
        this.tween(FADE_MS, (t) => this.draw({ rect: card, radius: PEEK_RADIUS, dim: t, chrome: 1, page: true }))
        return
      }
      const from = this.frame?.rect ?? peekStart(card, a, this.overlay.origin)
      this.draw({ rect: from, radius: PEEK_RADIUS, dim: 0, chrome: 1, page: true })
      this.spring(
        OPEN_SPRING,
        (p, elapsed) =>
          this.draw({
            rect: lerpBox(from, card, p),
            radius: PEEK_RADIUS,
            dim: Math.min(1, elapsed / 200),
            chrome: 1,
            page: true,
          }),
        () => perfMark('peek:opened'),
      )
      return
    }

    const start = this.frame ?? { rect: card, radius: PEEK_RADIUS, dim: 1, chrome: 1, page: true }
    if (phase === 'closing') {
      if (reduced) {
        this.tween(
          FADE_MS,
          (t) =>
            this.draw({ rect: start.rect, radius: start.radius, dim: start.dim * (1 - t), chrome: 0, page: false }),
          settled,
        )
        return
      }
      // A slight shrink and fade (FL-19). The page view can't fade, so it leaves part way and the
      // card underneath, painted in the page's colour, finishes the fade.
      const to = scaleBox(start.rect, 0.92)
      this.tween(
        CLOSE_MS,
        (e) =>
          this.draw({
            rect: lerpBox(start.rect, to, e),
            radius: start.radius,
            dim: start.dim * (1 - e),
            chrome: start.chrome * (1 - e),
            page: e < 0.45,
          }),
        settled,
      )
      return
    }

    // Expanding into a tab (the whole page area) or sliding into a split's right pane.
    const target = phase === 'splitting' ? splitTarget(a) : { x: 0, y: 0, width: a.width, height: a.height }
    if (reduced) {
      this.draw({ rect: target, radius: FRAME_RADIUS, dim: 0, chrome: 0, page: true })
      settled()
      return
    }
    this.spring(
      EXPAND_SPRING,
      (p) => {
        const q = Math.min(1, p)
        this.draw({
          rect: lerpBox(start.rect, target, p),
          radius: start.radius + (FRAME_RADIUS - start.radius) * q,
          dim: start.dim * (1 - q),
          chrome: Math.max(0, start.chrome * (1 - q * 1.6)),
          page: true,
        })
      },
      settled,
    )
  }

  /** Runs a unit spring (0 → 1) frame by frame; `done` fires once it rests. */
  private spring(
    cfg: { stiffness: number; damping: number },
    step: (p: number, elapsed: number) => void,
    done?: () => void,
  ): void {
    let x = 0
    let v = 0
    let last = 0
    let first = 0
    const tick = (now: number) => {
      if (!first) first = last = now
      // Fixed sub-steps keep the spring stable on slow frames.
      let dt = Math.min(0.05, (now - last) / 1000)
      last = now
      while (dt > 0) {
        const h = Math.min(dt, 1 / 240)
        v += (cfg.stiffness * (1 - x) - cfg.damping * v) * h
        x += v * h
        dt -= h
      }
      const resting = Math.abs(1 - x) < 0.002 && Math.abs(v) < 0.02
      step(resting ? 1 : x, now - first)
      if (resting) done?.()
      else this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  /** A timed ease-out (exits are quicker than entrances, FL-01). */
  private tween(ms: number, step: (e: number) => void, done?: () => void): void {
    let first = 0
    const tick = (now: number) => {
      if (!first) first = now
      const t = Math.min(1, (now - first) / ms)
      step(1 - (1 - t) ** 3)
      if (t >= 1) done?.()
      else this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }
}

/**
 * The Peek card's chrome (PK-05): a dimmed backdrop over the page area, the card's shadow under
 * the page view, and the Close / Open as Tab / Split View buttons beside its top corner. The page
 * itself is a native view main keeps exactly on the card.
 */
export function PeekLayer({ overlay }: { overlay: PeekOverlay }) {
  const backdropRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const controlsRef = useRef<HTMLDivElement>(null)
  const [animator] = useState(() => new PeekAnimator())
  animator.overlay = overlay
  const phase: Phase = overlay.phase ?? 'open'

  useLayoutEffect(() => {
    animator.backdrop = backdropRef.current
    animator.card = cardRef.current
    animator.controls = controlsRef.current
    return () => animator.stop()
  }, [animator])

  useLayoutEffect(() => animator.play(phase), [animator, phase])

  const width = overlay.area?.width
  const height = overlay.area?.height
  useEffect(() => animator.resize(width, height), [animator, width, height])

  // Escape closes the Peek when the overlay has focus (after clicking a button or the backdrop).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        void invoke('peek.close', {})
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="peek" data-testid="peek" data-phase={phase}>
      <div
        ref={backdropRef}
        className="peek__backdrop"
        data-testid="peek-backdrop"
        onMouseDown={(e) => {
          if (e.button === 0) void invoke('peek.close', {})
        }}
      />
      <div
        ref={cardRef}
        className="peek__card"
        data-testid="peek-card"
        style={phase === 'closing' && overlay.background ? { background: overlay.background } : undefined}
      />
      <div ref={controlsRef} className="peek__controls" data-testid="peek-controls">
        <PeekButton label="Close" hint="Esc" testId="peek-close" onClick={() => invoke('peek.close', {})}>
          <X size={15} strokeWidth={2} />
        </PeekButton>
        <PeekButton
          label="Open as Tab"
          hint={hint('peek.expand')}
          testId="peek-expand"
          onClick={() => invoke('peek.expand', {})}
        >
          <Maximize2 size={13} strokeWidth={2} />
        </PeekButton>
        <PeekButton label="Open in Split View" testId="peek-split" onClick={() => invoke('peek.split', {})}>
          <Columns2 size={14} strokeWidth={2} />
        </PeekButton>
      </div>
    </div>
  )
}

function hint(actionId: string): string | undefined {
  const action = ACTIONS_BY_ID[actionId]
  const accel = action ? shortcutsFor(action, window.orbit.platform)[0] : undefined
  return accel ? formatAccelerator(accel, window.orbit.platform) : undefined
}

function PeekButton(props: {
  label: string
  hint?: string
  testId: string
  onClick: () => unknown
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      className="peek__button"
      aria-label={props.label}
      title={props.hint ? `${props.label} (${props.hint})` : props.label}
      data-testid={props.testId}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => void props.onClick()}
    >
      {props.children}
    </button>
  )
}
