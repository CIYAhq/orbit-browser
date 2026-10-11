import { type IpcMainEvent, ipcMain, type Session, type WebContents } from 'electron'
import { isPrivateProfileId } from '../../shared/private'
import { PAGE_CHANNEL, type TweakSheetsAnswer } from '../../shared/site'
import type { OrbitState, ProfileId, TabId, Tweak } from '../../shared/state'
import {
  enabledTweaksFor,
  type SheetOptions,
  type SheetPart,
  tweakHostOf,
  tweakScript,
  tweakSheets,
} from '../../shared/tweaks'
import type { MainContext } from '../context'

/** The isolated world main's own scripts for Tweaks run in (never the page's world). */
export const TWEAK_WORLD = 1040

/** Chromium's net::ERR_ABORTED: a navigation stopped or replaced, which leaves the page as it was. */
const ERR_ABORTED = -3

/** What main knows of a page that may have Tweaks: one per web contents whose preload asked. */
interface PageRecord {
  contents: WebContents
  /** The page's URL when its preload asked (BO-18), followed through in-page navigations. */
  url: string
  /** Its host; null once it shows something Tweaks don't reach. */
  host: string | null
  /** Bumped by each new document's read: the number its answer carries (`TweakSheetsAnswer.doc`). */
  doc: number
  /** The preload's first-paint sheets are in the page, not yet replaced by main's own. */
  preloaded: boolean
  /** Main's sheets in the page, by part (`SheetPart.key`). */
  inserted: Map<string, { key: string; css: string }>
  /** The JavaScript of this document's Tweaks has run (once per load, BO-18). */
  scripted: boolean
  /** A change is being applied; `again` asks for another pass once it is done. */
  busy: boolean
  again: boolean
  /** Sheet options for this page only: a hidden element shown while its restore marker is hovered. */
  showHidden?: string
}

export interface TweakPages {
  /** Whether a tab shows a page Tweaks can change now: a website whose preload asked (BO-01). */
  tweakable(tabId: TabId): boolean
  /** The host of a tab's page, where tweakable. */
  hostOf(tabId: TabId): string | null
  /** True once a tab shows a page Tweaks can change (now, or as its preload asks); false after `ms`. */
  whenTweakable(tabId: TabId, ms: number): Promise<boolean>
  /** Runs a Tweak's JavaScript in a tab's page now (BO-11's "Run now"); false where it may not run. */
  runNow(tabId: TabId, tweakId: string): boolean
  /** Shows one hidden element again for now, or none (BO-10's restore marker preview). */
  setShowHidden(tabId: TabId, hiddenId: string | undefined): void
  /** Test view: the sheets main has in a tab's page, and whether the preload's are still there. */
  info(tabId: TabId): { host: string | null; preloaded: boolean; parts: string[]; scripted: boolean } | null
}

/**
 * Applies Tweaks to pages (BO-18; D40, D85):
 * - before first paint, the page preload asks main for its sheets (`PAGE_CHANNEL.tweakSheets`, a
 *   sync message that carries nothing): main answers from the frame's own URL, for a main frame,
 *   with the sheets and a number for this document's read; the preload inserts them as injected
 *   author sheets, which the page can't see or remove;
 * - at document ready, or at the first change before it, main puts its own copies in (`insertCSS`)
 *   and tells the preload to take its sheets out (`PAGE_CHANNEL.tweakRetire`, with that number):
 *   a message to the page's main frame that main never waits for. At document ready main also runs
 *   the JavaScript Tweaks allowed here in the page's main world (`executeJavaScript` on its main
 *   frame, never through the preload);
 * - while the page is open, each change to its Tweaks replaces only the sheets that changed:
 *   the new one goes in before the old one comes out, so nothing flashes. A change waits only on
 *   `insertCSS`, never on a script in the page or an isolated world, so it shows while the page is
 *   still loading.
 */
export function registerTweakPages(ctx: MainContext): TweakPages {
  const { store, sessions, tabs } = ctx
  const records = new Map<number, PageRecord>()
  /** Waiting for a page to become tweakable (`whenTweakable`): each checks its tab as a page asks. */
  const waiting = new Set<() => void>()
  const profiles = new WeakMap<Session, ProfileId>()
  sessions.onSessionCreated((ses, profileId) => profiles.set(ses, profileId))

  const profileOf = (contents: WebContents): ProfileId | undefined => {
    const tabId = tabs.tabIdFor(contents)
    return (tabId ? store.state.tabs[tabId]?.profileId : undefined) ?? profiles.get(contents.session)
  }

  /** The record still describes the page on screen: no other document has come since it asked. */
  const current = (record: PageRecord): boolean =>
    !!record.host && !record.contents.isDestroyed() && record.contents.getURL() === record.url

  const sheetOptions = (record: PageRecord): SheetOptions => ({ showHidden: record.showHidden })

  const partsFor = (state: OrbitState, record: PageRecord): SheetPart[] =>
    tweakSheets(enabledTweaksFor(state.tweaks, state.settings, record.host), sheetOptions(record))

  const remove = (contents: WebContents, key: string) => {
    if (!contents.isDestroyed()) contents.removeInsertedCSS(key).catch(() => {})
  }

  const insert = async (record: PageRecord, doc: number, part: SheetPart): Promise<void> => {
    const { contents } = record
    let key: string
    try {
      key = await contents.insertCSS(part.css, { cssOrigin: 'author' })
    } catch {
      return
    }
    // A later document came meanwhile: the sheet may have landed in it.
    if (record.doc !== doc) {
      remove(contents, key)
      return
    }
    const old = record.inserted.get(part.key)
    record.inserted.set(part.key, { key, css: part.css })
    if (old) remove(contents, old.key)
  }

  /**
   * The preload takes out its first-paint sheets (D85): a message to the page's main frame that
   * carries only the number of the document's read, and that main never waits for.
   */
  const retire = (record: PageRecord, doc: number) => {
    try {
      record.contents.mainFrame.send(PAGE_CHANNEL.tweakRetire, doc)
    } catch {
      // The frame went, and the document's sheets with it.
    }
  }

  /** Brings a page's sheets in line with its Tweaks now. */
  const syncOnce = async (record: PageRecord): Promise<void> => {
    if (!current(record)) return
    const doc = record.doc
    const want = partsFor(store.state, record)
    const keys = new Set(want.map((p) => p.key))
    await Promise.all(want.filter((p) => record.inserted.get(p.key)?.css !== p.css).map((p) => insert(record, doc, p)))
    if (record.doc !== doc || record.contents.isDestroyed()) return
    for (const [part, have] of record.inserted) {
      if (keys.has(part)) continue
      record.inserted.delete(part)
      remove(record.contents, have.key)
    }
    // Main's own sheets are all in: the preload's go.
    if (record.preloaded && want.every((p) => record.inserted.get(p.key)?.css === p.css)) {
      record.preloaded = false
      retire(record, doc)
    }
  }

  /** One pass at a time per page; changes that come meanwhile make one more. */
  const sync = async (record: PageRecord): Promise<void> => {
    if (record.busy) {
      record.again = true
      return
    }
    record.busy = true
    try {
      do {
        record.again = false
        await syncOnce(record)
      } while (record.again)
    } catch (err) {
      console.error('[tweaks] page sheets', err)
    } finally {
      record.busy = false
    }
  }

  /**
   * A Tweak's JavaScript may run in a page: it has some, the user allowed it on this device, and
   * in a private window allowed it there too (BO-11, BO-17, BO-18).
   */
  const mayRun = (record: PageRecord, tweak: Tweak): boolean =>
    !!tweak.js.trim() && tweak.jsAllowed && (tweak.jsInPrivate || !isPrivateProfileId(profileOf(record.contents)))

  /** Runs the JavaScript of a page's Tweaks once per load, where allowed (BO-11, BO-17, BO-18). */
  const runScripts = (record: PageRecord) => {
    if (record.scripted || !current(record)) return
    record.scripted = true
    const state = store.state
    for (const tweak of enabledTweaksFor(state.tweaks, state.settings, record.host)) {
      if (!mayRun(record, tweak)) continue
      // A script error goes to the page's console; a rejection here is only that (D28).
      record.contents.mainFrame.executeJavaScript(tweakScript(tweak)).catch(() => {})
    }
  }

  const track = (contents: WebContents): PageRecord => {
    const record: PageRecord = {
      contents,
      url: '',
      host: null,
      doc: 0,
      preloaded: false,
      inserted: new Map(),
      scripted: false,
      busy: false,
      again: false,
    }
    records.set(contents.id, record)
    const id = contents.id
    contents.on('dom-ready', () => {
      if (!current(record)) return
      void sync(record)
      runScripts(record)
    })
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      // Same document, same origin: the page keeps its sheets (BO-17: in-page navigations).
      if (isMainFrame && record.host && tweakHostOf(url) === record.host) record.url = url
    })
    // An error page took the page's place, or the page crashed: no Tweak goes there, until a page
    // asks again (a stopped or replaced navigation leaves the page as it was).
    contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== ERR_ABORTED) record.host = null
    })
    contents.on('render-process-gone', () => {
      record.host = null
    })
    contents.once('destroyed', () => records.delete(id))
    return record
  }

  ipcMain.on(PAGE_CHANNEL.tweakSheets, (event: IpcMainEvent) => {
    let sheets: TweakSheetsAnswer | null = null
    try {
      sheets = answer(event)
    } catch (err) {
      console.error('[tweaks] page ask', err)
    }
    event.returnValue = sheets
  })

  /**
   * The page preload's ask, before the page's first paint: the sheets, from the frame's own URL, and
   * the number of this document's read; null where none apply.
   */
  const answer = (event: IpcMainEvent): TweakSheetsAnswer | null => {
    const contents = event.sender
    const frame = event.senderFrame
    const main = contents.mainFrame
    if (!frame || frame.detached || frame.processId !== main.processId || frame.routingId !== main.routingId)
      return null
    // Only pages of a profile's session: never Orbit's own views.
    if (!profiles.has(contents.session)) return null
    const url = frame.url
    const host = tweakHostOf(url)
    let record = records.get(contents.id)
    if (!host && !record) return null
    record ??= track(contents)
    record.doc++
    record.url = url
    record.host = host
    record.inserted.clear()
    record.preloaded = false
    record.scripted = false
    record.showHidden = undefined
    if (!host) return null
    // After the answer: the page paints first.
    if (waiting.size > 0) {
      setImmediate(() => {
        for (const check of [...waiting]) check()
      })
    }
    const parts = partsFor(store.state, record)
    if (parts.length === 0) return null
    record.preloaded = true
    return { doc: record.doc, sheets: parts.map((p) => p.css) }
  }

  // A change to the Tweaks, or the switch for all of them (BO-14, BO-16): open pages follow at once.
  store.subscribe((next, prev) => {
    if (next.tweaks === prev.tweaks && next.settings.tweaksEnabled === prev.settings.tweaksEnabled) return
    for (const record of records.values()) {
      if (!record.host) continue
      const before = enabledTweaksFor(prev.tweaks, prev.settings, record.host)
      const after = enabledTweaksFor(next.tweaks, next.settings, record.host)
      if (before.length === 0 && after.length === 0) continue
      void sync(record)
    }
  })

  const recordOf = (tabId: TabId): PageRecord | undefined => {
    const contents = tabs.contents(tabId)
    const record = contents ? records.get(contents.id) : undefined
    return record && current(record) ? record : undefined
  }

  return {
    tweakable: (tabId) => !!recordOf(tabId),
    hostOf: (tabId) => recordOf(tabId)?.host ?? null,
    whenTweakable: (tabId, ms) =>
      new Promise<boolean>((resolve) => {
        if (recordOf(tabId)) {
          resolve(true)
          return
        }
        const finish = (ok: boolean) => {
          waiting.delete(check)
          clearTimeout(timer)
          resolve(ok)
        }
        const check = () => {
          if (recordOf(tabId)) finish(true)
        }
        const timer = setTimeout(() => finish(false), ms)
        waiting.add(check)
      }),
    runNow: (tabId, tweakId) => {
      const record = recordOf(tabId)
      const state = store.state
      const tweak = record && enabledTweaksFor(state.tweaks, state.settings, record.host).find((t) => t.id === tweakId)
      if (!record || !tweak || !mayRun(record, tweak)) return false
      record.contents.mainFrame.executeJavaScript(tweakScript(tweak)).catch(() => {})
      return true
    },
    setShowHidden: (tabId, hiddenId) => {
      const record = recordOf(tabId)
      if (!record || record.showHidden === hiddenId) return
      record.showHidden = hiddenId
      void sync(record)
    },
    info: (tabId) => {
      const contents = tabs.contents(tabId)
      const record = contents ? records.get(contents.id) : undefined
      if (!record) return null
      return {
        host: current(record) ? record.host : null,
        preloaded: record.preloaded,
        parts: [...record.inserted.keys()],
        scripted: record.scripted,
      }
    },
  }
}
