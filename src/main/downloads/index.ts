import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { DEFAULT_PROFILE_ID } from '../../shared/defaults'
import type { ProfileId, TabId, WindowId } from '../../shared/state'
import { sectionOf } from '../../shared/tree'
import type { MainContext } from '../context'
import type { CallContext } from '../registry'
import { activeTabOf } from '../windows'
import { DownloadManager } from './manager'
import { askToQuit, guardQuit, quitQuestion } from './quit'
import { DownloadStore } from './store'

/**
 * Test-only handle (ORBIT_E2E=1): globalThis.__orbitDownloads.
 * - `quitAnswer`: what the user answers when quitting would stop downloads. Unset, test runs
 *   never ask (so `app.close()` always quits).
 * - `asked`: the questions asked so far.
 */
export interface DownloadTestHooks {
  quitAnswer?: 'quit' | 'cancel'
  asked: string[]
  folder: (profileId?: ProfileId) => string
  settle: () => Promise<void>
}

/**
 * Downloads (DL-01): every profile session's downloads go to that profile's download folder.
 * Main-process API for other features: `registerDownloads(ctx)` returns the DownloadManager.
 */
export function registerDownloads(ctx: MainContext): DownloadManager {
  const { store, commands, windows, sessions } = ctx
  // Test runs never write to the real Downloads folder.
  const defaultFolder =
    process.env.ORBIT_DOWNLOADS_DIR || (ctx.e2e ? join(ctx.paths.userData, 'Downloads') : app.getPath('downloads'))
  const folder = (_profileId?: ProfileId) => defaultFolder

  const manager = new DownloadManager(ctx, new DownloadStore(join(ctx.paths.userData, 'downloads.json')), {
    folder,
    notify: (windowId, message) => ctx.toast(windowId, message),
    closeBlankTab: (tabId) => closeBlankTab(ctx, tabId),
    changed: (profileId) => windows.broadcast('orbit:downloads.changed', { profileId }),
  })
  sessions.onSessionCreated((ses, profileId) => manager.attach(ses, profileId))
  // Sessions that aren't a profile's (a private window's) download too.
  app.on('session-created', (ses) => manager.attach(ses))

  const profileOf = (profileId: ProfileId | undefined, c: CallContext): ProfileId => {
    if (profileId && store.state.profiles[profileId]) return profileId
    const windowId: WindowId | undefined = c.windowId ?? windows.focusedWindowId()
    const win = windowId ? store.state.windows[windowId] : undefined
    return (win && store.state.spaces[win.spaceId]?.profileId) || DEFAULT_PROFILE_ID
  }

  commands.register('downloads.list', ({ profileId, limit }, c) => {
    const id = profileOf(profileId, c)
    const live = store.state.downloads
    const list = manager.list.list(id).map(({ resume: _resume, ...d }) => ({ ...d, ...live[d.id] }))
    // A private window's downloads are in no list (DL-16), but its own window shows them.
    const privates = Object.values(live).filter((d) => d.private && d.profileId === id)
    const all = [...privates, ...list].sort((a, b) => b.startedAt - a.startedAt)
    return typeof limit === 'number' ? all.slice(0, Math.max(0, limit)) : all
  })
  commands.register('downloads.cancel', ({ id }) => manager.cancel(id))
  commands.register('downloads.dismiss', ({ id }) => manager.dismiss(id))
  commands.register('downloads.active', () => manager.activeCount())

  // Quitting with downloads in progress asks first (DL-01).
  const hooks: DownloadTestHooks = {
    asked: [],
    folder: (profileId) => folder(profileId ?? DEFAULT_PROFILE_ID),
    settle: () => manager.list.settle(),
  }
  guardQuit({
    active: () => (ctx.e2e && !hooks.quitAnswer ? 0 : manager.activeCount()),
    ask: (count: number, parent: BrowserWindow | undefined) => {
      if (!ctx.e2e) return askToQuit(count, parent)
      hooks.asked.push(quitQuestion(count))
      return Promise.resolve(hooks.quitAnswer === 'quit')
    },
    onQuit: () => manager.flush(),
    lastWindowQuits: process.platform !== 'darwin',
  })
  if (ctx.e2e) (globalThis as unknown as { __orbitDownloads: DownloadTestHooks }).__orbitDownloads = hooks
  return manager
}

/**
 * A tab opened only for a download never showed a page: it closes, and the tab it was opened from
 * is selected again (DL-01, NV-09). A Peek or Mini Window opened for one closes too. Pinned tabs and
 * Favorites stay.
 */
function closeBlankTab(ctx: MainContext, tabId: TabId): void {
  const { store, commands, windows } = ctx
  const tab = store.state.tabs[tabId]
  if (!tab) return
  const windowId = windows.windowOfTab(tabId)
  if (tab.floating === 'peek') {
    if (windowId) void commands.run('peek.close', {}, { windowId })
    return
  }
  if (tab.floating === 'mini') {
    if (windowId) void commands.run('mini.control', { op: 'close' }, { windowId })
    return
  }
  if (sectionOf(store.state, tabId) !== 'today') return
  const wasShown = !!windowId && activeTabOf(store.state, windowId) === tabId
  const opener = tab.openerTabId && store.state.tabs[tab.openerTabId] ? tab.openerTabId : undefined
  // The tab's URL is the file's: the Archive gets no entry for a page that never showed.
  store.update((d) => {
    const t = d.tabs[tabId]
    if (t) t.url = 'about:blank'
  })
  // The opener first: closing the selected tab would select a neighbour on the way.
  const back = wasShown && opener ? commands.run('tabs.activate', { tabId: opener }, { windowId }) : undefined
  void Promise.resolve(back).then(() => commands.run('tabs.close', { tabId }, { windowId }))
}
