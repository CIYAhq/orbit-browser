import { reducedMotion } from '../shell/sidebar/motion-tokens'

/** The flight's length (DL-02: about 400–600 ms, ease-out). */
const FLIGHT_MS = 520
const FADE_MS = 450
const ICON = 26
/** Ease-out: fast from the page, settling into the Library button. */
const EASE_OUT = 'cubic-bezier(0.2, 0, 0, 1)'

/** A point on the quadratic curve from `a` to `b` bent toward `c`. */
function curve(a: Point, c: Point, b: Point, t: number): Point {
  const u = 1 - t
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y }
}

interface Point {
  x: number
  y: number
}

const FILE_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>
  <path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/></svg>`

/**
 * A download just started (DL-02): a small file icon flies from the page, along a short curve, into
 * the Library button at the bottom of the sidebar, which gives a little bounce as it lands. Each
 * download gets its own flight. With "reduce motion" the icon only fades in and out on the button.
 *
 * The page is drawn over the shell, so the flight starts at the page's edge, where it comes into
 * view.
 */
export function flyToLibrary(filename: string): void {
  const target = document.querySelector<HTMLElement>('[data-testid="library-button"]')
  if (!target) return
  const box = target.getBoundingClientRect()
  if (box.width === 0) return
  const end = { x: box.left + box.width / 2, y: box.top + box.height / 2 }
  const el = document.createElement('div')
  el.className = 'download-flight'
  el.setAttribute('data-testid', 'download-flight')
  el.setAttribute('aria-hidden', 'true')
  el.title = filename
  el.innerHTML = FILE_ICON
  document.body.appendChild(el)
  const at = (p: Point, scale: number) => `translate(${p.x - ICON / 2}px, ${p.y - ICON / 2}px) scale(${scale})`

  if (reducedMotion()) {
    el.dataset.motion = 'fade'
    const fade = el.animate(
      [
        { transform: at(end, 0.9), opacity: 0 },
        { transform: at(end, 0.9), opacity: 1, offset: 0.4 },
        { transform: at(end, 0.9), opacity: 0 },
      ],
      { duration: FADE_MS, easing: 'ease-in-out', id: 'download-fade' },
    )
    fade.onfinish = fade.oncancel = () => el.remove()
    return
  }

  el.dataset.motion = 'flight'
  const frame = document.querySelector<HTMLElement>('[data-testid="content-frame"]')?.getBoundingClientRect()
  const start =
    frame && frame.width > 0
      ? { x: frame.left + ICON / 2, y: frame.top + frame.height * 0.4 }
      : { x: end.x + 180, y: end.y - 260 }
  // Up a little first, then down into the button.
  const bend = { x: (start.x + end.x) / 2, y: Math.min(start.y, end.y) - 70 }
  const steps = 16
  const frames: Keyframe[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const opacity = t < 0.12 ? t / 0.12 : t > 0.88 ? Math.max(0.25, (1 - t) / 0.12) : 1
    frames.push({ transform: at(curve(start, bend, end, t), 1 - 0.4 * t), opacity, offset: t })
  }
  const flight = el.animate(frames, { duration: FLIGHT_MS, easing: EASE_OUT, id: 'download-flight' })
  flight.oncancel = () => el.remove()
  flight.onfinish = () => {
    el.remove()
    target.animate(
      [
        { transform: 'scale(1)' },
        { transform: 'scale(1.18)', offset: 0.35 },
        { transform: 'scale(0.95)', offset: 0.7 },
        { transform: 'scale(1)' },
      ],
      { duration: 380, easing: 'ease-out', id: 'download-landing' },
    )
  }
}
