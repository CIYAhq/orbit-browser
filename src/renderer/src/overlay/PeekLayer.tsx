import { Columns2, Maximize2, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ACTIONS_BY_ID, formatAccelerator, shortcutsFor } from '../../../shared/actions'
import {
  advanceSpring,
  type Box,
  dismissesOnRelease,
  draggedCard,
  lerpBox,
  PEEK_CLOSE_MS,
  PEEK_CLOSE_SCALE,
  PEEK_EXPAND_SPRING,
  PEEK_OPEN_SPRING,
  peekCard,
  peekStart,
  releaseVelocity,
  type Spring,
  scaleBox,
  splitTarget,
  springResting,
} from '../../../shared/peek-geometry'
import type { OverlayState } from '../../../shared/state'
import { invoke, perfMark } from '../api'
import { useKeymap } from '../keys/live'
import { REDUCED, reducedMotion } from '../motion'
import './peek.css'

type PeekOverlay = Extract<OverlayState, { kind: 'peek' }>
type Phase = NonNullable<PeekOverlay['phase']> | 'open'

/** Reduced motion: the card fades in and out in place (FL-28). */
const FADE_MS = REDUCED.fadeMs
const BUTTON = 28
const BUTTON_GAP = 8
/** The grab handle above the card (PK-06): its hit area, centred over the card's top edge. */
const HANDLE_HIT_W = 160
const HANDLE_HIT_H = 30
/** A trackpad swipe has ended when no wheel event came for this long. */
const WHEEL_END_MS = 120

/** One drawn frame of the card: where it is, and how visible it, its chrome and the dim are. */
interface Frame {
  rect: Box
  /** Opacity of the backdrop dim. */
  dim: number
  /** Opacity of the card's shadow and of the buttons and handle. */
  chrome: number
  /** Opacity of the card itself: the page's still, or its colour until there is one. */
  sheet: number
}

/** A drag of the handle or a two-finger swipe that the card is following (PK-06). */
interface Drag {
  /** The card when the drag began (the open animation may have been mid-way). */
  base: Box
  /** Backdrop dim when the drag began. */
  dim: number
  /** Distance moved, px, positive downward. */
  offset: number
  samples: { t: number; y: number }[]
  /** Pointer y at the press, for a handle drag; undefined for a swipe. */
  pointerY?: number
  wheelTimer?: number
}

/**
 * Animates the Peek card with transform and opacity only (FL-01). The card is laid out once at its
 * size at rest, and shows a still of the page (PK-06): main keeps the page's native view out of
 * sight while the card moves, and puts it on the card when the card comes to rest, so the page is
 * laid out at its size once and never every frame. Every phase starts from wherever the card is, so
 * a new phase retargets smoothly instead of jumping (FL-01).
 */
class PeekAnimator {
  overlay!: PeekOverlay
  backdrop: HTMLElement | null = null
  card: HTMLElement | null = null
  shadow: HTMLElement | null = null
  still: HTMLImageElement | null = null
  controls: HTMLElement | null = null
  handle: HTMLElement | null = null
  private frame: Frame | null = null
  /** The card's size at rest, which its elements are laid out at. */
  private base: Box | null = null
  /** Whether main was last told to show the page on the card. */
  private pageShown = false
  private raf = 0
  private drag: Drag | null = null
  /** A drag or swipe let go past the threshold: the card is already leaving. */
  private leaving = false
  /** How many stills main has sent: only the last one asked for shows. */
  private stillAsked = 0

  area(): { width: number; height: number } {
    const a = this.overlay.area
    return a && a.width > 0 ? a : { width: window.innerWidth, height: window.innerHeight }
  }

  stop(): void {
    cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  dispose(): void {
    this.stop()
    this.cancelDrag()
  }

  draw(f: Frame): void {
    this.frame = f
    const { rect } = f
    const base = peekCard(this.area())
    if (!this.base || this.base.width !== base.width || this.base.height !== base.height) {
      this.base = base
      for (const el of [this.card, this.shadow]) {
        if (!el) continue
        el.style.width = `${base.width}px`
        el.style.height = `${base.height}px`
      }
    }
    // The card at rest, moved and scaled to this frame's box.
    const sx = rect.width / base.width
    const sy = rect.height / base.height
    const transform = `translate(${rect.x}px, ${rect.y}px) scale(${sx}, ${sy})`
    if (this.card) {
      this.card.style.transform = transform
      this.card.style.opacity = String(f.sheet)
    }
    // The still keeps the page's proportions, scaled alike both ways to cover the card, which crops
    // it (a split's pane is narrower than the card).
    const cover = Math.max(sx, sy)
    if (this.still && sx > 0 && sy > 0) this.still.style.transform = `scale(${cover / sx}, ${cover / sy})`
    if (this.shadow) {
      this.shadow.style.transform = transform
      this.shadow.style.opacity = String(f.chrome)
    }
    if (this.backdrop) this.backdrop.style.opacity = String(f.dim)
    const chromeOpacity = String(Math.max(0, f.chrome * 2 - 1))
    if (this.controls) {
      const x = Math.min(rect.x + rect.width + BUTTON_GAP, this.area().width - BUTTON - 4)
      this.controls.style.transform = `translate(${x}px, ${rect.y}px)`
      this.controls.style.opacity = chromeOpacity
    }
    if (this.handle) {
      const height = Math.max(12, Math.min(rect.y, HANDLE_HIT_H))
      const style = this.handle.style
      style.transform = `translate(${rect.x + rect.width / 2 - HANDLE_HIT_W / 2}px, ${rect.y - height}px)`
      style.height = `${height}px`
      style.opacity = chromeOpacity
    }
  }

  /**
   * Tells main whether the page shows on the card (it is at rest) or waits out of sight (the card
   * moves). `force` says it even when nothing changed: a drag takes the page over from main.
   */
  private showPage(shown: boolean, force = false): void {
    if (this.pageShown === shown && !force) return
    this.pageShown = shown
    window.orbit.send('peek.page', { nonce: this.overlay.nonce, shown })
  }

  /**
   * A new still of the page: the card shows it once it is decoded, so it never shows half drawn. No
   * still (`''`: the page crashed or failed to load) drops the one it has, and the card shows its own
   * colour. A decode that ends after a later still was asked for is left.
   */
  setStill(url: string): void {
    const still = this.still
    if (!still) return
    const asked = ++this.stillAsked
    if (!url) {
      delete still.dataset.ready
      still.removeAttribute('src')
      return
    }
    const next = new Image()
    next.src = url
    next.decode().then(
      () => {
        if (this.still !== still || this.stillAsked !== asked) return
        still.src = url
        still.dataset.ready = 'true'
      },
      () => {},
    )
  }

  /** The card came to rest: the page shows on it. */
  private atRest(): void {
    this.showPage(true)
  }

  /** The page area changed while open: the card takes its new place at once. */
  resize(width: number | undefined, height: number | undefined): void {
    const f = this.frame
    if (!f || this.drag || this.leaving || (this.overlay.phase ?? 'open') !== 'open' || !width || !height) return
    this.draw({ ...f, rect: peekCard({ width, height }) })
  }

  play(phase: Phase): void {
    // Already leaving after a drag: main's "closing" confirms what is on screen.
    if (phase === 'closing' && this.leaving) return
    this.cancelDrag()
    this.stop()
    const a = this.area()
    const card = peekCard(a)
    const reduced = reducedMotion()
    const settled = this.settler()

    if (phase === 'open') {
      if (reduced) {
        // At its place from the start: the page shows on it while the dim fades in.
        this.draw({ rect: card, dim: 0, chrome: 1, sheet: 1 })
        this.atRest()
        this.tween(
          FADE_MS,
          (t) => this.draw({ rect: card, dim: t, chrome: 1, sheet: 1 }),
          () => perfMark('peek:opened'),
        )
        return
      }
      const from = this.frame?.rect ?? peekStart(card, a, this.overlay.origin)
      this.draw({ rect: from, dim: 0, chrome: 1, sheet: 1 })
      this.spring(
        PEEK_OPEN_SPRING,
        (p, elapsed) =>
          this.draw({
            rect: lerpBox(from, card, p),
            dim: Math.min(1, elapsed / 200),
            chrome: 1,
            sheet: 1,
          }),
        () => {
          this.atRest()
          perfMark('peek:opened')
        },
      )
      return
    }

    if (phase === 'closing') {
      this.close(0, false)
      return
    }

    // Expanding into a tab (the whole page area) or sliding into a split's right pane: the card,
    // showing the page's still, grows there while main lays the page out at that size, out of sight.
    const start = this.frame ?? { rect: card, dim: 1, chrome: 1, sheet: 1 }
    const target = phase === 'splitting' ? splitTarget(a) : { x: 0, y: 0, width: a.width, height: a.height }
    this.pageShown = false
    if (reduced) {
      this.draw({ rect: target, dim: 0, chrome: 0, sheet: 1 })
      settled()
      return
    }
    this.spring(
      PEEK_EXPAND_SPRING,
      (p) => {
        const q = Math.min(1, p)
        this.draw({
          rect: lerpBox(start.rect, target, p),
          dim: start.dim * (1 - q),
          chrome: Math.max(0, start.chrome * (1 - q * 1.6)),
          sheet: 1,
        })
      },
      settled,
    )
  }

  /** Tells main the running transition finished (it then commits the close, expand or split). */
  private settler(): () => void {
    const nonce = this.overlay.nonce
    return () => void invoke('peek.settled', { nonce })
  }

  /**
   * The close (FL-19): a slight shrink and fade, or under reduced motion a fade (FL-28). After a
   * drag the card keeps going down at the speed it was let go (velocity carries over, FL-01).
   * The page view can't fade: it goes at once (main hides it), and the card shows its still.
   */
  private close(velocity: number, dragged: boolean): void {
    const start = this.frame ?? { rect: peekCard(this.area()), dim: 1, chrome: 1, sheet: 1 }
    const settled = this.settler()
    this.pageShown = false
    if (reducedMotion()) {
      this.tween(
        FADE_MS,
        (t) =>
          this.draw({
            rect: start.rect,
            dim: start.dim * (1 - t),
            chrome: start.chrome * (1 - t),
            sheet: start.sheet * (1 - t),
          }),
        settled,
      )
      return
    }
    const to = scaleBox(start.rect, PEEK_CLOSE_SCALE)
    // An ease-out starts at 3× its average speed: travel so that matches the release speed.
    // Let go moving down: it keeps going that way as it fades, a little further for a faster flick.
    if (dragged) to.y += Math.min(this.area().height, Math.max(40, (Math.max(0, velocity) * PEEK_CLOSE_MS) / 3000))
    this.tween(
      PEEK_CLOSE_MS,
      (e) =>
        this.draw({
          rect: lerpBox(start.rect, to, e),
          dim: start.dim * (1 - e),
          chrome: start.chrome * (1 - e),
          sheet: start.sheet * (1 - e),
        }),
      settled,
    )
  }

  // ---- Interactive dismiss (PK-06, FL-19) ----

  /**
   * Starts following a drag or swipe; only an open card can be dragged. A press is a real
   * sample (the pointer was there then); a swipe's first event is its first sample, so a single
   * wheel tick carries no speed. Samples carry the input's own time (`event.timeStamp`), so a
   * busy frame that delivers several events at once does not turn into a flick.
   */
  private beginDrag(pointerY?: number, t = performance.now()): Drag | null {
    if (this.drag) return this.drag
    if ((this.overlay.phase ?? 'open') !== 'open' || this.leaving) return null
    // Interrupts the open spring wherever it is (FL-01). The page waits out of sight while the
    // card, showing its still, follows the input.
    this.stop()
    this.showPage(false, true)
    const f = this.frame
    this.drag = {
      base: f?.rect ?? peekCard(this.area()),
      dim: f?.dim ?? 1,
      offset: 0,
      samples: pointerY === undefined ? [] : [{ t, y: 0 }],
      pointerY,
    }
    return this.drag
  }

  /** The card follows the input 1:1 downward, shrinking a little; the dim lifts as it goes. */
  private moveDrag(d: Drag, offset: number, t = performance.now()): void {
    d.offset = offset
    d.samples.push({ t, y: offset })
    if (d.samples.length > 32) d.samples.shift()
    const restHeight = peekCard(this.area()).height
    const rect = draggedCard(d.base, offset, restHeight)
    const progress = Math.max(0, Math.min(1, (rect.y - d.base.y) / restHeight))
    this.draw({ rect, dim: d.dim * (1 - 0.6 * progress), chrome: 1 - 0.4 * progress, sheet: 1 })
  }

  /** Let go: past the threshold (or flicked) the card leaves; otherwise it springs back. */
  private endDrag(now = performance.now()): void {
    const d = this.drag
    if (!d) return
    this.drag = null
    clearTimeout(d.wheelTimer)
    const restHeight = peekCard(this.area()).height
    const velocity = releaseVelocity(d.samples, now)
    if (dismissesOnRelease(d.offset, restHeight, velocity)) {
      this.leaving = true
      this.close(velocity, true)
      void invoke('peek.close', {})
      return
    }
    this.springBack(velocity, d.offset)
  }

  private cancelDrag(): void {
    if (this.drag) clearTimeout(this.drag.wheelTimer)
    this.drag = null
  }

  /** Back to the card's place, starting with the speed it was let go at (FL-01). */
  private springBack(velocity: number, offset: number): void {
    const from = this.frame
    if (!from) return
    const card = peekCard(this.area())
    const step = (p: number) => {
      const q = Math.min(1, p)
      this.draw({
        rect: lerpBox(from.rect, card, p),
        dim: from.dim + (1 - from.dim) * q,
        chrome: from.chrome + (1 - from.chrome) * q,
        sheet: 1,
      })
    }
    const back = () => this.atRest()
    if (reducedMotion()) {
      this.tween(FADE_MS, step, back)
      return
    }
    // In spring units (0 → 1 is the whole way back); moving down is moving away.
    const v0 = Math.abs(offset) > 1 ? Math.max(-30, Math.min(30, -velocity / Math.abs(offset))) : 0
    this.spring(PEEK_OPEN_SPRING, step, back, v0)
  }

  pointerDown(clientY: number, t: number): boolean {
    if (this.drag) return false
    return !!this.beginDrag(clientY, t)
  }

  pointerMove(clientY: number, t: number): void {
    const d = this.drag
    if (d?.pointerY !== undefined) this.moveDrag(d, clientY - d.pointerY, t)
  }

  pointerUp(t: number): void {
    if (this.drag?.pointerY !== undefined) this.endDrag(t)
  }

  /** A two-finger swipe over the dimmed page or the handle moves the card the same way. */
  wheel(deltaY: number, deltaMode: number, pinch: boolean, t: number): void {
    if (pinch) return
    const existing = this.drag
    if (existing?.pointerY !== undefined) return
    const d = existing ?? this.beginDrag()
    if (!d) return
    // Fingers moving down scroll the content up (negative delta): the card goes down with them.
    const dy = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * this.area().height : deltaY
    this.moveDrag(d, d.offset - dy, t)
    clearTimeout(d.wheelTimer)
    d.wheelTimer = window.setTimeout(() => this.drag === d && this.endDrag(t), WHEEL_END_MS)
  }

  /**
   * Runs a unit spring (0 → 1) frame by frame; `done` fires once it rests. Its clock starts now, so
   * the first frame after the change already moves (FL-29), as a new phase must.
   */
  private spring(
    cfg: Spring,
    step: (p: number, elapsed: number) => void,
    done?: () => void,
    initialVelocity = 0,
  ): void {
    let x = 0
    let v = initialVelocity
    const first = performance.now()
    let last = first
    const tick = (now: number) => {
      // A frame's time can be a little before the call that started the spring.
      const next = advanceSpring(cfg, x, v, (now - last) / 1000)
      x = next.x
      v = next.v
      last = Math.max(last, now)
      const resting = springResting(x, v)
      step(resting ? 1 : x, Math.max(0, now - first))
      if (resting) {
        this.raf = 0
        done?.()
      } else this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  /** A timed ease-out (exits are quicker than entrances, FL-01). Its clock starts now, as the spring's does. */
  private tween(ms: number, step: (e: number) => void, done?: () => void): void {
    const first = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, now - first) / ms)
      step(1 - (1 - t) ** 3)
      if (t >= 1) {
        this.raf = 0
        done?.()
      } else this.raf = requestAnimationFrame(tick)
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
  // The buttons' tooltips follow remapped shortcuts (KS-18).
  useKeymap()
  const backdropRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const shadowRef = useRef<HTMLDivElement>(null)
  const stillRef = useRef<HTMLImageElement>(null)
  const controlsRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<HTMLDivElement>(null)
  const [animator] = useState(() => new PeekAnimator())
  const [grabbing, setGrabbing] = useState(false)
  animator.overlay = overlay
  const phase: Phase = overlay.phase ?? 'open'

  useLayoutEffect(() => {
    animator.backdrop = backdropRef.current
    animator.card = cardRef.current
    animator.shadow = shadowRef.current
    animator.still = stillRef.current
    animator.controls = controlsRef.current
    animator.handle = handleRef.current
    return () => animator.dispose()
  }, [animator])

  useLayoutEffect(() => animator.play(phase), [animator, phase])

  // Stills of the page, for the card to show while the page's view is out of sight (PK-06).
  const nonce = overlay.nonce
  useEffect(
    () =>
      window.orbit.on('peek:still', (payload) => {
        const still = payload as { nonce: number; url: string }
        if (still.nonce === nonce) animator.setStill(still.url)
      }),
    [animator, nonce],
  )

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
        onWheel={(e) => animator.wheel(e.deltaY, e.deltaMode, e.ctrlKey, e.timeStamp)}
      />
      <div ref={shadowRef} className="peek__shadow" />
      <div
        ref={cardRef}
        className="peek__card"
        data-testid="peek-card"
        style={phase === 'closing' && overlay.background ? { background: overlay.background } : undefined}
      >
        <img ref={stillRef} className="peek__still" data-testid="peek-still" alt="" draggable={false} />
      </div>
      {/* Drag the handle (or swipe) down to dismiss; let go early and the card springs back (PK-06). */}
      <div
        ref={handleRef}
        className={`peek__handle${grabbing ? ' is-grabbing' : ''}`}
        data-testid="peek-handle"
        title="Drag down to close"
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.preventDefault()
          if (!animator.pointerDown(e.clientY, e.timeStamp)) return
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch {
            // The pointer is already gone; the drag ends on the next pointerup.
          }
          setGrabbing(true)
        }}
        onPointerMove={(e) => animator.pointerMove(e.clientY, e.timeStamp)}
        onPointerUp={(e) => {
          setGrabbing(false)
          animator.pointerUp(e.timeStamp)
        }}
        onPointerCancel={(e) => {
          setGrabbing(false)
          animator.pointerUp(e.timeStamp)
        }}
        onWheel={(e) => animator.wheel(e.deltaY, e.deltaMode, e.ctrlKey, e.timeStamp)}
      >
        <span className="peek__grabber" />
      </div>
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
