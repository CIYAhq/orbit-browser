import { getOrbitState } from '../../store'

/**
 * Type-ahead (CB-22, FL-16): keys typed right after ⌘T can reach the overlay
 * before the bar's input exists (the overlay view gets focus as soon as main
 * shows it). They are buffered here and handed to the bar when it mounts, so
 * no key, not even a fast Enter, is lost.
 */
const STALE_MS = 1500

let text = ''
let enter = false
let at = 0
/** Token of the mounted bar; 0 while none is mounted. */
let owner = 0
let nextToken = 1
/** When the last bar closed: keys right after a close belong to the page, not the next open. */
let closedAt = Number.NEGATIVE_INFINITY

function opening(): boolean {
  const kind = getOrbitState()?.windows[window.orbit.windowId]?.overlay.kind
  if (kind === 'commandbar') return true
  // Before the state patch arrives the mirror still says "none" (but not while a bar animates out).
  return (kind === undefined || kind === 'none') && performance.now() - closedAt > 400
}

export function installTypeahead(): void {
  window.addEventListener(
    'keydown',
    (e) => {
      if (owner || e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return
      if (!opening()) return
      const now = performance.now()
      if (now - at > STALE_MS) {
        text = ''
        enter = false
      }
      if (e.key.length === 1) text += e.key
      else if (e.key === 'Enter') enter = true
      else if (e.key === 'Backspace') text = text.slice(0, -1)
      else return
      at = now
      e.preventDefault()
    },
    { capture: true },
  )
}

/** Called by a bar when it mounts: returns buffered input and stops buffering. */
export function claimTypeahead(): { token: number; text: string; enter: boolean } {
  const fresh = performance.now() - at < STALE_MS
  const out = { token: nextToken++, text: fresh ? text : '', enter: fresh && enter }
  text = ''
  enter = false
  owner = out.token
  return out
}

/** Called when that bar closes: buffering resumes for the next open. */
export function releaseTypeahead(token: number): void {
  if (owner !== token) return
  owner = 0
  text = ''
  enter = false
  closedAt = performance.now()
}
