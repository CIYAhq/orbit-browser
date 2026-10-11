import type { WebContents } from 'electron'

/** Isolated world for the keys lane's page script (KS-02, KS-16): the page can't see or change it. */
export const KEYS_WORLD = 1020

/**
 * Whether an element is a text field: one that types or edits text (page script source, shared by
 * the watcher here and the focus mirror in page-focus.ts). A web component's field counts: the
 * element focused inside open shadow roots, not their host (keys fix check K1).
 */
export const EDITABLE = `(el) => {
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement
  if (!el || el === document.body || el === document.documentElement) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag !== 'INPUT') return false
  const type = (el.getAttribute('type') || 'text').toLowerCase()
  return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type)
}`

/** A key press as the page scripts note it: its modifiers and physical key. */
export function signature(input: Pick<Electron.Input, 'meta' | 'control' | 'alt' | 'shift' | 'code'>): string {
  return [input.meta, input.control, input.alt, input.shift, input.code].join(',')
}

/**
 * Notes, for each trusted key press in the page's main frame, whether the page called
 * preventDefault on it once every one of its own handlers has run, and whether keyboard focus was
 * in a text field. `__orbitKeys.verdict` answers for one press. Lives in the page's document, so
 * it is installed again for each new document.
 */
const WATCH = `(() => {
  if (window.__orbitKeys) return true
  const seen = []
  let waiters = []
  const editable = ${EDITABLE}
  addEventListener('keydown', (e) => {
    if (!e.isTrusted) return
    const sig = [e.metaKey, e.ctrlKey, e.altKey, e.shiftKey, e.code].join(',')
    const at = Date.now()
    const inField = editable(document.activeElement)
    // After the whole dispatch: the page's handlers have all had the event.
    setTimeout(() => {
      seen.push({ sig, at, inField, prevented: e.defaultPrevented })
      if (seen.length > 16) seen.shift()
      const woken = waiters
      waiters = []
      for (const wake of woken) wake()
    }, 0)
  }, true)
  window.__orbitKeys = {
    verdict(sig, since, wait) {
      return new Promise((resolve) => {
        let done = false
        const answer = () => {
          const r = seen.find((x) => x.sig === sig && x.at >= since)
          if (!r) return false
          done = true
          resolve({ seen: true, prevented: r.prevented, inField: r.inField })
          return true
        }
        if (answer()) return
        const wake = () => {
          if (!done && !answer()) waiters.push(wake)
        }
        waiters.push(wake)
        setTimeout(() => {
          if (done) return
          done = true
          resolve({ seen: false })
        }, wait)
      })
    },
  }
  return true
})()`

/** Puts the watcher in a tab's page, now and in each document it loads (KS-02). */
export function watchPageKeys(contents: WebContents): void {
  const install = () => {
    if (contents.isDestroyed()) return
    contents.executeJavaScriptInIsolatedWorld(KEYS_WORLD, [{ code: WATCH }]).catch(() => {})
  }
  contents.on('dom-ready', install)
}

/** What the page did with a key press. */
export type PageVerdict =
  /** The press reached the frame with the keyboard: whether it called preventDefault, and whether focus was in a text field. */
  | { seen: true; prevented: boolean; inField: boolean }
  /** The main frame's watcher didn't see the press within the wait: a handler of the page that ran first stopped it. */
  | { seen: false }
  /** No answer: the page has no watcher (loading, or a page Orbit can't script), or answered too late. */
  | undefined

/** How long the page's watcher waits for the press to reach it (a little less than ANSWER_WAIT_MS). */
export const VERDICT_WAIT_MS = 200

/**
 * How long main waits for the page's answer at all; a page whose renderer is busy or hung answers
 * late, and no answer counts as the page leaving the key alone (D60).
 */
export const ANSWER_WAIT_MS = 250

/**
 * Whether the page can say at once what it did with a key press. Electron runs no isolated-world
 * script in a page while its main frame loads (the script waits until the load ends), so a page
 * on its way, or one still loading the first document's resources, can't answer in time.
 */
export function pageCanAnswer(contents: WebContents): boolean {
  return !contents.isDestroyed() && !contents.isCrashed() && !contents.isLoadingMainFrame()
}

/**
 * What the page did with the key press `input`, pressed at `pressedAt` (main's clock, which the
 * page shares). Asked as the press is let through to the page.
 */
export async function pageVerdict(
  contents: WebContents,
  input: Electron.Input,
  pressedAt: number,
): Promise<PageVerdict> {
  if (!pageCanAnswer(contents)) return undefined
  const sig = signature(input)
  const code = `window.__orbitKeys ? window.__orbitKeys.verdict(${JSON.stringify(sig)}, ${pressedAt - 10}, ${VERDICT_WAIT_MS}) : null`
  let timer: NodeJS.Timeout | undefined
  try {
    const verdict = (await Promise.race([
      contents.executeJavaScriptInIsolatedWorld(KEYS_WORLD, [{ code }]),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), ANSWER_WAIT_MS)
      }),
    ])) as PageVerdict | null
    return verdict ?? undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
