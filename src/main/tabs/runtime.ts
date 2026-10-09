import { join } from 'node:path'
import { type NavigationEntry, nativeImage, type WebContents, WebContentsView } from 'electron'
import { isPrivateProfileId } from '../../shared/private'
import type { Tab, TabId } from '../../shared/state'
import { isAwayFromPinned, sameDocUrl } from '../../shared/tabs'
import type { MainContext } from '../context'
import { showPageContextMenu } from './context-menu'
import { FaviconStore } from './favicon-store'
import { isIco, readIco } from './ico'

/**
 * A view's web contents if it is alive. While a page closes itself, `view.webContents` is already
 * undefined before 'destroyed' fires, so it must never be dereferenced blindly.
 */
function liveContents(view: WebContentsView | undefined): WebContents | undefined {
  const contents = view?.webContents as WebContents | undefined
  return contents && !contents.isDestroyed() ? contents : undefined
}

/** Keys that never count as a user activation (HTML: Escape and lone modifiers). */
const NON_ACTIVATING_KEYS = new Set(['Escape', 'Shift', 'Control', 'Alt', 'Meta', 'Command', 'Cmd', 'CapsLock'])

/** Input that counts as a user activation for opening tabs and pop-ups (NV-09, HTML user activation). */
function isActivation(input: Electron.InputEvent): boolean {
  if (input.type === 'mouseDown' || input.type === 'touchEnd' || input.type === 'gestureTap') return true
  if (input.type !== 'rawKeyDown' && input.type !== 'keyDown') return false
  if (input.modifiers?.includes('isautorepeat')) return false
  const key = (input as { keyCode?: string }).keyCode ?? ''
  return !NON_ACTIVATING_KEYS.has(key)
}
const GESTURE_WINDOW_MS = 1000
/** Every stored favicon is a data URL of at most this many characters (lane review MF-2). */
const MAX_FAVICON_DATA_URL = 16 * 1024
const MAX_FAVICON_FETCH_BYTES = 512 * 1024
const FAVICON_PX = 32

/**
 * A small data URL for an icon, or nothing. Raster images (ICO frames included, decoded here
 * because nativeImage can't read ICO everywhere) become ≤32 px PNGs; SVG and anything else
 * undecodable is kept only if it already fits.
 */
function faviconDataUrl(buf: Buffer, type: string): string | undefined {
  const fits = (url: string | undefined) => (url && url.length <= MAX_FAVICON_DATA_URL ? url : undefined)
  const toPng = (image: Electron.NativeImage) => {
    if (image.isEmpty()) return undefined
    const { width } = image.getSize()
    return fits((width > FAVICON_PX ? image.resize({ width: FAVICON_PX, quality: 'best' }) : image).toDataURL())
  }
  if (isIco(buf)) {
    const frame = readIco(buf, FAVICON_PX)
    if (!frame) return undefined
    const image =
      frame.kind === 'png'
        ? nativeImage.createFromBuffer(Buffer.from(frame.data))
        : nativeImage.createFromBitmap(Buffer.from(frame.data), { width: frame.width, height: frame.height })
    return toPng(image)
  }
  if (type !== 'image/svg+xml') {
    const png = toPng(nativeImage.createFromBuffer(buf))
    if (png) return png
  }
  return fits(`data:${type};base64,${buf.toString('base64')}`)
}

/** Bytes and type of a `data:` URL (base64 or percent-encoded). */
function decodeDataUrl(url: string): { buf: Buffer; type: string } | undefined {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(url)
  if (!m) return undefined
  const type = m[1] || 'text/plain'
  try {
    const buf = /;base64/i.test(m[2] ?? '')
      ? Buffer.from(m[3] ?? '', 'base64')
      : Buffer.from(decodeURIComponent(m[3] ?? ''))
    return { buf, type }
  } catch {
    return undefined
  }
}

/** Script run in an isolated world: is keyboard focus in an editable field of the page? */
const FOCUS_IS_EDITABLE = `(() => {
  const el = document.activeElement
  if (!el || el === document.body) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'IFRAME' || tag === 'EMBED' || tag === 'OBJECT'
})()`

type RuntimeFields = Partial<
  Pick<
    Tab,
    'url' | 'title' | 'favicon' | 'loading' | 'audible' | 'canGoBack' | 'canGoForward' | 'asleep' | 'error' | 'progress'
  >
>

export interface SavedHistory {
  entries: NavigationEntry[]
  index: number
}

/**
 * Owns the live Chromium web contents (one WebContentsView per awake tab).
 * Tabs exist in state whether or not they are awake; a sleeping tab has no
 * view and is recreated on demand from its URL or saved navigation history.
 */
export class TabRuntime {
  private views = new Map<TabId, WebContentsView>()
  private byContents = new Map<number, TabId>()
  /** Navigation history of sleeping tabs, so waking restores back/forward. */
  readonly savedHistory = new Map<TabId, SavedHistory>()
  /** Pinned tabs loading their pinned URL: the URL they land on (after redirects) counts as home (PN-03). */
  private homeLoads = new Set<TabId>()
  /** Sidebar undo, called for ⌘Z pressed in a page whose focus is not in a text field (TB-18). */
  onUndoShortcut?: (tabId: TabId, redo: boolean) => void
  /** A page closed itself (window.close()); treated like closing the tab (TB-06). */
  onPageClosed?: (tabId: TabId) => void
  /** Control was released in a page (ends recent-tab switching, TB-05). */
  onControlUp?: () => void
  /** A page tried to open a tab or pop-up without a user gesture. */
  onPopupBlocked?: (tabId: TabId, url: string) => void
  /** True when the tab's site may open pop-ups without a click (allowed in site controls, NV-09). */
  allowsPopups?: (tabId: TabId) => boolean
  /** Last user gesture per tab, for the pop-up rule (NV-09). */
  private gestures = new Map<TabId, { at: number; used: boolean }>()
  /** Favicon URL → data URL, fetched in the tab's own session (no fetches from Orbit's UI). */
  private favicons = new Map<string, string>()
  /** Icons by origin, out of OrbitState (lane review MF-2). */
  private faviconStore: FaviconStore | undefined
  /** The favicon each tab asked for last (a slower, older fetch must not win). */
  private wantedFavicon = new Map<TabId, string>()
  private ctx!: MainContext

  init(ctx: MainContext): void {
    this.ctx = ctx
    this.faviconStore = new FaviconStore(join(ctx.paths.userData, 'orbit-favicons.json'))
    this.faviconStore.load()
  }

  get(tabId: TabId): WebContentsView | undefined {
    return this.views.get(tabId)
  }

  contents(tabId: TabId): WebContents | undefined {
    return liveContents(this.views.get(tabId))
  }

  tabIdFor(contents: WebContents): TabId | undefined {
    return this.byContents.get(contents.id)
  }

  liveTabIds(): TabId[] {
    return [...this.views.keys()]
  }

  /** Returns the tab's view, creating and loading it if the tab is asleep. */
  ensure(tabId: TabId): WebContentsView | undefined {
    const existing = this.views.get(tabId)
    if (liveContents(existing)) return existing
    const tab = this.ctx.store.state.tabs[tabId]
    if (!tab) return undefined
    const view = new WebContentsView({
      webPreferences: {
        session: this.ctx.sessions.get(tab.profileId),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: true,
        scrollBounce: true,
        navigateOnDragDrop: false,
        safeDialogs: true,
      },
    })
    this.adopt(tabId, view)
    const saved = this.savedHistory.get(tabId)
    this.savedHistory.delete(tabId)
    const contents = view.webContents
    if (tab.pinnedUrl && sameDocUrl(tab.url, tab.pinnedUrl) && !(saved && saved.entries.length > 0)) {
      this.homeLoads.add(tabId)
    }
    if (saved && saved.entries.length > 0) {
      contents.navigationHistory
        .restore({ entries: saved.entries, index: saved.index })
        .catch(() => this.load(contents, tab.url))
    } else {
      this.load(contents, tab.url)
    }
    if (tab.muted) contents.setAudioMuted(true)
    return view
  }

  /**
   * Wires a view (new, or created by Chromium for window.open) to a tab.
   * The tab must already exist in state.
   */
  adopt(tabId: TabId, view: WebContentsView): void {
    const contents = view.webContents
    // One view per tab: a previous view (e.g. created by a layout pass) is retired first.
    const previous = this.views.get(tabId)
    if (previous && previous !== view) {
      this.views.delete(tabId)
      const old = liveContents(previous)
      if (old) this.byContents.delete(old.id)
      this.ctx.windows.detachView(tabId, previous)
      old?.close()
    }
    this.views.set(tabId, view)
    this.byContents.set(contents.id, tabId)
    view.setBackgroundColor('#ffffffff')
    this.update(tabId, { asleep: false })

    const navState = () => ({
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    })
    contents.on('did-start-loading', () => this.update(tabId, { loading: true, error: undefined }))
    contents.on('did-stop-loading', () => {
      this.homeLoads.delete(tabId)
      this.update(tabId, { loading: false, ...navState() })
    })
    contents.on('did-navigate', (_e, url) => {
      if (this.homeLoads.has(tabId)) this.setPinnedHome(tabId, url)
      this.update(tabId, { url, ...navState() })
      for (const hook of this.ctx.hooks.tabNavigated) hook(tabId, contents, url)
    })
    contents.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) this.update(tabId, { url, ...navState() })
    })
    contents.on('page-title-updated', (_e, title) => {
      this.update(tabId, { title })
      this.trackPinnedTitle(tabId, title)
    })
    contents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyUp' && input.key === 'Control') this.onControlUp?.()
      // ⌘Z / Ctrl+Z (with ⇧: redo): the page's own undo wins in text fields; elsewhere it undoes the
      // last sidebar change.
      if (input.type !== 'keyDown' || input.alt || input.key.toLowerCase() !== 'z') return
      const mod = process.platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
      if (!mod || !this.onUndoShortcut) return
      contents
        .executeJavaScriptInIsolatedWorld(999, [{ code: FOCUS_IS_EDITABLE }])
        .then((editable) => {
          if (!editable) this.onUndoShortcut?.(tabId, !!input.shift)
        })
        .catch(() => {})
    })
    contents.on('page-favicon-updated', (_e, favicons) => {
      const icon = favicons.find((f) => /^(https?|data):/.test(f))
      if (icon) void this.storeFavicon(tabId, contents, icon)
    })
    // Pop-ups need a recent user gesture in the opener (NV-09).
    contents.on('input-event', (_e, input) => {
      if (!isActivation(input)) return
      const now = Date.now()
      const last = this.gestures.get(tabId)
      // One physical press can arrive as two events (raw key down + key down): one activation.
      if (last && now - last.at < 30) last.at = now
      else this.gestures.set(tabId, { at: now, used: false })
    })
    contents.on('audio-state-changed', (e) => this.update(tabId, { audible: e.audible }))
    contents.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
      // -3 is ERR_ABORTED (e.g. a navigation replaced by another); not an error page.
      if (isMainFrame && code !== -3) this.update(tabId, { error: { code, description }, loading: false })
    })
    contents.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return
      this.update(tabId, { error: { code: -1000, description: `Page crashed (${details.reason})` }, loading: false })
    })
    contents.on('context-menu', (_e, params) => showPageContextMenu(this.ctx, tabId, contents, params))
    contents.setWindowOpenHandler((details) => {
      // No tabs or pop-ups without a user gesture, and one per gesture (NV-09).
      if (!this.consumeGesture(tabId) && !this.allowsPopups?.(tabId)) {
        this.onPopupBlocked?.(tabId, details.url)
        return { action: 'deny' }
      }
      for (const hook of this.ctx.hooks.windowOpen) {
        const response = hook(tabId, details)
        if (response) return response
      }
      return { action: 'deny' }
    })
    contents.once('destroyed', () => {
      this.byContents.delete(contents.id)
      this.gestures.delete(tabId)
      this.wantedFavicon.delete(tabId)
      if (this.views.get(tabId) !== view) return
      // Destroyed outside sleep()/destroy(): the page closed itself (window.close()).
      this.views.delete(tabId)
      this.ctx.windows.detachView(tabId, view)
      this.update(tabId, { asleep: true, loading: false, audible: false })
      if (!this.ctx.windows.quitting) this.onPageClosed?.(tabId)
    })
    this.ctx.windows.attachShortcuts(contents)
    for (const hook of this.ctx.hooks.tabCreated) hook(tabId, contents)
  }

  /** Puts a tab to sleep: remembers its history and frees its renderer. */
  sleep(tabId: TabId): void {
    const view = this.views.get(tabId)
    if (!view) return
    const contents = liveContents(view)
    if (contents) {
      const entries = contents.navigationHistory.getAllEntries()
      if (entries.length > 0) {
        this.savedHistory.set(tabId, { entries, index: contents.navigationHistory.getActiveIndex() })
      }
    }
    this.views.delete(tabId)
    this.ctx.windows.detachView(tabId, view)
    if (contents) {
      this.byContents.delete(contents.id)
      contents.close()
    }
    this.update(tabId, { asleep: true, loading: false, audible: false })
  }

  /** Destroys a tab's contents without remembering history (tab is being removed). */
  destroy(tabId: TabId): void {
    this.savedHistory.delete(tabId)
    const view = this.views.get(tabId)
    if (!view) return
    this.views.delete(tabId)
    this.ctx.windows.detachView(tabId, view)
    liveContents(view)?.close()
  }

  /**
   * True once per user gesture in the tab within the last second: a page may open one
   * tab or pop-up per click or key press, never on its own (NV-09).
   */
  consumeGesture(tabId: TabId, now = Date.now()): boolean {
    const g = this.gestures.get(tabId)
    if (!g || g.used || now - g.at > GESTURE_WINDOW_MS) return false
    g.used = true
    return true
  }

  /** Stores the favicon as a small data URL fetched with the tab's session. */
  private async storeFavicon(tabId: TabId, contents: WebContents, url: string): Promise<void> {
    this.wantedFavicon.set(tabId, url)
    if (url.startsWith('data:')) {
      const decoded = url.length <= MAX_FAVICON_FETCH_BYTES * 1.4 ? decodeDataUrl(url) : undefined
      const data = decoded?.type.startsWith('image/') ? faviconDataUrl(decoded.buf, decoded.type) : undefined
      if (data) this.setFavicon(tabId, data)
      return
    }
    const cached = this.favicons.get(url)
    if (cached) {
      this.setFavicon(tabId, cached)
      return
    }
    try {
      const res = await contents.session.fetch(url, { cache: 'force-cache' })
      if (!res.ok) return
      const type = (res.headers.get('content-type') ?? 'image/x-icon').split(';')[0]?.trim() || 'image/x-icon'
      if (!type.startsWith('image/')) return
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length === 0 || buf.length > MAX_FAVICON_FETCH_BYTES) return
      const data = faviconDataUrl(buf, type)
      if (!data) return
      if (this.favicons.size > 500) this.favicons.clear()
      this.favicons.set(url, data)
      if (!contents.isDestroyed() && this.wantedFavicon.get(tabId) === url) this.setFavicon(tabId, data)
    } catch {
      // Keep the previous icon (or the fallback glyph).
    }
  }

  /** A tab's icon, also remembered by origin (outside OrbitState) for archived pages and lists. */
  private setFavicon(tabId: TabId, data: string): void {
    this.update(tabId, { favicon: data })
    const tab = this.ctx.store.state.tabs[tabId]
    // Private tabs' icons are not remembered (NV-11).
    if (tab?.url && !isPrivateProfileId(tab.profileId)) this.faviconStore?.set(tab.url, data)
  }

  /** The remembered icon for a page's origin (archive, history, command bar). */
  faviconFor(pageUrl: string): string | undefined {
    return this.faviconStore?.get(pageUrl)
  }

  /** Remembers an icon for a page's origin (e.g. moved out of an archive entry). */
  rememberFavicon(pageUrl: string, data: string): void {
    this.faviconStore?.set(pageUrl, data)
  }

  /** The next page this tab lands on is its pinned page (reset, wake at the pinned URL). */
  markHomeLoad(tabId: TabId): void {
    if (this.views.has(tabId)) this.homeLoads.add(tabId)
  }

  /** A pinned URL that redirected: where it landed is home too, so no breadcrumb shows (PN-03). */
  private setPinnedHome(tabId: TabId, url: string): void {
    this.ctx.store.update((d) => {
      const tab = d.tabs[tabId]
      if (!tab?.pinnedUrl || tab.pinnedResolvedUrl === url) return
      tab.pinnedResolvedUrl = url
    })
  }

  /** While a pinned tab shows its pinned page, that page's title is the breadcrumb's first part. */
  private trackPinnedTitle(tabId: TabId, title: string): void {
    const tab = this.ctx.store.state.tabs[tabId]
    if (!tab?.pinnedUrl || !title || tab.pinnedTitle === title || isAwayFromPinned(tab)) return
    this.ctx.store.update((d) => {
      const t = d.tabs[tabId]
      if (t) t.pinnedTitle = title
    })
  }

  navigate(tabId: TabId, url: string): void {
    const view = this.views.get(tabId)
    const contents = liveContents(view)
    if (!contents) {
      this.savedHistory.delete(tabId)
      this.ctx.store.update((d) => {
        const tab = d.tabs[tabId]
        if (tab) tab.url = url
      })
      return
    }
    this.load(contents, url)
  }

  private load(contents: WebContents, url: string): void {
    if (!url || url === 'about:blank') return
    contents.loadURL(url).catch(() => {
      // Failures surface through did-fail-load; ERR_ABORTED is normal on redirects.
    })
  }

  private update(tabId: TabId, fields: RuntimeFields): void {
    this.ctx.store.update((d) => {
      const tab = d.tabs[tabId]
      if (!tab) return
      for (const [key, value] of Object.entries(fields) as [keyof RuntimeFields, unknown][]) {
        if (tab[key] !== value) (tab as Record<string, unknown>)[key] = value
      }
    })
  }
}
