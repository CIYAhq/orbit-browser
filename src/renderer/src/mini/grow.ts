/**
 * The open grow (MW-04): a Mini Window appears with a quick scale-and-fade rather than the OS's
 * own animation. Main asks the UI to take the grow's starting size before it shows the window
 * (`prepare`), then to grow (`run`), or to drop it (`cancel`). The UI grows in its own layer;
 * the OS window keeps its size, and the page's native view joins at full size when the grow ends.
 *
 * Heard from the moment this module loads, before React has drawn anything, so a window shown as
 * soon as it is ready still grows.
 */

/** How long the grow takes (the spec's "about 200 ms"). */
export const GROW_MS = 200
/** Dispatched on `window` when the grow ends or is dropped: what the UI measures is full size again. */
export const GROWN_EVENT = 'orbit-mini-grown'

interface GrowMessage {
  phase: 'prepare' | 'run' | 'cancel'
  /** The starting scale. */
  scale?: number
  /** The UI fades in too (where the OS window can't fade). */
  fade?: boolean
}

let from: Keyframe | null = null
let growing = false

/** Whether the UI is growing open: its boxes are scaled meanwhile. */
export function isGrowing(): boolean {
  return growing
}

const settle = () => {
  growing = false
  window.dispatchEvent(new Event(GROWN_EVENT))
}

window.orbit.on('mini:grow', (payload) => {
  const { phase, scale, fade } = payload as GrowMessage
  const root = document.querySelector<HTMLElement>('.mini')
  if (phase === 'prepare') {
    if (root) {
      for (const animation of root.getAnimations()) animation.cancel()
      from = { transform: `scale(${scale ?? 1})`, opacity: fade ? 0 : 1 }
      root.style.transform = `scale(${scale ?? 1})`
      root.style.opacity = fade ? '0' : ''
      // In place before the window shows.
      root.getBoundingClientRect()
      growing = true
    }
    window.orbit.send('mini.growReady', { ms: root ? GROW_MS : 0 })
    return
  }
  const start = from
  from = null
  if (root) {
    root.style.transform = ''
    root.style.opacity = ''
  }
  if (phase === 'cancel' || !root || !start) {
    settle()
    return
  }
  const easing = getComputedStyle(document.documentElement).getPropertyValue('--ease-out').trim() || 'ease-out'
  const animation = root.animate([start, { transform: 'none', opacity: 1 }], { duration: GROW_MS, easing })
  animation.finished.then(settle, settle)
})
