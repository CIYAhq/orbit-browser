import { join } from 'node:path'
import { app, type WebContents } from 'electron'
import type { ProfileId, TabId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import type { CallContext } from '../registry'
import { HistoryStore, isRecordable, sameDocument } from './store'

export type { HostInfo, IndexedEntry } from './store'
export { HistoryStore } from './store'

/** A visit counts as "typed" if the tab navigates within this long after the command bar opened it. */
const TYPED_WINDOW_MS = 15_000

/**
 * Browsing history, one store per profile (userData/history/<profileId>.jsonl).
 * It lives outside OrbitState so state broadcasts stay small.
 *
 * Main-process API (used by the command bar; the History view can use the
 * `history.*` commands from a renderer):
 * - `store(profileId)` → HistoryStore: `entries()`, `hostList()`, `search()`, `visits()`,
 *   `get()`, `delete()`, `clear()` (see store.ts)
 * - `noteTyped(tabId)` marks the tab's next navigation as typed (autocomplete ranking)
 *
 * Visits are recorded from `hooks.tabNavigated` (and in-page navigations), titles and
 * favicons as they arrive. Tabs in non-persistent sessions (private windows) are never recorded.
 */
export class HistoryService {
  private stores = new Map<ProfileId, HistoryStore>()
  private typed = new Map<TabId, number>()

  constructor(readonly dir: string) {}

  /** The profile's store; starts loading it on first use. */
  store(profileId: ProfileId): HistoryStore {
    let s = this.stores.get(profileId)
    if (!s) {
      s = new HistoryStore(this.fileOf(profileId))
      this.stores.set(profileId, s)
      void s.load()
    }
    return s
  }

  noteTyped(tabId: TabId): void {
    this.typed.set(tabId, Date.now())
  }

  /** Called on each main-frame navigation; returns whether the visit was typed. */
  takeTyped(tabId: TabId): boolean {
    const at = this.typed.get(tabId)
    if (at === undefined) return false
    this.typed.delete(tabId)
    return Date.now() - at < TYPED_WINDOW_MS
  }

  flushSync(): void {
    for (const s of this.stores.values()) s.flushSync()
  }

  /** Forgets a deleted profile's history and removes its files. */
  async dropProfile(profileId: ProfileId): Promise<void> {
    const s = this.stores.get(profileId) ?? new HistoryStore(this.fileOf(profileId))
    this.stores.delete(profileId)
    await s.drop()
  }

  private fileOf(profileId: ProfileId): string {
    return join(this.dir, `${profileId.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`)
  }
}

export function registerHistory(ctx: MainContext): HistoryService {
  const { store, commands, windows } = ctx
  const service = new HistoryService(join(ctx.paths.userData, 'history'))

  /** Profile to record a tab's visits in, or undefined (unknown tab, private session). */
  const recordingProfile = (tabId: TabId, contents: WebContents): ProfileId | undefined => {
    const tab = store.state.tabs[tabId]
    if (!tab || contents.isDestroyed()) return undefined
    if (!contents.session.isPersistent()) return undefined
    return tab.profileId
  }

  /** Last main-frame URL per tab, to tell fragment-only changes apart. */
  const lastUrl = new Map<TabId, string>()
  const recordVisit = (tabId: TabId, contents: WebContents, url: string) => {
    const profileId = recordingProfile(tabId, contents)
    if (!profileId || !isRecordable(url)) return
    const typed = service.takeTyped(tabId)
    service.store(profileId).record(url, { typed, title: contents.getTitle() })
  }

  ctx.hooks.tabNavigated.push(recordVisit)
  ctx.hooks.tabCreated.push((tabId, contents) => {
    contents.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      // A same-document change that only moves the fragment (#section) is not a new visit.
      if (isMainFrame && !sameDocument(lastUrl.get(tabId), url)) recordVisit(tabId, contents, url)
      lastUrl.set(tabId, url)
    })
    contents.on('did-navigate', (_e, url) => lastUrl.set(tabId, url))
    contents.once('destroyed', () => lastUrl.delete(tabId))
    contents.on('page-title-updated', (_e, title) => {
      const profileId = recordingProfile(tabId, contents)
      if (profileId) service.store(profileId).setTitle(contents.getURL(), title)
    })
    contents.on('page-favicon-updated', (_e, favicons) => {
      const profileId = recordingProfile(tabId, contents)
      const icon = favicons.find((f) => /^(https?|data):/.test(f))
      if (profileId && icon) service.store(profileId).setFavicon(contents.getURL(), icon)
    })
  })

  const profileOf = (profileId: ProfileId | undefined, c: CallContext): ProfileId => {
    if (profileId) return profileId
    const windowId: WindowId | undefined = c.windowId ?? windows.focusedWindowId()
    const win = windowId ? store.state.windows[windowId] : undefined
    const space = win ? store.state.spaces[win.spaceId] : undefined
    return space?.profileId ?? Object.keys(store.state.profiles)[0] ?? 'p-default'
  }

  commands.register('history.visits', ({ profileId, text, before, limit }, c) =>
    service.store(profileOf(profileId, c)).visits({ text, before, limit }),
  )
  commands.register('history.search', ({ profileId, text, limit }, c) =>
    service.store(profileOf(profileId, c)).search(text, limit),
  )
  commands.register('history.delete', ({ profileId, url }, c) => service.store(profileOf(profileId, c)).delete(url))
  commands.register('history.clear', ({ profileId, from, to }, c) =>
    service.store(profileOf(profileId, c)).clear(from, to),
  )

  // F14: a deleted profile's history goes with it.
  store.subscribe((next, prev) => {
    if (next.profiles === prev.profiles) return
    for (const id of Object.keys(prev.profiles)) {
      if (!next.profiles[id]) void service.dropProfile(id)
    }
  })

  // Load (and compact) every profile's history soon after startup, off the cold-start path.
  setTimeout(() => {
    for (const profileId of Object.keys(store.state.profiles)) service.store(profileId)
  }, 600)
  app.on('before-quit', () => service.flushSync())
  return service
}
