import { randomBytes } from 'node:crypto'
import type { WebContents, WebFrameMain } from 'electron'
import type { TabId } from '../../shared/state'

/**
 * Which tabs share a screen or window (getDisplayMedia; MD-11, TB-15: their sharing indicators say
 * so). Electron doesn't say when a page's capture ends, so two sources follow the shares, and an
 * indicator shows while either says one is live (D69):
 * - main's own watcher. Orbit's screen chooser grants a frame's share (the tab's own page or a frame
 *   in it), and each grant counts one. Just before the frame has the stream, a script goes in the
 *   frame's own world (webFrameMain, as media's agent does in frames, D40, D67): it counts the
 *   shared tracks the page stops and the clones it makes, and the tracks whose source ends among
 *   those the page takes. If the capture then fails, or the page drops a stream without stopping
 *   it, this says the frame shares until it loads another page;
 * - the page preload's count of the tab's own page's live shared tracks (src/preload/page.ts). It
 *   also sees the shares the system's own picker grants without asking Orbit (macOS 15 and later).
 *   It's the page's word, so it only ever lights that tab's indicators: nothing that grants,
 *   refuses, sleeps or archives anything reads it (`sharingGranted` leaves it out).
 * A document that goes away takes its shares with it. Neither source holds against a page that
 * wants to hide its share (it can clone a track with another realm's built-ins, such as a
 * same-origin frame's, and stop the one Orbit follows): the system's own capture indicator is the
 * backstop where there is one.
 */

/** A frame's script answers at least this often, so a removed frame is noticed. */
const SHARE_WAIT_MS = 10_000
/** A frame's script that doesn't answer in this much longer is gone, or stuck. */
const SHARE_SLACK_MS = 5_000
/** Putting the script in place holds the frame's stream back this long at most. */
const INSTALL_MS = 1_000
/** Main asks a script at most this often, whatever the page does to its timers. */
const ASK_GAP_MS = 250
/** The page preload's count is clamped to this (it only ever lights an indicator). */
export const MAX_PAGE_SHARES = 1_000

/** A frame's document that was granted a share. */
interface Doc {
  frame: WebFrameMain
  /** The tab's own page, not a frame in it. */
  main: boolean
  /** Its script's property: random for each document, so a page can't have one ready. */
  key: string
  /** Shares granted. */
  grants: number
  /** From its script: clones of shared tracks made, less shared tracks ended. */
  delta: number
  v: number
  ready?: Promise<boolean>
}

interface TabShares {
  contents: WebContents
  /** The live shared tracks of the tab's own page, as its preload counts them. */
  page: number
  /** Documents granted a share in Orbit's chooser, by frame tree node id. */
  frames: Map<number, Doc>
}

const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && Math.abs(x) < 1e6

/** The frame still holds a document, as far as the main process can tell. */
function alive(frame: WebFrameMain): boolean {
  try {
    return !frame.isDestroyed() && !frame.detached
  } catch {
    return false
  }
}

export class ScreenShares {
  private tabs = new Map<TabId, TabShares>()

  /** `changed`: a tab's sharing may have started or stopped. */
  constructor(private changed: (tabId: TabId) => void) {}

  /** The tab shares a screen or window now, as either source says: its sharing indicators show. */
  sharing(tabId: TabId): boolean {
    return (this.tabs.get(tabId)?.page ?? 0) > 0 || this.sharingGranted(tabId)
  }

  /**
   * A share Orbit's chooser granted is live, as main's watcher says. The only one of the two that
   * keeps a tab awake and unarchived (D69).
   */
  sharingGranted(tabId: TabId): boolean {
    const t = this.tabs.get(tabId)
    if (!t) return false
    for (const d of t.frames.values()) if (d.grants + d.delta > 0) return true
    return false
  }

  /**
   * What is counted for a tab (tests and diagnostics): its own page's live shared tracks as its
   * preload says (`page`), and main's watcher's count for its own page (`main`) and for each frame.
   */
  counts(tabId: TabId): { page: number; main: number; frames: number[] } {
    const t = this.tabs.get(tabId)
    const docs = [...(t?.frames.values() ?? [])]
    const count = (d: Doc) => d.grants + d.delta
    return {
      page: t?.page ?? 0,
      main: docs.filter((d) => d.main).reduce((sum, d) => sum + count(d), 0),
      frames: docs.filter((d) => !d.main).map(count),
    }
  }

  private tab(tabId: TabId, contents: WebContents): TabShares {
    let t = this.tabs.get(tabId)
    if (!t || t.contents !== contents) {
      t = { contents, page: 0, frames: new Map() }
      this.tabs.set(tabId, t)
    }
    return t
  }

  /**
   * The page preload's count for the tab's own page (D69): any number is clamped to
   * 0…MAX_PAGE_SHARES; anything else is ignored.
   */
  pageCount(tabId: TabId, contents: WebContents, count: unknown): void {
    if (typeof count !== 'number' || Number.isNaN(count)) return
    const n = Math.min(Math.max(Math.trunc(count), 0), MAX_PAGE_SHARES)
    const t = this.tab(tabId, contents)
    if (t.page === n) return
    t.page = n
    this.changed(tabId)
  }

  /**
   * A frame of the tab (its main frame or another) is about to get a shared screen (Orbit's chooser
   * granted it): its script goes in first. Resolves when the stream may go to the frame.
   */
  async grant(tabId: TabId, contents: WebContents, frame: WebFrameMain): Promise<void> {
    let node: number
    let main: boolean
    try {
      node = frame.frameTreeNodeId
      main = !frame.parent
    } catch {
      return
    }
    const t = this.tab(tabId, contents)
    let doc = t.frames.get(node)
    if (doc && doc.frame !== frame) doc = undefined
    if (!doc) {
      doc = { frame, main, key: `_${randomBytes(8).toString('hex')}`, grants: 0, delta: 0, v: 0 }
      t.frames.set(node, doc)
    }
    doc.grants++
    this.changed(tabId)
    doc.ready ??= this.install(tabId, t, node, doc)
    await doc.ready
  }

  /** A frame loaded another document: its shares ended with the old one. */
  frameGone(tabId: TabId, contents: WebContents, node: number): void {
    const t = this.tabs.get(tabId)
    if (!t || t.contents !== contents || !t.frames.delete(node)) return
    this.changed(tabId)
  }

  /** The tab's page loaded another document, or the tab went away: every share ended. */
  tabGone(tabId: TabId, contents: WebContents): void {
    const t = this.tabs.get(tabId)
    if (!t || t.contents !== contents) return
    const was = this.sharing(tabId)
    this.tabs.delete(tabId)
    if (was) this.changed(tabId)
  }

  private holds(tabId: TabId, t: TabShares, node: number, doc: Doc): boolean {
    return this.tabs.get(tabId) === t && t.frames.get(node) === doc
  }

  private async install(tabId: TabId, t: TabShares, node: number, doc: Doc): Promise<boolean> {
    const ok = (await this.run(doc, frameShareSource(doc.key), INSTALL_MS)) === true
    // Without its script, the document's shares last as long as it does.
    if (ok) void this.follow(tabId, t, node, doc)
    return ok
  }

  private async follow(tabId: TabId, t: TabShares, node: number, doc: Doc): Promise<void> {
    const handle = `window[${JSON.stringify(doc.key)}]`
    let asked = 0
    while (this.holds(tabId, t, node, doc)) {
      const gap = asked + ASK_GAP_MS - Date.now()
      if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap))
      if (!this.holds(tabId, t, node, doc)) return
      asked = Date.now()
      const code = `${handle} ? ${handle}.next(${doc.v}) : null`
      const answer = (await this.run(doc, code, SHARE_WAIT_MS + SHARE_SLACK_MS)) as
        | { v?: unknown; delta?: unknown }
        | null
        | undefined
      if (!this.holds(tabId, t, node, doc)) return
      if (answer && isCount(answer.v) && isCount(answer.delta)) {
        if (answer.v === doc.v) continue
        doc.v = answer.v
        doc.delta = answer.delta
        this.changed(tabId)
        continue
      }
      // The frame was removed: its shares went with it.
      if (!alive(doc.frame)) {
        t.frames.delete(node)
        this.changed(tabId)
        return
      }
      // No script answers (the page broke what it relies on): keep the grants, as without one.
      if (answer === null) return
    }
  }

  /** Runs code in a frame's own world; undefined when it failed, went away or took too long. */
  private async run(doc: Doc, code: string, ms: number): Promise<unknown> {
    if (!alive(doc.frame)) return undefined
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        doc.frame.executeJavaScript(code),
        new Promise((resolve) => {
          timer = setTimeout(resolve, ms)
        }),
      ])
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * A frame's screen-share script (see ScreenShares), in the frame's own world. Built-ins are taken
 * when it starts; its property can't be replaced. `next(v)` answers once its count changed from
 * version `v`, or after SHARE_WAIT_MS anyway.
 */
export function frameShareSource(key: string): string {
  return `(() => {
  const key = ${JSON.stringify(key)}
  if (window[key]) return true
  const Track = window.MediaStreamTrack
  const Stream = window.MediaStream
  if (typeof Track !== 'function' || typeof Stream !== 'function') return false
  const apply = Reflect.apply
  const define = Object.defineProperty
  const describe = Object.getOwnPropertyDescriptor
  const freeze = Object.freeze
  const listen = EventTarget.prototype.addEventListener
  const later = window.setTimeout
  const Seen = WeakSet
  const add = Seen.prototype.add
  const has = Seen.prototype.has
  const kind = describe(Track.prototype, 'kind')
  const state = describe(Track.prototype, 'readyState')
  const settings = describe(Track.prototype, 'getSettings')
  const stop = describe(Track.prototype, 'stop')
  const clone = describe(Track.prototype, 'clone')
  if (!kind || !kind.get || !state || !state.get || !settings || typeof settings.value !== 'function') return false
  if (!stop || typeof stop.value !== 'function' || !clone || typeof clone.value !== 'function') return false
  const watched = new Seen()
  const ended = new Seen()
  let delta = 0
  let version = 0
  let wake = null
  const changed = (d) => {
    delta += d
    version++
    if (wake) {
      const w = wake
      wake = null
      w()
    }
  }
  const live = (t) => {
    try {
      return apply(state.get, t, []) === 'live'
    } catch {
      return false
    }
  }
  // A shared screen's video: its settings say what kind of surface it shows.
  const shared = (t) => {
    try {
      if (apply(kind.get, t, []) !== 'video') return false
      const own = describe(apply(settings.value, t, []), 'displaySurface')
      return !!own && typeof own.value === 'string'
    } catch {
      return false
    }
  }
  const end = (t) => {
    if (apply(has, ended, [t])) return
    apply(add, ended, [t])
    changed(-1)
  }
  const watch = (t) => {
    if (apply(has, watched, [t])) return
    apply(add, watched, [t])
    apply(listen, t, ['ended', () => {
      if (!live(t)) end(t)
    }])
  }
  const methods = {
    stop() {
      const counted = shared(this) && live(this)
      const result = apply(stop.value, this, [])
      if (counted) end(this)
      return result
    },
    clone() {
      const copy = apply(clone.value, this, [])
      if (shared(copy) && live(copy)) {
        changed(1)
        watch(copy)
      }
      return copy
    },
    getTracks() {
      return seen(apply(tracks.getTracks, this, []))
    },
    getVideoTracks() {
      return seen(apply(tracks.getVideoTracks, this, []))
    },
  }
  // The page's stream hands out its tracks: the shared ones are watched for their source ending.
  const tracks = {}
  const seen = (list) => {
    for (let i = 0; i < list.length; i++) if (shared(list[i]) && live(list[i])) watch(list[i])
    return list
  }
  const names = ['getTracks', 'getVideoTracks']
  for (let i = 0; i < names.length; i++) {
    const d = describe(Stream.prototype, names[i])
    if (!d || typeof d.value !== 'function') continue
    tracks[names[i]] = d.value
    define(Stream.prototype, names[i], { ...d, value: methods[names[i]] })
  }
  define(Track.prototype, 'stop', { ...stop, value: methods.stop })
  define(Track.prototype, 'clone', { ...clone, value: methods.clone })
  const next = async (v) => {
    if (typeof v === 'number' && version <= v) {
      await {
        then: (resolve) => {
          wake = resolve
          later(() => {
            if (wake !== resolve) return
            wake = null
            resolve()
          }, ${SHARE_WAIT_MS})
        },
      }
    }
    return { v: version, delta }
  }
  define(window, key, { value: freeze({ next }) })
  return true
})()`
}
