import type { WebContentsView } from 'electron'
import { HIDE_OFF, TWEAK_EDITOR, type TweakEditorState, type TweakHideState } from '../../shared/commands/tweaks'
import { peekShown } from '../../shared/nav'
import { isPrivateTab } from '../../shared/private'
import type { Rect } from '../../shared/rpc'
import type { OrbitState, TabId, WindowId } from '../../shared/state'
import { isEmptyTweak, tweakAppliesTo, tweakHostOf } from '../../shared/tweaks'
import type { MainContext } from '../context'
import { shownTabs, viewContents } from '../windows'

/** One window's editor panel (BO-02). */
interface Editor {
  view?: WebContentsView
  /** The view's page has loaded: only then does it go into the window (a loading view takes the keyboard). */
  ready: boolean
  state: TweakEditorState
  /** The panel's size as its page lays it out, without the shadow's margin; null until it has. */
  size: { width: number; height: number } | null
  /** Where the user dragged the panel, from its place at the page's top-right corner. */
  offset: { x: number; y: number }
  /** A drag by the panel's title: where it started (screen) and the offset then. */
  drag?: { x: number; y: number; ox: number; oy: number }
  /** Tweaks this panel made (BO-01): one still empty and unnamed when the panel leaves it is removed. */
  created: Set<string>
  /** The panel takes the keyboard once it is in the window (an opening, not a move). */
  focusPending: boolean
  /** What the panel's page was told last. */
  sent?: string
}

export interface TweakEditorInfo {
  open: boolean
  tabId: TabId | null
  tweakId: string | null
  ready: boolean
  /** The view is in the window. */
  placed: boolean
  bounds?: Rect
  /** The view's page has the keyboard. */
  focused: boolean
  /** The view's web contents id, for tests that look at it. */
  contentsId?: number
}

export interface TweakEditor {
  /** Opens the panel in a window for a Tweak over a tab's page; `created`: the Tweak was just made for it. */
  open(windowId: WindowId, tabId: TabId, tweakId: string, created?: boolean): void
  /** Closes a window's panel; every edit is already saved (BO-02). */
  close(windowId: WindowId): void
  state(windowId: WindowId | undefined): TweakEditorState
  /** The window whose panel is open on a Tweak, if any. */
  windowEditing(tweakId: string): WindowId | undefined
  /** The Tweak a window's panel shows, and the tab, while it is open. */
  editing(windowId: WindowId): { tabId: TabId; tweakId: string } | null
  /** What the panel shows of Hide-element mode (BO-10). */
  setHide(windowId: WindowId, hide: TweakHideState): void
  /** Called as a window's panel leaves its Tweak and page: it closes, or opens on another. */
  onLeave(listener: (windowId: WindowId) => void): void
  layout(windowId: WindowId, size: { width: number; height: number }): void
  drag(windowId: WindowId, phase: 'start' | 'move' | 'end', x: number, y: number): void
  info(windowId: WindowId): TweakEditorInfo
}

const CLOSED: Omit<TweakEditorState, 'nonce'> = {
  open: false,
  tabId: null,
  tweakId: null,
  host: null,
  private: false,
  hide: HIDE_OFF,
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max))

/**
 * The Tweak editor panel (BO-02): a small view of its own over the top-right corner of the page it
 * edits, sized to the panel, so the rest of the page stays live and takes clicks and keys as ever.
 * One per window, made the first time it opens there. It closes when its tab is no longer shown
 * (another tab, Space or window), when the tab leaves the Tweak's site, when the Tweak is deleted
 * and when Tweaks are turned off; it steps aside while a Peek or a video in full screen covers the
 * page, and comes back after.
 */
export function registerTweakEditor(ctx: MainContext): TweakEditor {
  const { store, windows } = ctx
  const editors = new Map<WindowId, Editor>()
  const leaving: ((windowId: WindowId) => void)[] = []
  let nonce = 0

  const leave = (windowId: WindowId) => {
    for (const listener of leaving) listener(windowId)
  }

  const live = (view: WebContentsView | undefined): view is WebContentsView => !!viewContents(view)

  const editorOf = (windowId: WindowId): Editor | undefined => {
    let e = editors.get(windowId)
    if (e) return e
    const win = windows.get(windowId)
    if (!win || win.isDestroyed()) return undefined
    e = {
      ready: false,
      state: { ...CLOSED, nonce },
      size: null,
      offset: { x: 0, y: 0 },
      created: new Set(),
      focusPending: false,
    }
    editors.set(windowId, e)
    const record = e
    win.once('closed', () => {
      // The window's panel goes with it: a Tweak it made and left empty goes too.
      if (record.state.open) leave(windowId)
      editors.delete(windowId)
      if (record.state.open) dropIfEmpty(record, record.state.tweakId)
    })
    return e
  }

  /** Tells the panel's page what to show, once per change. */
  const push = (e: Editor) => {
    const json = JSON.stringify(e.state)
    if (e.sent === json) return
    const contents = viewContents(e.view)
    if (!contents || !e.ready) return
    e.sent = json
    contents.send('orbit:tweakEditor', e.state)
  }

  /** The window's panel view, made out of the window if it has none yet. */
  const viewFor = (windowId: WindowId, e: Editor): WebContentsView | undefined => {
    if (live(e.view)) return e.view
    e.ready = false
    e.sent = undefined
    e.size = null
    const view = windows.createUiView(windowId, 'tweak')
    e.view = view
    viewContents(view)?.once('did-finish-load', () => {
      if (e.view !== view) return
      e.ready = true
      push(e)
      place(windowId)
    })
    return view
  }

  /** The page the panel goes over now, or undefined while it can't show (the state still says open). */
  const pageOf = (state: OrbitState, windowId: WindowId, e: Editor): Rect | undefined => {
    const tabId = e.state.tabId
    if (!e.state.open || !tabId) return undefined
    if (windows.inHtmlFullscreen(windowId) || peekShown(state, windowId)) return undefined
    if (!shownTabs(state, windowId).has(tabId)) return undefined
    const page = windows.tabViewBounds(tabId)
    if (!page || page.width < TWEAK_EDITOR.minPage || page.height < TWEAK_EDITOR.minPage) return undefined
    return page
  }

  /** The panel's view at its place over the page, kept inside the page; the drag offset kept with it. */
  const boundsFor = (e: Editor, page: Rect, size: { width: number; height: number }): Rect => {
    const { margin, inset } = TWEAK_EDITOR
    const width = Math.min(size.width, page.width)
    const height = Math.min(size.height, page.height - inset)
    const homeX = page.x + page.width - inset - width
    const homeY = page.y + inset
    const x = clamp(homeX + e.offset.x, page.x, page.x + page.width - width)
    const y = clamp(homeY + e.offset.y, page.y, page.y + page.height - height)
    e.offset = { x: x - homeX, y: y - homeY }
    return { x: x - margin, y: y - margin, width: width + 2 * margin, height: height + 2 * margin }
  }

  /** Shows, moves or hides a window's panel to match its state. */
  const place = (windowId: WindowId) => {
    const e = editors.get(windowId)
    if (!e) return
    const page = pageOf(store.state, windowId, e)
    if (!page) {
      if (live(e.view)) windows.hideUiView(windowId, e.view)
      return
    }
    const view = viewFor(windowId, e)
    // Not before its page has loaded and laid the panel out: place() comes back here then.
    if (!view || !e.ready || !e.size) return
    windows.showUiView(windowId, view, boundsFor(e, page, e.size), e.focusPending)
    e.focusPending = false
  }

  /**
   * A Tweak the panel made is removed as the panel leaves it if it is still as it was made: empty
   * and named after its site (BO-01). The panel has left it already, so its removal closes nothing.
   */
  const dropIfEmpty = (e: Editor, id: string | null) => {
    if (!id || !e.created.has(id)) return
    e.created.delete(id)
    const tweak = store.state.tweaks[id]
    if (!tweak || !isEmptyTweak(tweak) || tweak.name !== tweak.host) return
    store.update((draft) => {
      delete draft.tweaks[id]
    })
  }

  const close = (windowId: WindowId) => {
    const e = editors.get(windowId)
    if (!e?.state.open) return
    const left = e.state.tweakId
    leave(windowId)
    e.drag = undefined
    e.focusPending = false
    e.state = { ...CLOSED, nonce: e.state.nonce }
    // The keyboard goes back to the page if the panel had it (KS-19).
    if (live(e.view)) windows.hideUiView(windowId, e.view)
    push(e)
    dropIfEmpty(e, left)
  }

  const open = (windowId: WindowId, tabId: TabId, tweakId: string, created = false) => {
    const e = editorOf(windowId)
    const tweak = store.state.tweaks[tweakId]
    if (!e || !tweak) return
    const left = e.state.open ? e.state.tweakId : null
    if (e.state.open) leave(windowId)
    if (created) e.created.add(tweakId)
    nonce++
    // Reopened over the same page, it stays where the user dragged it.
    if (!(e.state.open && e.state.tabId === tabId)) e.offset = { x: 0, y: 0 }
    e.state = {
      open: true,
      tabId,
      tweakId,
      host: tweakHostOf(store.state.tabs[tabId]?.url) ?? tweak.host,
      nonce,
      private: isPrivateTab(store.state, tabId),
      hide: HIDE_OFF,
    }
    e.focusPending = true
    viewFor(windowId, e)
    push(e)
    place(windowId)
    // Another Tweak in the same panel: the one it left goes if it was made here and left empty.
    if (left !== tweakId) dropIfEmpty(e, left)
  }

  // Close or step aside as the window's state changes.
  store.subscribe((next, prev) => {
    for (const [windowId, e] of editors) {
      if (!e.state.open) continue
      const { tabId, tweakId } = e.state
      const tweak = tweakId ? next.tweaks[tweakId] : undefined
      const tab = tabId ? next.tabs[tabId] : undefined
      if (
        !tweak ||
        !tab ||
        tab.error ||
        !next.settings.tweaksEnabled ||
        !shownTabs(next, windowId).has(tab.id) ||
        !tweakAppliesTo(tweak, tweakHostOf(tab.url))
      ) {
        close(windowId)
        continue
      }
      if (
        peekShown(next, windowId) !== peekShown(prev, windowId) ||
        next.windows[windowId] !== prev.windows[windowId]
      ) {
        place(windowId)
      }
    }
  })
  // The page moved or was resized, or a video went full screen: the panel follows.
  windows.onLayout((windowId) => {
    if (editors.get(windowId)?.state.open) place(windowId)
  })

  return {
    open,
    close,
    state: (windowId) => (windowId ? editors.get(windowId)?.state : undefined) ?? { ...CLOSED, nonce },
    windowEditing: (tweakId) => {
      for (const [windowId, e] of editors) if (e.state.open && e.state.tweakId === tweakId) return windowId
      return undefined
    },
    editing: (windowId) => {
      const s = editors.get(windowId)?.state
      return s?.open && s.tabId && s.tweakId ? { tabId: s.tabId, tweakId: s.tweakId } : null
    },
    setHide: (windowId, hide) => {
      const e = editors.get(windowId)
      if (!e?.state.open || e.state.hide === hide) return
      e.state = { ...e.state, hide }
      push(e)
    },
    onLeave: (listener) => {
      leaving.push(listener)
    },
    layout: (windowId, size) => {
      const e = editors.get(windowId)
      if (!e) return
      const width = clamp(Math.round(size.width), 120, TWEAK_EDITOR.wideWidth)
      const height = clamp(Math.round(size.height), 40, 2000)
      if (e.size?.width === width && e.size.height === height) return
      e.size = { width, height }
      place(windowId)
    },
    drag: (windowId, phase, x, y) => {
      const e = editors.get(windowId)
      if (!e?.state.open || !Number.isFinite(x) || !Number.isFinite(y)) return
      if (phase === 'start') {
        e.drag = { x, y, ox: e.offset.x, oy: e.offset.y }
        return
      }
      const d = e.drag
      if (!d) return
      // The panel stays where the last move put it: a release where the pointer was then may be
      // reported after the view moved, at a point that never was (synthetic input).
      if (phase === 'end') {
        e.drag = undefined
        return
      }
      e.offset = { x: d.ox + x - d.x, y: d.oy + y - d.y }
      place(windowId)
    },
    info: (windowId) => {
      const e = editors.get(windowId)
      const view = live(e?.view) ? e?.view : undefined
      const contents = viewContents(view)
      const win = windows.get(windowId)
      return {
        open: !!e?.state.open,
        tabId: e?.state.tabId ?? null,
        tweakId: e?.state.tweakId ?? null,
        ready: !!e?.ready,
        placed: !!view && !!win && !win.isDestroyed() && win.contentView.children.includes(view),
        bounds: view?.getBounds(),
        focused: !!contents && contents.isFocused(),
        contentsId: contents?.id,
      }
    },
  }
}
