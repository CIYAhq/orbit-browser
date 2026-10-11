import {
  webContents as allContents,
  BrowserWindow,
  type IpcMainEvent,
  ipcMain,
  type WebContents,
  WebContentsView,
} from 'electron'
import { type PageDialogAnswer, type PageDialogContent, scriptAnswer, scriptDialog } from '../../shared/pages'
import type { Rect } from '../../shared/rpc'
import { PAGE_CHANNEL } from '../../shared/site'
import type { TabId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import { activeTabOf, loadRenderer, rendererEntry, uiWebPreferences, viewContents } from '../windows'

/**
 * Where a page's dialogs show: over a tab's page in a main window (a split pane included), over a
 * Peek's or a Mini Window's page, or over a pop-up window's page.
 */
type HostKind = 'tab' | 'floating' | 'popup'

interface Host {
  kind: HostKind
  win: BrowserWindow
  /** The Orbit window: the main window (a tab, a Peek) or the Mini Window. None for a pop-up. */
  windowId?: WindowId
}

interface Dialog {
  content: PageDialogContent
  resolve: (answer: PageDialogAnswer | null) => void
  /** The page's own alert, confirm or prompt: it goes when the page navigates. */
  script: boolean
}

/** One page's dialogs: the first shows, the rest wait their turn. */
interface PageDialogs {
  page: WebContents
  queue: Dialog[]
  view?: WebContentsView
  host?: Host
  /** The view's page has loaded: only then does the view go into its window (fix check A, F1). */
  ready: boolean
  /** The dialog the view's page was last sent. */
  sent?: number
  /** The view is in its window, over the page. */
  onScreen: boolean
  off: () => void
}

export interface PageDialogInfo {
  id: number
  kind: PageDialogContent['kind']
  title: string
  message: string
  tabId: TabId | null
  /** Where it shows; null while the page has no window. */
  host: HostKind | null
  /** Its view is on screen over the page. */
  onScreen: boolean
  /** Its view has the keyboard. */
  focused: boolean
  bounds?: Rect
  /** Later dialogs of the same page, waiting their turn. */
  waiting: number
}

export interface PageDialogs$ {
  /** Shows a dialog over a page (once the page is on screen); resolves with the answer, or null if it went away. */
  open(page: WebContents, content: Omit<PageDialogContent, 'id'>, script?: boolean): Promise<PageDialogAnswer | null>
  /** Closes a page's dialogs (its own alert, confirm and prompt, or all), each as Cancel. */
  dismiss(page: WebContents, which: 'script' | 'all'): void
  /** Whether a page has a dialog open or waiting: its own alert, confirm or prompt (the page waits), or any. */
  pending(page: WebContents, which?: 'script' | 'all'): boolean
  /** Whether Orbit can show a dialog over a page: a tab's (a Peek's and a Mini Window's too) or a pop-up's. */
  hostable(page: WebContents): boolean
  /** Tests: every page's first dialog. */
  info(): PageDialogInfo[]
}

/**
 * Page dialogs (NV-24): a page's alert, confirm and prompt, the leave-page warning and HTTP sign-in,
 * in Orbit's own small dialog over that page's area only. The rest of the window stays usable:
 * other tabs, the sidebar, the command bar. A dialog waits while its page is off screen (another
 * tab is selected, the window is closed to the Library) and shows again when the page does. Each
 * shows in a transparent view of its own over the page, which takes the keyboard (Enter, Esc and
 * Tab go to the dialog first, KS-19) and gives it back to the page when it closes (KS-16).
 */
export function registerDialogs(ctx: MainContext): PageDialogs$ {
  const { store, tabs, windows, commands } = ctx
  const pages = new Map<number, PageDialogs>()
  /** Each main window's dialog views, made when first needed and kept for the next dialog. */
  const pools = new Map<WindowId, Set<WebContentsView>>()
  const inUse = new Set<WebContentsView>()
  let nextId = 1

  const hostOf = (page: WebContents): Host | undefined => {
    const tabId = tabs.tabIdFor(page)
    if (tabId) {
      const windowId = windows.windowOfTab(tabId)
      if (!windowId) return undefined
      if (store.state.tabs[tabId]?.floating) {
        const win = BrowserWindow.fromWebContents(page)
        return win && !win.isDestroyed() ? { kind: 'floating', win, windowId } : undefined
      }
      const win = windows.get(windowId)
      return win && !win.isDestroyed() ? { kind: 'tab', win, windowId } : undefined
    }
    // A pop-up window's page: the window's own contents.
    if (windows.isUi(page)) return undefined
    const win = BrowserWindow.fromWebContents(page)
    return win && !win.isDestroyed() && win.webContents === page ? { kind: 'popup', win } : undefined
  }

  const sameHost = (a: Host, b: Host) => a.kind === b.kind && a.win === b.win

  /** Where the dialog's view goes (window coordinates): over the page, while the page is on screen. */
  const placeOf = (p: PageDialogs, host: Host): Rect | undefined => {
    if (host.kind === 'popup') {
      if (!host.win.isVisible()) return undefined
      const [width = 0, height = 0] = host.win.getContentSize()
      return { x: 0, y: 0, width, height }
    }
    const tabId = tabs.tabIdFor(p.page)
    if (!tabId) return undefined
    if (host.kind === 'tab') return windows.tabViewBounds(tabId)
    const view = tabs.get(tabId)
    if (!view?.getVisible() || !host.win.contentView.children.includes(view)) return undefined
    return view.getBounds()
  }

  /** The page is the one the user is on: its window has focus, and nothing covers the page. */
  const pageIsCurrent = (p: PageDialogs, host: Host): boolean => {
    if (!host.win.isFocused()) return false
    if (host.kind !== 'tab' || !host.windowId) return true
    const tabId = tabs.tabIdFor(p.page)
    const win = store.state.windows[host.windowId]
    return (
      !!tabId &&
      activeTabOf(store.state, host.windowId) === tabId &&
      win?.overlay.kind === 'none' &&
      !windows.hasPageCover(host.windowId)
    )
  }

  const hasKeyboard = (view: WebContentsView | undefined) => {
    const contents = viewContents(view)
    return !!contents && allContents.getFocusedWebContents() === contents
  }

  /** Orbit's UI never navigates away or opens windows (as WindowManager's own views). */
  const harden = (contents: WebContents) => {
    contents.on('will-navigate', (event, url) => {
      const entry = rendererEntry()
      if (!(entry.url && url.startsWith(entry.url))) event.preventDefault()
    })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  }

  const watchLoads = (view: WebContentsView) => {
    const contents = viewContents(view)
    contents?.on('did-finish-load', () => {
      for (const p of pages.values()) {
        if (p.view !== view) continue
        p.ready = true
        p.sent = undefined
        sync(p)
      }
    })
    contents?.on('render-process-gone', () => {
      for (const p of pages.values()) {
        if (p.view !== view) continue
        p.ready = false
        p.onScreen = false
      }
    })
  }

  /** A main window's free dialog view, made if none is free. */
  const pooledView = (windowId: WindowId): WebContentsView | undefined => {
    const pool = pools.get(windowId) ?? new Set<WebContentsView>()
    pools.set(windowId, pool)
    for (const view of pool) {
      if (!viewContents(view)) pool.delete(view)
      else if (!inUse.has(view)) return view
    }
    const view = windows.createUiView(windowId, 'dialog')
    if (!view) return undefined
    pool.add(view)
    watchLoads(view)
    windows.get(windowId)?.once('closed', () => {
      for (const v of pool) inUse.delete(v)
      pools.delete(windowId)
    })
    return view
  }

  /** A view over a Peek's, a Mini Window's or a pop-up's page: its own, closed after its dialogs. */
  const looseView = (host: Host): WebContentsView => {
    const windowId = host.windowId ?? windows.focusedWindowId() ?? windows.ids()[0] ?? ''
    const view = new WebContentsView({ webPreferences: uiWebPreferences(windowId, 'dialog') })
    view.setBackgroundColor('#00000000')
    view.setVisible(false)
    const contents = view.webContents
    windows.registerUi(contents, windowId)
    windows.attachShortcuts(contents)
    harden(contents)
    // A view that crashed loads again, once: its dialog shows again.
    contents.once('render-process-gone', (_event, details) => {
      if (details.reason !== 'clean-exit' && !contents.isDestroyed()) loadRenderer(contents, 'dialog')
    })
    watchLoads(view)
    loadRenderer(contents, 'dialog')
    host.win.once('closed', () => viewContents(view)?.close())
    return view
  }

  const ensureView = (p: PageDialogs, host: Host): WebContentsView | undefined => {
    if (p.view && viewContents(p.view) && p.host && sameHost(p.host, host)) return p.view
    release(p)
    p.host = host
    p.ready = false
    p.sent = undefined
    const view = host.kind === 'tab' && host.windowId ? pooledView(host.windowId) : looseView(host)
    if (!view) return undefined
    p.view = view
    inUse.add(view)
    // A pooled view that has loaded already is ready now.
    const contents = viewContents(view)
    if (contents && !contents.isLoading() && contents.getURL() !== '') p.ready = true
    return view
  }

  /** Takes a page's view off screen; `focusPage` gives the page the keyboard if the view had it. */
  const hide = (p: PageDialogs, focusPage: boolean) => {
    const view = p.view
    const host = p.host
    p.onScreen = false
    if (!view || !host || !viewContents(view)) return
    const had = hasKeyboard(view)
    if (host.kind === 'tab' && host.windowId) windows.hideUiView(host.windowId, view)
    else {
      if (!host.win.isDestroyed() && host.win.contentView.children.includes(view))
        host.win.contentView.removeChildView(view)
      view.setVisible(false)
    }
    if (had && focusPage && !p.page.isDestroyed()) p.page.focus()
  }

  /** Gives a page's view back: a pooled one to its window's pool, a loose one is closed. */
  const release = (p: PageDialogs) => {
    const view = p.view
    if (!view) return
    hide(p, false)
    inUse.delete(view)
    p.view = undefined
    p.host = undefined
    p.ready = false
    p.sent = undefined
    const pooled = [...pools.values()].some((pool) => pool.has(view))
    if (!pooled) viewContents(view)?.close()
  }

  const send = (p: PageDialogs, content: PageDialogContent) => {
    if (p.sent === content.id) return
    p.sent = content.id
    viewContents(p.view)?.send('orbit:dialog:content', content)
  }

  /** Brings a page's dialog view in line with its first dialog and where its page is. */
  const sync = (p: PageDialogs) => {
    const first = p.queue[0]
    if (!first || p.page.isDestroyed()) {
      hide(p, true)
      return
    }
    const host = hostOf(p.page)
    const bounds = host ? placeOf(p, host) : undefined
    if (!host || !bounds || bounds.width < 1 || bounds.height < 1) {
      hide(p, false)
      return
    }
    const view = ensureView(p, host)
    if (!view || !p.ready) return
    send(p, first.content)
    const appearing = !p.onScreen
    if (host.kind === 'tab' && host.windowId) windows.showUiView(host.windowId, view, bounds)
    else {
      // Over the page, which sits above the window's overlay (a Peek) or alone in its window.
      const parent = host.win.contentView
      if (parent.children[parent.children.length - 1] !== view) parent.addChildView(view)
      const at = view.getBounds()
      if (at.x !== bounds.x || at.y !== bounds.y || at.width !== bounds.width || at.height !== bounds.height) {
        view.setBounds(bounds)
      }
      if (!view.getVisible()) view.setVisible(true)
    }
    p.onScreen = true
    if (appearing && pageIsCurrent(p, host)) viewContents(view)?.focus()
  }

  const syncAll = () => {
    for (const p of pages.values()) sync(p)
  }

  const entryFor = (page: WebContents): PageDialogs => {
    const existing = pages.get(page.id)
    if (existing) return existing
    // The page has the keyboard while its dialog shows: the dialog takes it (KS-19).
    const onFocus = () => {
      const p = pages.get(page.id)
      if (p?.queue.length && p.onScreen) viewContents(p.view)?.focus()
    }
    const gone = () => {
      const p = pages.get(page.id)
      if (!p) return
      pages.delete(page.id)
      p.off()
      for (const dialog of p.queue.splice(0)) dialog.resolve(null)
      release(p)
    }
    const onBounds = () => {
      const p = pages.get(page.id)
      if (p?.queue.length) sync(p)
    }
    page.on('focus', onFocus)
    page.once('destroyed', gone)
    // A Peek's or a Mini Window's page moves on its own: the dialog follows it.
    const tabId = tabs.tabIdFor(page)
    const pageView = tabId ? tabs.get(tabId) : undefined
    pageView?.on('bounds-changed', onBounds)
    const p: PageDialogs = {
      page,
      queue: [],
      ready: false,
      onScreen: false,
      off: () => {
        if (!page.isDestroyed()) {
          page.off('focus', onFocus)
          page.off('destroyed', gone)
        }
        pageView?.off('bounds-changed', onBounds)
      },
    }
    pages.set(page.id, p)
    return p
  }

  const settle = (p: PageDialogs, dialog: Dialog, answer: PageDialogAnswer | null) => {
    const at = p.queue.indexOf(dialog)
    if (at < 0) return
    p.queue.splice(at, 1)
    const wasFirst = at === 0
    dialog.resolve(answer)
    if (p.queue.length === 0) {
      // The keyboard goes back to the page (KS-16); a main window keeps the view for its next dialog.
      hide(p, true)
      release(p)
      p.off()
      pages.delete(p.page.id)
      return
    }
    if (wasFirst) sync(p)
  }

  const service: PageDialogs$ = {
    open(page, content, script = false) {
      return new Promise((resolve) => {
        if (page.isDestroyed()) {
          resolve(null)
          return
        }
        const p = entryFor(page)
        const dialog: Dialog = { content: { ...content, id: nextId++ }, resolve, script }
        p.queue.push(dialog)
        if (p.queue.length === 1) sync(p)
      })
    },
    dismiss(page, which) {
      const p = pages.get(page.id)
      if (!p) return
      for (const dialog of [...p.queue]) if (which === 'all' || dialog.script) settle(p, dialog, null)
    },
    pending(page, which = 'all') {
      const queue = pages.get(page.id)?.queue ?? []
      return which === 'all' ? queue.length > 0 : queue.some((dialog) => dialog.script)
    },
    hostable: (page) => hostable(page),
    info() {
      return [...pages.values()].flatMap((p) => {
        const first = p.queue[0]
        if (!first) return []
        return [
          {
            id: first.content.id,
            kind: first.content.kind,
            title: first.content.title,
            message: first.content.message,
            tabId: tabs.tabIdFor(p.page) ?? null,
            host: hostOf(p.page)?.kind ?? null,
            onScreen: p.onScreen,
            focused: hasKeyboard(p.view),
            ...(p.onScreen && p.view ? { bounds: p.view.getBounds() } : {}),
            waiting: p.queue.length - 1,
          },
        ]
      })
    },
  }

  commands.register('pages.dialogContent', (_args, c) => {
    for (const p of pages.values()) {
      if (!c.sender || viewContents(p.view) !== c.sender) continue
      const first = p.queue[0]
      if (first) p.sent = first.content.id
      return first?.content ?? null
    }
    return null
  })

  commands.register('pages.dialogAnswer', (answer, c) => {
    for (const p of pages.values()) {
      const first = p.queue[0]
      if (!first || first.content.id !== answer.id || !c.sender || viewContents(p.view) !== c.sender) continue
      settle(p, first, {
        id: answer.id,
        ok: answer.ok === true,
        ...(typeof answer.value === 'string' ? { value: answer.value } : {}),
        ...(typeof answer.user === 'string' ? { user: answer.user } : {}),
        ...(typeof answer.password === 'string' ? { password: answer.password } : {}),
      })
      return
    }
  })

  // Pages move: tab switches, splits, resizes, full screen, DevTools docking, the Library.
  windows.onLayout(() => syncAll())
  store.subscribe(() => {
    if (pages.size > 0) syncAll()
  })

  // A page's alert, confirm or prompt (the page preload, NV-24): the page waits for the answer.
  ipcMain.on(PAGE_CHANNEL.dialog, (event: IpcMainEvent, kind: unknown, message: unknown, value: unknown) => {
    let replied = false
    const reply = (result: unknown) => {
      if (replied) return
      replied = true
      event.returnValue = result
    }
    try {
      const page = event.sender
      const frame = event.senderFrame
      if (kind !== 'alert' && kind !== 'confirm' && kind !== 'prompt') {
        reply(null)
        return
      }
      // Only a page's main frame has the preload (D40), and only a tab's or a pop-up's page has a
      // place for the dialog.
      if (!frame || frame.parent || page.isDestroyed() || !hostable(page)) {
        reply(scriptAnswer(kind, null))
        return
      }
      const content = scriptDialog(kind, frame.url, String(message ?? ''), String(value ?? ''))
      service.open(page, content, true).then(
        (answer) => reply(scriptAnswer(kind, answer)),
        () => reply(scriptAnswer(kind, null)),
      )
    } catch (err) {
      console.error('[pages] page dialog', err)
      reply(null)
    }
  })

  /** A page whose dialogs Orbit can place: a tab's (Peek and Mini Window pages are tabs) or a pop-up's. */
  const hostable = (page: WebContents): boolean => {
    if (tabs.tabIdFor(page)) return true
    if (windows.isUi(page)) return false
    return BrowserWindow.fromWebContents(page)?.webContents === page
  }

  return service
}
