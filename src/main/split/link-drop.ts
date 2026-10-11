import type { WebContents } from 'electron'
import { droppedLink, type LinkDragMessage } from '../../shared/link-drop'
import { MAX_PANES } from '../../shared/split'
import type { OrbitState, TabId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import { EDITABLE } from '../keys/page-keys'
import { shownTabs } from '../windows'

/** Isolated world of the link-drop watcher (SV-08): the page can't see or change it. */
const LINK_DROP_WORLD = 1030

/** How far (CSS px) a link must leave the spot it was picked up at before its page offers a pane. */
const PICKUP_SLOP = 24

/** How long the page waits for a drag before answering main's question with nothing. */
const ASK_WAIT_MS = 20_000

/** What the page's watcher says about a link dragged over it (page CSS pixels). */
interface Report {
  seq: number
  kind: 'over' | 'leave' | 'drop'
  x: number
  y: number
  url?: string
}

/**
 * Lives in the page's document (its main frame), installed again for each new document. While
 * main is listening, a link dragged over the page that the page doesn't take itself (its own drop
 * target, a text field) is Orbit's: the page shows it can be dropped, and main hears where it is
 * and what was dropped. Main asks with `next`, which answers at the next report; the page never
 * calls out. The page's own handlers all run first (these listen at the window, after bubbling).
 */
const WATCH = `(() => {
  if (window.__orbitLinkDrop) return true
  const editable = ${EDITABLE}
  let seq = 0
  let last = null
  let waiters = []
  let armedUntil = 0
  let pickedUp = null
  let leaving = 0
  const armed = () => waiters.length > 0 || Date.now() < armedUntil
  const post = (kind, e, url) => {
    last = { seq: ++seq, kind, x: e.clientX, y: e.clientY, url }
    armedUntil = Date.now() + 1000
    const woken = waiters
    waiters = []
    for (const wake of woken) wake(last)
  }
  const element = (e) => (e.target instanceof Element ? e.target : e.target && e.target.parentElement) || null
  const link = (e) => {
    const types = e.dataTransfer ? Array.from(e.dataTransfer.types) : []
    return types.includes('text/uri-list') && !types.includes('Files')
  }
  const ours = (e) =>
    e.isTrusted && armed() && link(e) && !e.defaultPrevented && !editable(element(e)) &&
    !(pickedUp && Math.hypot(e.clientX - pickedUp.x, e.clientY - pickedUp.y) < ${PICKUP_SLOP})
  const away = (e) => {
    if (last && last.kind === 'over') post('leave', e)
  }
  addEventListener('dragstart', (e) => {
    const el = element(e)
    pickedUp = e.isTrusted && el && el.closest('a[href], area[href]') ? { x: e.clientX, y: e.clientY } : null
  }, true)
  addEventListener('dragend', () => { pickedUp = null }, true)
  // Entering another element must accept the link too, or a drop before the next dragover is refused.
  addEventListener('dragenter', (e) => {
    if (!ours(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  })
  addEventListener('dragover', (e) => {
    clearTimeout(leaving)
    if (!ours(e)) return away(e)
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    post('over', e)
  })
  addEventListener('dragleave', (e) => {
    if (!e.isTrusted || !last || last.kind !== 'over') return
    clearTimeout(leaving)
    // Moving onto another element of the page comes with a dragover at once; leaving it doesn't.
    leaving = setTimeout(() => away(e), 80)
  })
  addEventListener('drop', (e) => {
    clearTimeout(leaving)
    if (!ours(e)) return away(e)
    e.preventDefault()
    post('drop', e, e.dataTransfer.getData('text/uri-list'))
  })
  window.__orbitLinkDrop = {
    next(after, wait) {
      armedUntil = Date.now() + 1000
      if (last && last.seq > after) return last
      return new Promise((resolve) => {
        const wake = (r) => {
          clearTimeout(timer)
          resolve(r)
        }
        const timer = setTimeout(() => {
          waiters = waiters.filter((w) => w !== wake)
          resolve(null)
        }, wait)
        waiters.push(wake)
      })
    },
    stop() {
      armedUntil = 0
      const woken = waiters
      waiters = []
      for (const wake of woken) wake(null)
    },
  }
  return true
})()`

const isReport = (r: unknown): r is Report => {
  const v = r as Report | null
  return (
    !!v &&
    typeof v === 'object' &&
    typeof v.seq === 'number' &&
    (v.kind === 'over' || v.kind === 'leave' || v.kind === 'drop') &&
    Number.isFinite(v.x) &&
    Number.isFinite(v.y)
  )
}

/**
 * The panes shown in main windows with room for another: the pages a link can be dragged onto to
 * make a split. A full split takes no link, so its pages keep the drag to themselves.
 */
function panesShown(state: OrbitState): Map<TabId, WindowId> {
  const out = new Map<TabId, WindowId>()
  for (const win of Object.values(state.windows)) {
    if (win.kind !== 'main') continue
    const shown = shownTabs(state, win.id)
    if (shown.size >= MAX_PANES) continue
    for (const tabId of shown) out.set(tabId, win.id)
  }
  return out
}

/**
 * Dragging a link out of a page onto a pane's page shows the split drop indicator and opens the
 * link in a new pane there (SV-08). Main listens to the page of each pane shown in a main window
 * and tells that window's shell where the link is and what was dropped; the shell draws the
 * indicator and makes the split, as it does for a dragged tab (SV-04). Over Orbit's own surface
 * (the indicator, the gaps) the shell hears the drag itself.
 */
export function installLinkDrop(ctx: MainContext): void {
  const { store, tabs, windows } = ctx
  /** Pages whose current document has the watcher. */
  const watched = new Set<TabId>()
  /** The pages main listens to, each with the turn of its loop. */
  const listening = new Map<TabId, number>()
  let turn = 0

  const relay = (tabId: TabId, contents: WebContents, r: Report) => {
    const windowId = panesShown(store.state).get(tabId)
    const view = tabs.get(tabId)
    if (!windowId || !view) return
    const b = view.getBounds()
    const zoom = contents.getZoomFactor() || 1
    const at = { x: b.x + r.x * zoom, y: b.y + r.y * zoom }
    let message: LinkDragMessage = { phase: r.kind, ...at }
    if (r.kind === 'drop') {
      const url = typeof r.url === 'string' ? droppedLink(r.url) : null
      message = url ? { ...message, url } : { phase: 'leave', ...at }
    }
    windows.sendToWindow(windowId, 'split:linkDrag', message)
  }

  const listen = async (tabId: TabId, contents: WebContents, mine: number) => {
    let after = 0
    while (listening.get(tabId) === mine && !contents.isDestroyed()) {
      let r: unknown
      try {
        r = await contents.executeJavaScriptInIsolatedWorld(LINK_DROP_WORLD, [
          {
            code: `window.__orbitLinkDrop ? window.__orbitLinkDrop.next(${after}, ${ASK_WAIT_MS}) : 'gone'`,
          },
        ])
      } catch {
        r = 'gone'
      }
      if (listening.get(tabId) !== mine || contents.isDestroyed()) return
      if (r === 'gone') {
        // The document went away; the next one's dom-ready starts again.
        listening.delete(tabId)
        return
      }
      if (!isReport(r) || r.seq <= after) continue
      after = r.seq
      relay(tabId, contents, r)
    }
  }

  const stop = (tabId: TabId) => {
    listening.delete(tabId)
    const contents = tabs.contents(tabId)
    if (!contents || contents.isDestroyed()) return
    contents
      .executeJavaScriptInIsolatedWorld(LINK_DROP_WORLD, [
        { code: 'window.__orbitLinkDrop && window.__orbitLinkDrop.stop()' },
      ])
      .catch(() => {})
  }

  const sync = () => {
    const shown = panesShown(store.state)
    for (const tabId of [...listening.keys()]) if (!shown.has(tabId)) stop(tabId)
    for (const tabId of shown.keys()) {
      if (listening.has(tabId) || !watched.has(tabId)) continue
      const contents = tabs.contents(tabId)
      if (!contents || contents.isDestroyed()) continue
      const mine = ++turn
      listening.set(tabId, mine)
      void listen(tabId, contents, mine)
    }
  }

  ctx.hooks.tabCreated.push((tabId, contents) => {
    // A new document in the main frame has no watcher until its dom-ready.
    contents.on('did-navigate', () => watched.delete(tabId))
    contents.on('dom-ready', () => {
      if (contents.isDestroyed()) return
      contents
        .executeJavaScriptInIsolatedWorld(LINK_DROP_WORLD, [{ code: WATCH }])
        .then(() => {
          if (contents.isDestroyed()) return
          watched.add(tabId)
          // A new document: listen to it from the start.
          listening.delete(tabId)
          sync()
        })
        .catch(() => {})
    })
    contents.once('destroyed', () => {
      watched.delete(tabId)
      listening.delete(tabId)
    })
  })

  store.subscribe((next, prev) => {
    if (next.windows !== prev.windows || next.splits !== prev.splits) sync()
  })
}
