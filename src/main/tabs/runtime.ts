import { type NavigationEntry, type WebContents, WebContentsView } from 'electron'
import type { Tab, TabId } from '../../shared/state'
import type { MainContext } from '../context'
import { showPageContextMenu } from './context-menu'

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
  private ctx!: MainContext

  init(ctx: MainContext): void {
    this.ctx = ctx
  }

  get(tabId: TabId): WebContentsView | undefined {
    return this.views.get(tabId)
  }

  contents(tabId: TabId): WebContents | undefined {
    const view = this.views.get(tabId)
    return view && !view.webContents.isDestroyed() ? view.webContents : undefined
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
    if (existing && !existing.webContents.isDestroyed()) return existing
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
    this.views.set(tabId, view)
    this.byContents.set(contents.id, tabId)
    view.setBackgroundColor('#ffffffff')
    this.update(tabId, { asleep: false })

    const navState = () => ({
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    })
    contents.on('did-start-loading', () => this.update(tabId, { loading: true, error: undefined }))
    contents.on('did-stop-loading', () => this.update(tabId, { loading: false, ...navState() }))
    contents.on('did-navigate', (_e, url) => {
      this.update(tabId, { url, ...navState() })
      for (const hook of this.ctx.hooks.tabNavigated) hook(tabId, contents, url)
    })
    contents.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) this.update(tabId, { url, ...navState() })
    })
    contents.on('page-title-updated', (_e, title) => this.update(tabId, { title }))
    contents.on('page-favicon-updated', (_e, favicons) => {
      const icon = favicons.find((f) => /^(https?|data):/.test(f))
      if (icon) this.update(tabId, { favicon: icon })
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
      for (const hook of this.ctx.hooks.windowOpen) {
        const response = hook(tabId, details)
        if (response) return response
      }
      return { action: 'deny' }
    })
    contents.once('destroyed', () => {
      this.byContents.delete(contents.id)
      if (this.views.get(tabId) === view) {
        this.views.delete(tabId)
        this.update(tabId, { asleep: true, loading: false, audible: false })
      }
    })
    this.ctx.windows.attachShortcuts(contents)
    for (const hook of this.ctx.hooks.tabCreated) hook(tabId, contents)
  }

  /** Puts a tab to sleep: remembers its history and frees its renderer. */
  sleep(tabId: TabId): void {
    const view = this.views.get(tabId)
    if (!view) return
    const contents = view.webContents
    if (!contents.isDestroyed()) {
      const entries = contents.navigationHistory.getAllEntries()
      if (entries.length > 0) {
        this.savedHistory.set(tabId, { entries, index: contents.navigationHistory.getActiveIndex() })
      }
    }
    this.views.delete(tabId)
    this.ctx.windows.detachView(tabId, view)
    if (!contents.isDestroyed()) contents.close()
    this.byContents.delete(contents.id)
    this.update(tabId, { asleep: true, loading: false, audible: false })
  }

  /** Destroys a tab's contents without remembering history (tab is being removed). */
  destroy(tabId: TabId): void {
    this.savedHistory.delete(tabId)
    const view = this.views.get(tabId)
    if (!view) return
    this.views.delete(tabId)
    this.ctx.windows.detachView(tabId, view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  navigate(tabId: TabId, url: string): void {
    const view = this.views.get(tabId)
    if (!view) {
      this.savedHistory.delete(tabId)
      this.ctx.store.update((d) => {
        const tab = d.tabs[tabId]
        if (tab) tab.url = url
      })
      return
    }
    this.load(view.webContents, url)
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
