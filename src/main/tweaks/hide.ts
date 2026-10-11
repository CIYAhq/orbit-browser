import type { WebContents } from 'electron'
import { HIDE_OFF, type TweakHideChoice, type TweakHidePick, type TweakHideState } from '../../shared/commands/tweaks'
import type { TabId, WindowId } from '../../shared/state'
import { addHidden, isSafeSelector } from '../../shared/tweaks'
import type { MainContext } from '../context'
import type { TweakEditor } from './editor'
import { TWEAK_WORLD, type TweakPages } from './pages'

/**
 * The picker (BO-10). It runs in the page's isolated world TWEAK_WORLD, never the page's own world,
 * so the page can't call it or read its state. It covers the page with a layer of its own: an
 * element under the page's root, which the page sees as an empty `<div>`, whose closed shadow root
 * draws the outlines. While the mode is on, its listeners on the window, first in the capture phase
 * except the page's own listeners on its window, take every press and click (and the menu key's), so
 * the page's links and buttons don't act, even where the page covers or moves the layer. A capture
 * listener the page added on its window before the mode started still hears them first; even so,
 * their default actions are stopped, and nothing from the document inward hears them. If the page
 * takes the layer out, the picker puts it back; if the page keeps taking it out, the mode ends, and
 * main and the panel hear so.
 * It outlines what is under the pointer, and on a click describes that element: a selector for it
 * alone, and selectors for it and elements like it, narrow to broad, each with how many it matches
 * and how many of those have a box to outline. Main reads what happens with `__orbitHide.next()`; it
 * lives in one document, and goes with it.
 */
const PICKER = String.raw`(() => {
  if (window.__orbitHide) return true
  const doc = document
  const root = doc.documentElement
  const MAX = 300
  const all = (sel) => {
    try {
      return Array.from(doc.querySelectorAll(sel))
    } catch (e) {
      return []
    }
  }
  const esc = (s) => CSS.escape(s)
  const STATE = /^(is-|has-)|^(active|hover|focus|focused|selected|open|opened|visible|show|shown|hidden|current|disabled|expanded|collapsed)$/i
  // Classes a page keeps from one load to the next: not a state, not generated.
  const stable = (c) => c.length <= 40 && !/\d{3,}/.test(c) && !/^(css|sc|jsx|emotion|svelte)-/i.test(c) && !STATE.test(c)
  const classes = (el) => Array.from(el.classList).filter(stable).slice(0, 3)
  const tag = (el) => esc(el.localName)
  const idOf = (el) => {
    const id = el.id
    if (!id || id.length > 60 || /\d{3,}/.test(id)) return null
    const sel = '#' + esc(id)
    return all(sel).length === 1 ? sel : null
  }
  const nth = (el) => {
    let i = 1
    let twin = false
    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) {
      if (s.localName === el.localName) {
        i++
        twin = true
      }
    }
    for (let s = el.nextElementSibling; s && !twin; s = s.nextElementSibling) if (s.localName === el.localName) twin = true
    return twin ? ':nth-of-type(' + i + ')' : ''
  }
  // This element alone: its place under the nearest ancestor with an id of its own, or the body.
  const path = (el) => {
    const parts = []
    for (let n = el; n && n !== root; n = n.parentElement) {
      if (n === doc.body) {
        parts.unshift('body')
        break
      }
      const id = idOf(n)
      if (id) {
        parts.unshift(id)
        break
      }
      parts.unshift(tag(n) + nth(n))
    }
    return parts.join(' > ')
  }
  const kind = (el) => {
    const c = classes(el)[0]
    return el.localName + (c ? '.' + c : '')
  }
  // Whether an element has a box to outline: displayed, with a size.
  const boxed = (el) => {
    const r = el.getBoundingClientRect()
    return r.width !== 0 || r.height !== 0
  }
  const words = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const labelOf = (el) =>
    (words(el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title')) ||
      words(el.innerText).slice(0, 48) ||
      kind(el)).slice(0, 60)
  // This element and others like it, narrow to broad: never the page itself or an ancestor of it.
  const similar = (el) => {
    const t = tag(el)
    const cs = classes(el).map((c) => '.' + esc(c))
    const own = t + cs.join('')
    const parent = el.parentElement
    const under = parent && parent !== root ? path(parent) + ' > ' : ''
    const list = []
    if (cs.length) {
      if (under) list.push(under + own)
      if (parent && parent !== doc.body && parent !== root) {
        const pc = classes(parent).map((c) => '.' + esc(c)).join('')
        if (pc) list.push(tag(parent) + pc + ' > ' + own)
      }
      list.push(own)
      for (const c of cs) list.push(t + c)
      for (const c of cs) list.push(c)
    }
    if (under) list.push(under + t)
    const out = []
    for (const selector of new Set(list)) {
      const found = all(selector)
      if (found.length < 2 || found.length > MAX || !found.includes(el)) continue
      if (found.some((f) => f === doc.body || f === root || (f !== el && f.contains(el)))) continue
      out.push({ selector, count: found.length, shown: found.filter(boxed).length })
    }
    out.sort((a, b) => a.count - b.count)
    return out.filter((c, i) => i === 0 || c.count !== out[i - 1].count)
  }

  const host = doc.createElement('div')
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = doc.createElement('style')
  style.textContent =
    ':host{all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;display:block!important;cursor:crosshair!important;pointer-events:auto!important;visibility:visible!important;opacity:1!important;filter:none!important;transform:none!important}' +
    '.box{position:fixed;box-sizing:border-box;pointer-events:none;border:2px solid #4f6bed;border-radius:3px;background:rgba(79,107,237,.16)}' +
    '.box.pick,.box.many{border-color:#e5484d;background:rgba(229,72,77,.18)}.box.many{border-style:dashed}' +
    '.tag{position:fixed;pointer-events:none;max-width:60vw;overflow:hidden;padding:1px 6px;border-radius:4px;background:#4f6bed;color:#fff;font:600 11px/16px system-ui,sans-serif;white-space:nowrap;text-overflow:ellipsis}'
  const layer = doc.createElement('div')
  shadow.append(style, layer)

  let hovered = null
  let picked = null
  let many = null
  let x = -1
  let y = -1
  let frame = 0
  const waiting = []
  const queue = []
  const emit = (ev) => {
    const wake = waiting.shift()
    if (wake) wake(ev)
    else if (queue.push(ev) > 8) queue.shift()
  }
  const under = (px, py) => {
    for (const el of doc.elementsFromPoint(px, py)) if (el !== host && el !== root && el !== doc.body) return el
    return null
  }
  const box = (el, cls, text) => {
    const r = el.getBoundingClientRect()
    if (!boxed(el)) return
    // The page's size (BO-08) zooms this layer too: its own pixels are that much larger.
    const z = host.currentCSSZoom || 1
    const b = doc.createElement('div')
    b.className = 'box ' + cls
    b.style.cssText =
      'left:' + r.left / z + 'px;top:' + r.top / z + 'px;width:' + r.width / z + 'px;height:' + r.height / z + 'px'
    layer.append(b)
    if (!text) return
    const t = doc.createElement('div')
    t.className = 'tag'
    t.textContent = text
    const top = r.top / z >= 20 ? r.top / z - 20 : r.bottom / z + 2
    t.style.cssText = 'left:' + Math.max(0, r.left / z) + 'px;top:' + top + 'px'
    layer.append(t)
  }
  const draw = () => {
    frame = 0
    layer.replaceChildren()
    if (many) {
      for (const el of all(many).slice(0, MAX)) box(el, 'many')
      return
    }
    if (picked) {
      if (picked.isConnected) box(picked, 'pick')
      return
    }
    hovered = x < 0 ? null : under(x, y)
    if (!hovered) return
    const r = hovered.getBoundingClientRect()
    box(hovered, 'hover', kind(hovered) + '  ' + Math.round(r.width) + ' × ' + Math.round(r.height))
  }
  const redraw = () => {
    if (!frame) frame = requestAnimationFrame(draw)
  }
  // Neither the page nor its default actions get these while the mode is on.
  const block = (e) => {
    e.preventDefault()
    e.stopImmediatePropagation()
  }
  const onMove = (e) => {
    if (!e.isTrusted) return
    x = e.clientX
    y = e.clientY
    redraw()
  }
  const onClick = (e) => {
    block(e)
    // A pointer's click picks; one the keyboard makes (detail 0) only doesn't reach the page.
    if (!e.isTrusted || e.button !== 0 || e.detail === 0) return
    const el = under(e.clientX, e.clientY)
    if (!el) return
    picked = el
    many = null
    redraw()
    emit({ type: 'pick', label: labelOf(el), kind: kind(el), exact: path(el), similar: similar(el) })
  }
  const onKey = (e) => {
    if (!e.isTrusted || e.key !== 'Escape') return
    e.preventDefault()
    e.stopImmediatePropagation()
    emit({ type: 'escape' })
  }
  const BLOCKED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'auxclick', 'contextmenu']
  const listeners = [
    ['pointermove', onMove, true],
    ['click', onClick, true],
    ...BLOCKED.map((type) => [type, block, true]),
    ['keydown', onKey, true],
    ['scroll', redraw, true],
    ['resize', redraw, false],
  ]
  for (const [type, fn, capture] of listeners) addEventListener(type, fn, capture)

  // The page took the layer out, or moved it, or marked it: it goes back as it was. A page that
  // keeps taking it out (more than 20 times a second), or replaces its root, ends the mode: main
  // hears it from next().
  let restored = 0
  let since = 0
  const keep = () => {
    const now = performance.now()
    if (now - since > 1000) {
      since = now
      restored = 0
    }
    if (doc.documentElement !== root || ++restored > 20) {
      stop()
      return
    }
    for (const name of host.getAttributeNames()) host.removeAttribute(name)
    if (host.parentNode !== root) root.append(host)
  }
  const watcher = new MutationObserver(() => {
    if (doc.documentElement !== root || host.parentNode !== root || host.attributes.length > 0) keep()
  })
  watcher.observe(doc, { childList: true })
  watcher.observe(root, { childList: true })
  watcher.observe(host, { attributes: true })
  root.append(host)

  const stop = () => {
    watcher.disconnect()
    for (const [type, fn, capture] of listeners) removeEventListener(type, fn, capture)
    if (frame) cancelAnimationFrame(frame)
    host.remove()
    window.__orbitHide = undefined
    for (const wake of waiting.splice(0)) wake({ type: 'stopped' })
    return true
  }

  window.__orbitHide = {
    next: () =>
      new Promise((resolve) => {
        if (queue.length) resolve(queue.shift())
        else waiting.push(resolve)
      }),
    outline: (selector) => {
      many = selector || null
      redraw()
      return many ? all(many).slice(0, MAX).filter(boxed).length : picked ? 1 : 0
    },
    clear: () => {
      picked = null
      many = null
      redraw()
    },
    stop,
    info: () => ({
      hovered: hovered && !picked ? path(hovered) : null,
      picked: picked ? path(picked) : null,
      outlined: layer.querySelectorAll('.box').length,
    }),
  }
  return true
})()`

const NEXT = `window.__orbitHide ? window.__orbitHide.next() : { type: 'gone' }`

/** What the picker in a page says, for tests (BO-10). */
export interface PickerInfo {
  /** The element under the pointer (a selector for it), while nothing is picked. */
  hovered: string | null
  picked: string | null
  /** How many elements are outlined. */
  outlined: number
}

/** One window's Hide-element mode: over its editor's page, for its Tweak. */
interface Session {
  windowId: WindowId
  tabId: TabId
  tweakId: string
  contents: WebContents
  pick: TweakHidePick | null
  /** The picker was sent to the page (at once, or once its load ended: D89). */
  sent: boolean
  ended: boolean
  /** Ends the wait for the page's load or its next event, and stops watching the page. */
  release: () => void
}

export interface TweakHide {
  /** Starts or ends a window's Hide-element mode; false where it can't start. */
  setMode(windowId: WindowId, on: boolean): Promise<boolean>
  /** Outlines what a choice would hide; the number outlined. */
  preview(windowId: WindowId, choice: TweakHideChoice | null): Promise<number>
  /** Hides what a choice picks, in the edited Tweak. */
  hide(windowId: WindowId, choice: TweakHideChoice): boolean
  cancel(windowId: WindowId): void
  /** Test view: what the picker in a tab's page says. */
  info(tabId: TabId): Promise<PickerInfo | null>
}

const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** A pick as the page described it, checked: selectors that can't reach outside their own rule. */
function checkPick(ev: Record<string, unknown>): TweakHidePick | null {
  const exact = text(ev.exact, 2_000)
  if (!isSafeSelector(exact)) return null
  const similar = (Array.isArray(ev.similar) ? ev.similar : [])
    .filter(isRecord)
    .map((c) => ({ selector: text(c.selector, 2_000), count: Number(c.count), shown: Number(c.shown) }))
    .filter((c) => isSafeSelector(c.selector) && Number.isInteger(c.count) && c.count >= 2)
    .map((c) => ({ ...c, shown: Number.isInteger(c.shown) ? Math.min(Math.max(c.shown, 0), c.count) : c.count }))
    .slice(0, 12)
  return { label: text(ev.label, 60) || text(ev.kind, 60) || 'Element', exact, similar }
}

let hiddenCount = 0
const hiddenId = () => `h-${Date.now().toString(36)}${(++hiddenCount).toString(36)}`

/**
 * Hide-element mode (BO-10): main puts the picker in the editor's page, reads what the user picks
 * there, shows it in the panel, and saves what the user hides as plain CSS selectors in the Tweak
 * (its sheet hides them, before first paint on every later load). On a page still loading, the mode
 * starts when the load ends, and the panel says so at once (D89). The mode ends with Done or Esc,
 * when the panel leaves the page, and when the page loads another document.
 */
export function registerTweakHide(ctx: MainContext, editor: TweakEditor, pages: TweakPages): TweakHide {
  const { store, tabs } = ctx
  const sessions = new Map<WindowId, Session>()

  const run = (contents: WebContents, code: string): Promise<unknown> =>
    contents.executeJavaScriptInIsolatedWorld(TWEAK_WORLD, [{ code }])

  const show = (s: Session) => {
    const state: TweakHideState = { on: true, starting: false, pick: s.pick }
    editor.setHide(s.windowId, state)
  }

  const end = (windowId: WindowId) => {
    const s = sessions.get(windowId)
    if (!s) return
    sessions.delete(windowId)
    s.ended = true
    s.release()
    if (s.sent && !s.contents.isDestroyed()) {
      run(s.contents, 'window.__orbitHide && window.__orbitHide.stop()').catch(() => {})
    }
    pages.setShowHidden(s.tabId, undefined)
    editor.setHide(windowId, HIDE_OFF)
  }

  const handle = (s: Session, ev: unknown) => {
    if (!isRecord(ev) || ev.type === 'stopped' || ev.type === 'gone') {
      end(s.windowId)
      return
    }
    if (ev.type === 'escape') {
      // Esc in the page drops the pick first, then leaves the mode.
      if (s.pick) cancel(s.windowId)
      else end(s.windowId)
      return
    }
    if (ev.type !== 'pick') return
    const pick = checkPick(ev)
    if (!pick) return
    s.pick = pick
    show(s)
  }

  /** Reads the page's events until the mode ends. */
  const listen = async (s: Session, ended: Promise<null>) => {
    while (!s.ended) {
      let ev: unknown = null
      try {
        ev = await Promise.race([run(s.contents, NEXT), ended])
      } catch {
        ev = null
      }
      if (s.ended) return
      handle(s, ev)
    }
  }

  const start = async (windowId: WindowId): Promise<boolean> => {
    if (sessions.has(windowId)) return true
    const at = editor.editing(windowId)
    const contents = at ? tabs.contents(at.tabId) : undefined
    if (!at || !contents || contents.isDestroyed() || !pages.tweakable(at.tabId)) return false
    let wake = () => {}
    const ended = new Promise<null>((resolve) => {
      wake = () => resolve(null)
    })
    // Another document in the tab ends the mode: the picker went with the old one.
    const onNavigate = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (details.isMainFrame && !details.isSameDocument) end(windowId)
    }
    const onGone = () => end(windowId)
    let onLoaded = () => {}
    const loaded = new Promise<void>((resolve) => {
      onLoaded = resolve
    })
    contents.on('did-start-navigation', onNavigate)
    contents.on('render-process-gone', onGone)
    contents.once('destroyed', onGone)
    const s: Session = {
      windowId,
      tabId: at.tabId,
      tweakId: at.tweakId,
      contents,
      pick: null,
      sent: false,
      ended: false,
      release: () => {
        contents.off('did-start-navigation', onNavigate)
        contents.off('render-process-gone', onGone)
        contents.off('destroyed', onGone)
        contents.off('did-stop-loading', onLoaded)
        wake()
      },
    }
    sessions.set(windowId, s)
    // A page still loading takes the picker only once its load ends: Electron holds main's calls in
    // an isolated world until then (D89). The panel shows the mode starting meanwhile, the page acting
    // as usual; Done, Esc or another document cancels it, and the picker never goes in.
    if (contents.isLoadingMainFrame()) {
      contents.once('did-stop-loading', onLoaded)
      editor.setHide(windowId, { on: false, starting: true, pick: null })
      await Promise.race([loaded, ended])
      if (s.ended) return false
    }
    s.sent = true
    try {
      await run(contents, PICKER)
    } catch {
      end(windowId)
      return false
    }
    if (s.ended) return false
    // On once the picker is in the page: a click there picks from now on.
    show(s)
    void listen(s, ended)
    return true
  }

  const cancel = (windowId: WindowId) => {
    const s = sessions.get(windowId)
    if (!s?.pick) return
    s.pick = null
    show(s)
    run(s.contents, 'window.__orbitHide && window.__orbitHide.clear()').catch(() => {})
  }

  const selectorOf = (pick: TweakHidePick, choice: TweakHideChoice): string | undefined =>
    choice === 'this' ? pick.exact : typeof choice === 'number' ? pick.similar[choice]?.selector : undefined

  // The panel leaves its page, or closes: the mode ends with it.
  editor.onLeave((windowId) => end(windowId))

  return {
    setMode: async (windowId, on) => {
      if (on) return start(windowId)
      end(windowId)
      return true
    },
    preview: async (windowId, choice) => {
      const s = sessions.get(windowId)
      if (!s?.pick) return 0
      const selector = choice === null ? null : selectorOf(s.pick, choice)
      if (choice !== null && !selector) return 0
      const code = `window.__orbitHide ? window.__orbitHide.outline(${JSON.stringify(selector)}) : 0`
      const n = await run(s.contents, code).catch(() => 0)
      return typeof n === 'number' ? n : 0
    },
    hide: (windowId, choice) => {
      const s = sessions.get(windowId)
      const pick = s?.pick
      const selector = pick ? selectorOf(pick, choice) : undefined
      if (!s || !pick || !selector || !isSafeSelector(selector)) return false
      const count = choice === 'this' ? 1 : (pick.similar[choice as number]?.count ?? 0)
      const label = choice === 'this' ? pick.label : `${pick.label} and similar (${count})`
      let added = false
      store.update((draft) => {
        const tweak = draft.tweaks[s.tweakId]
        if (tweak) added = addHidden(tweak, { id: hiddenId(), selector, label }, Date.now())
      })
      s.pick = null
      show(s)
      run(s.contents, 'window.__orbitHide && window.__orbitHide.clear()').catch(() => {})
      return added
    },
    cancel,
    info: async (tabId) => {
      const contents = tabs.contents(tabId)
      if (!contents || contents.isDestroyed()) return null
      const info = await run(contents, 'window.__orbitHide ? window.__orbitHide.info() : null').catch(() => null)
      return (info as PickerInfo | null) ?? null
    },
  }
}
