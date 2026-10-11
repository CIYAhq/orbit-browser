import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, shell, type WebContents } from 'electron'
import {
  appDialog,
  appName,
  appScheme,
  launchableUrl,
  noAppMessage,
  type OtherApp,
  type PageDialogAnswer,
} from '../../shared/pages'
import { isPrivateProfile } from '../../shared/private'
import { permissionOrigin } from '../../shared/site'
import type { ProfileId, TabId } from '../../shared/state'
import { sectionOf } from '../../shared/tree'
import type { MainContext } from '../context'
import { setAppLinkHandler } from '../nav/permissions'
import { isActivation } from '../tabs/runtime'
import { activeTabOf } from '../windows'
import type { PageDialogs$ } from './dialogs'

/**
 * Opens a link in the app the OS has for it: the one place Orbit launches another app (NV-19).
 * Fails when the OS couldn't. Test runs put a recorder in its place, so no test ever starts an app.
 */
export type LaunchApp = (url: string) => Promise<void>

/**
 * The app the OS opens a link in: its name and icon, `undefined` when the OS can't say (Linux may
 * not know), or `null` when the OS says no app opens links of that kind.
 */
export type FindApp = (url: string) => Promise<OtherApp | null | undefined>

/**
 * What came of a page's link to another app (NV-19): Orbit asked, opened it without asking (always
 * allowed), or dropped it (a question was up already, or the page had no new user gesture for it).
 */
export type AppLinkOutcome = 'asked' | 'opened' | 'dropped'

/** The real launch: the OS opens the link in its app. */
export const launchInApp: LaunchApp = (url) => shell.openExternal(launchableUrl(url))

/** The app the OS has for a link: macOS and Windows name it and give its icon; Linux names its desktop entry. */
export const findSystemApp: FindApp = async (url) => {
  let name = ''
  try {
    name = app.getApplicationNameForProtocol(url)
  } catch {
    // The OS couldn't say.
  }
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    const shown = appName(name, process.platform)
    return shown ? { name: shown } : undefined
  }
  let icon: string | undefined
  try {
    const info = await app.getApplicationInfoForProtocol(url)
    if (!info.icon.isEmpty()) icon = info.icon.resize({ width: 64, height: 64 }).toDataURL()
    name ||= info.name
  } catch {
    // No app, or none the OS will describe.
  }
  const shown = appName(name, process.platform)
  return shown ? { name: shown, ...(icon ? { icon } : {}) } : null
}

/**
 * The apps a test run's OS has (ORBIT_E2E_APPS: JSON, by scheme, `{ name, icon? }`, or null for "no
 * app opens these"); any other scheme's app goes unnamed, as on Linux.
 */
export function findTestApp(spec: string | undefined): FindApp {
  let apps: Record<string, OtherApp | null> = {}
  try {
    const parsed = JSON.parse(spec ?? '{}') as unknown
    if (parsed && typeof parsed === 'object') apps = parsed as Record<string, OtherApp | null>
  } catch {
    // None.
  }
  return async (url) => {
    const found = apps[appScheme(url)]
    if (found === null) return null
    return found && typeof found.name === 'string' ? found : undefined
  }
}

/**
 * The sites always allowed to open links of a kind in their app ("Always allow", NV-19), per
 * profile, origin and scheme. Kept in their own file; a private profile's stay in memory and go
 * with it.
 */
class AlwaysAllowed {
  private saved: Record<string, Record<string, string[]>> = {}
  private memory: Record<string, Record<string, string[]>> = {}

  constructor(
    private file: string,
    private isPrivate: (profileId: ProfileId) => boolean,
  ) {}

  load(): void {
    let raw: unknown
    try {
      raw = (JSON.parse(readFileSync(this.file, 'utf8')) as { allowed?: unknown }).allowed
    } catch {
      return
    }
    if (!raw || typeof raw !== 'object') return
    for (const [profileId, origins] of Object.entries(raw as Record<string, unknown>)) {
      if (!origins || typeof origins !== 'object') continue
      for (const [origin, schemes] of Object.entries(origins as Record<string, unknown>)) {
        if (!Array.isArray(schemes) || permissionOrigin(origin) !== origin) continue
        const kept = schemes.filter((s): s is string => typeof s === 'string' && appScheme(`${s}:`) === s)
        if (kept.length === 0) continue
        const origins = this.saved[profileId] ?? {}
        origins[origin] = kept
        this.saved[profileId] = origins
      }
    }
  }

  has(profileId: ProfileId, origin: string, scheme: string): boolean {
    return this.of(profileId)[profileId]?.[origin]?.includes(scheme) ?? false
  }

  add(profileId: ProfileId, origin: string, scheme: string): void {
    const all = this.of(profileId)
    const origins = all[profileId] ?? {}
    const schemes = origins[origin] ?? []
    if (schemes.includes(scheme)) return
    origins[origin] = [...schemes, scheme]
    all[profileId] = origins
    if (!this.isPrivate(profileId)) this.save()
  }

  /** A profile that was deleted, or a private session that ended. */
  forget(profileId: ProfileId): void {
    if (profileId in this.memory) delete this.memory[profileId]
    if (!(profileId in this.saved)) return
    delete this.saved[profileId]
    this.save()
  }

  private of(profileId: ProfileId): Record<string, Record<string, string[]>> {
    return this.isPrivate(profileId) ? this.memory : this.saved
  }

  /** Written at once: a choice is rare, and small. */
  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const next = `${this.file}.tmp`
      writeFileSync(next, JSON.stringify({ allowed: this.saved }))
      renameSync(next, this.file)
    } catch (err) {
      console.error('[pages] saving “Always allow”', err)
    }
  }
}

/** Said when the OS couldn't open a link in its app. */
const NOT_OPENED = 'Couldn’t open the link in another app'

/** A page that never showed one: nothing committed, nothing to go back to. */
function neverShowedPage(page: WebContents): boolean {
  const url = page.getURL()
  return (url === '' || url === 'about:blank') && !page.navigationHistory.canGoBack()
}

/**
 * Links that open other apps (NV-19): `mailto:`, `tel:`, `zoommtg:`… The engine hands each to
 * Orbit instead of launching it (`setAppLinkHandler`, nav/permissions.ts), naming the frame that
 * followed the link. Orbit asks over that page, in a page dialog: the app with its icon, the site,
 * and "Always allow" for a web site; Cancel is the default. Open launches the app through
 * `launch`, the one place Orbit starts another app. A site always allowed for a kind of link opens
 * it without asking, once per user gesture in the page, as in Chromium: a page can't open the app
 * again and again unasked. A page asks one question at a time: a link it follows meanwhile is dropped.
 * Once the user answers Cancel, the page asks again only after a new user gesture in it, as in
 * Chromium: a page can't keep asking once the user said no.
 *
 * A tab, Peek, Mini Window or pop-up opened only for such a link (`target=_blank`, `window.open`,
 * or a redirect there) never shows a page: it closes itself once its navigation ends, and the tab
 * it came from is selected again. The engine names the page that opened it as the one asking, so
 * the question shows there. When the one asking is that page itself (nothing opened it), it closes
 * after the answer.
 */
export function registerOtherApps(
  ctx: MainContext,
  dialogs: PageDialogs$,
  deps: {
    launch: LaunchApp
    findApp: FindApp
    /** Test runs: hears what came of each link (NV-19). */
    note?: (url: string, outcome: AppLinkOutcome) => void
  },
): void {
  const { store, tabs, windows, commands } = ctx
  const choices = new AlwaysAllowed(join(ctx.paths.userData, 'orbit-app-links.json'), (id) =>
    isPrivateProfile(store.state.profiles[id]),
  )
  choices.load()
  // A deleted profile's choices, and a private session's, go with it.
  store.subscribe((next, prev) => {
    if (next.profiles === prev.profiles) return
    for (const id of Object.keys(prev.profiles)) if (!next.profiles[id]) choices.forget(id)
  })

  /** Pages asking now (by contents id): one question at a time. */
  const asking = new Set<number>()
  /** Where each watched page's main frame is going, or went last: the address after any redirect. */
  const going = new Map<number, string>()
  /** Pages (by contents id) with a user gesture that no link to another app has used yet. */
  const gestured = new Set<number>()
  /** Pages (by contents id) whose last question the user answered Cancel: they ask again only with a new gesture. */
  const refused = new Set<number>()

  const launchOnly = (page: WebContents) =>
    !page.isDestroyed() && !asking.has(page.id) && !!appScheme(going.get(page.id)) && neverShowedPage(page)

  /** Closes a page opened only for another app's link: its tab (selecting its opener again), Peek, Mini Window or pop-up. */
  const closeLaunchOnly = (page: WebContents) => {
    if (!launchOnly(page)) return
    const tabId = tabs.tabIdFor(page)
    if (tabId) {
      closeTab(tabId)
      return
    }
    const win = BrowserWindow.fromWebContents(page)
    // A pop-up's page is its window's own contents (a browser window's is Orbit's UI).
    if (win && !win.isDestroyed() && win.webContents === page) win.close()
  }

  const closeTab = (tabId: TabId) => {
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
    // Pinned tabs and Favorites stay, whatever they were asked to load.
    if (sectionOf(store.state, tabId) !== 'today') return
    const wasShown = !!windowId && activeTabOf(store.state, windowId) === tabId
    const opener = tab.openerTabId && store.state.tabs[tab.openerTabId] ? tab.openerTabId : undefined
    // It never showed a page: no Archive entry, and nothing for Reopen Closed Tab.
    store.update((d) => {
      const t = d.tabs[tabId]
      if (t) t.url = 'about:blank'
    })
    // The opener first: closing the selected tab would select a neighbour on the way.
    const back = wasShown && opener ? commands.run('tabs.activate', { tabId: opener }, { windowId }) : undefined
    void Promise.resolve(back)
      .then(() => commands.run('tabs.close', { tabId }, { windowId }))
      .catch(() => {})
  }

  const watch = (page: WebContents) => {
    const { id } = page
    page.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) going.set(id, details.url)
    })
    page.on('did-redirect-navigation', (details) => {
      if (details.isMainFrame) going.set(id, details.url)
    })
    page.on('did-stop-loading', () => {
      if (launchOnly(page)) setImmediate(() => closeLaunchOnly(page))
    })
    page.on('input-event', (_event, input) => {
      if (isActivation(input)) gestured.add(id)
    })
    // A click in a frame from another site (in a process of its own) comes only as a mouse event.
    page.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type === 'mouseDown') gestured.add(id)
    })
    page.once('destroyed', () => {
      going.delete(id)
      asking.delete(id)
      gestured.delete(id)
      refused.delete(id)
    })
  }
  ctx.hooks.tabCreated.push((_tabId, contents) => {
    watch(contents)
    contents.on('did-create-window', (popup) => watch(popup.webContents))
  })

  const toastFor = (page: WebContents, message: string) => {
    const tabId = page.isDestroyed() ? undefined : tabs.tabIdFor(page)
    ctx.toast((tabId && windows.windowOfTab(tabId)) || windows.focusedWindowId(), message)
  }

  const launch = (page: WebContents, url: string) => {
    deps.launch(url).catch((err: unknown) => {
      console.error('[pages] opening another app', err)
      toastFor(page, NOT_OPENED)
    })
  }

  const ask = async (profileId: ProfileId, page: WebContents, url: string, scheme: string, origin: string | null) => {
    const { id } = page
    const at = page.getURL()
    let answer: PageDialogAnswer | null = null
    try {
      const found = await deps.findApp(url)
      // The page went, or moved on, while the OS was asked.
      if (page.isDestroyed() || page.getURL() !== at) return
      if (found === null) {
        toastFor(page, noAppMessage(scheme))
        return
      }
      answer = await dialogs.open(page, appDialog(found, origin))
    } finally {
      asking.delete(id)
    }
    // Cancel (or Esc): the page's next link asks only with a new gesture (Chromium's rule).
    if (answer && !answer.ok) refused.add(id)
    if (answer?.ok) {
      if (answer.checked === true && origin && /^https?:\/\//i.test(origin)) choices.add(profileId, origin, scheme)
      launch(page, url)
    }
    if (!page.isDestroyed()) closeLaunchOnly(page)
  }

  setAppLinkHandler((profileId, page, details) => {
    const url = 'externalURL' in details && typeof details.externalURL === 'string' ? details.externalURL : ''
    const scheme = appScheme(url)
    if (!scheme || page.isDestroyed() || !dialogs.hostable(page)) return
    // The site asking is the frame that followed the link (the page's own, or one in it).
    const origin = permissionOrigin(details.requestingUrl)
    // Each link to another app uses up the page's last user gesture (Chromium's rule).
    const fresh = gestured.delete(page.id)
    if (origin && /^https?:\/\//i.test(origin) && choices.has(profileId, origin, scheme)) {
      // Always allowed: it opens without asking, but only for a gesture no link used yet (NV-19).
      if (fresh) launch(page, url)
      deps.note?.(url, fresh ? 'opened' : 'dropped')
      return
    }
    // One question at a time; and after a Cancel, none until the user does something in the page.
    if (asking.has(page.id) || (refused.has(page.id) && !fresh)) {
      deps.note?.(url, 'dropped')
      return
    }
    refused.delete(page.id)
    asking.add(page.id)
    deps.note?.(url, 'asked')
    void ask(profileId, page, url, scheme, origin).catch((err: unknown) => console.error('[pages] link to an app', err))
  })
}
