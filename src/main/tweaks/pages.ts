import { type IpcMainEvent, ipcMain, type Session, type WebContents } from 'electron'
import { isPrivateProfileId } from '../../shared/private'
import { PAGE_CHANNEL } from '../../shared/site'
import type { OrbitState, ProfileId, TabId } from '../../shared/state'
import { enabledTweaksFor, type SheetOptions, type SheetPart, tweakHostOf, tweakScript, tweakSheets } from '../../shared/tweaks'
import type { MainContext } from '../context'

/** The isolated world main's own scripts for Tweaks run in (never the page's world). */
export const TWEAK_WORLD = 1040

/**
 * Takes the page preload's Tweak sheets out of the page (they carry the marker media type).
 * Runs in TWEAK_WORLD: the page's own adopted sheets stay as they are.
 */
const RETIRE_PRELOAD_SHEETS = `(() => {
  const list = document.adoptedStyleSheets
  const kept = list.filter((sheet) => !Array.from(sheet.media).includes('orbit-tweaks'))
  if (kept.length !== list.length) document.adoptedStyleSheets = kept
})()`

/** What main knows of a page that may have Tweaks: one per web contents whose preload asked. */
interface PageRecord {
  contents: WebContents
  /** The page's URL when its preload asked (BO-18), followed through in-page navigations. */
  url: string
  /** Its host; null once it shows something Tweaks don't reach. */
  host: string | null
  /** Bumped by each new document. */
  doc: number
  /** The preload's sheets are in the page, not yet replaced by main's own. */
  adopted: boolean
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
  /** Runs a Tweak's JavaScript in a tab's page now (BO-11's "Run now"); false where it may not run. */
  runNow(tabId: TabId, tweakId: string): boolean
  /** Shows one hidden element again for now, or none (BO-10's restore marker preview). */
  setShowHidden(tabId: TabId, hiddenId: string | undefined): void
  /** Test view: the sheets main has in a tab's page, and whether the preload's are still there. */
  info(tabId: TabId): { host: string | null; adopted: boolean; parts: string[]; scripted: boolean } | null
}

/**
 * Applies Tweaks to pages (BO-18, D40):
 * - before first paint, the page preload asks main for its sheets (`PAGE_CHANNEL.tweakSheets`, a
 *   sync message that carries nothing): main answers from the frame's own URL, for a main frame;
 * - at document ready, main puts its own copies in (`insertCSS`, which the page can't see or
 *   remove), takes the preload's out, and runs the JavaScript Tweaks allowed here in the page's
 *   main world (`executeJavaScript` on its main frame, never through the preload);
 * - while the page is open, each change to its Tweaks replaces only the sheets that changed:
 *   the new one goes in before the old one comes out, so nothing flashes.
 */
export function registerTweakPages(ctx: MainContext): TweakPages {
  const { store, sessions, tabs } = ctx
  const records = new Map<number, PageRecord>()
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
    if (record.adopted) {
      // Main's own sheets are in: the preload's go.
      record.adopted = false
      await record.contents.executeJavaScriptInIsolatedWorld(TWEAK_WORLD, [{ code: RETIRE_PRELOAD_SHEETS }]).catch(() => {})
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

  /** Runs the JavaScript of a page's Tweaks once per load, where allowed (BO-11, BO-17, BO-18). */
  const runScripts = (record: PageRecord) => {
    if (record.scripted || !current(record)) return
    record.scripted = true
    const state = store.state
    const inPrivate = isPrivateProfileId(profileOf(record.contents))
    for (const tweak of enabledTweaksFor(state.tweaks, state.settings, record.host)) {
      if (!tweak.js.trim() || !tweak.jsAllowed || (inPrivate && !tweak.jsInPrivate)) continue
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
      adopted: false,
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
    contents.once('destroyed', () => records.delete(id))
    return record
  }

  ipcMain.on(PAGE_CHANNEL.tweakSheets, (event: IpcMainEvent) => {
    let sheets: string[] = []
    try {
      sheets = answer(event)
    } catch (err) {
      console.error('[tweaks] page ask', err)
    }
    event.returnValue = sheets
  })

  /** The page preload's ask, before the page's first paint: the sheets, from the frame's own URL. */
  const answer = (event: IpcMainEvent): string[] => {
    const contents = event.sender
    const frame = event.senderFrame
    const main = contents.mainFrame
    if (!frame || frame.detached || frame.processId !== main.processId || frame.routingId !== main.routingId) return []
    // Only pages of a profile's session: never Orbit's own views.
    if (!profiles.has(contents.session)) return []
    const url = frame.url
    const host = tweakHostOf(url)
    let record = records.get(contents.id)
    if (!host && !record) return []
    record ??= track(contents)
    record.doc++
    record.url = url
    record.host = host
    record.inserted.clear()
    record.adopted = false
    record.scripted = false
    record.showHidden = undefined
    if (!host) return []
    const parts = partsFor(store.state, record)
    record.adopted = parts.length > 0
    return parts.map((p) => p.css)
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
    runNow: (tabId, tweakId) => {
      const record = recordOf(tabId)
      const tweak = store.state.tweaks[tweakId]
      if (!record || !tweak || !tweak.js.trim() || !tweak.jsAllowed) return false
      if (isPrivateProfileId(profileOf(record.contents)) && !tweak.jsInPrivate) return false
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
        adopted: record.adopted,
        parts: [...record.inserted.keys()],
        scripted: record.scripted,
      }
    },
  }
}
