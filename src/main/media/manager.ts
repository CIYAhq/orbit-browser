/**
 * Media in the main process (media lane): picture-in-picture, the sidebar media tray and call
 * controls. Event driven, no polling:
 * - a tab gets Orbit's page script (agent.ts) only once it plays media (`media-started-playing`,
 *   or it turns audible); the script reports changes through a long-poll;
 * - so do the tab's frames that have media elements (embedded players, MD-01, MD-09), found
 *   through the frame tree. A frame's script runs in the frame's own world (frames get no preload,
 *   D40), so its reports are checked like anything else from a page (parseSnapshot, D67). The
 *   tab's media is all of its documents' reports together (combineSnapshots);
 * - tab switches arrive as store changes: a tab leaving the screen with a playing video goes to
 *   Orbit's floating player (player.ts, MD-01), and coming back ends it. A video in a frame goes
 *   through each frame on the way (`Chain`);
 * - each tab's `media` record (shared/state.ts) holds what the sidebar and the player need, and
 *   `tray` says whether its controller shows (shared/media.ts settleTray);
 * - a tab sharing a screen or window says so too (`screen`, MD-11; screen-share.ts).
 *
 * The engine's own picture-in-picture window is still used while the tab stays on screen (the
 * page's own PiP button, "Picture in Picture" on the selected tab): Orbit's player borrows the
 * tab's view, which can't show in two places at once. Leaving the tab hands such a video over to
 * Orbit's player.
 */
import { randomBytes } from 'node:crypto'
import { type MenuItemConstructorOptions, type WebContents, type WebFrameMain, webFrameMain } from 'electron'
import {
  type AgentSnapshot,
  applySitePip,
  combineSnapshots,
  emptyMedia,
  type MediaAction,
  mediaFromSnapshot,
  type PipEndReason,
  parseSnapshot,
  type SitePipMode,
  sameMedia,
  settleTray,
  shouldAutoPip,
  siteOf,
  sitePipMode,
} from '../../shared/media'
import type { Rect } from '../../shared/rpc'
import type { OrbitState, TabId, TabMedia, WindowId } from '../../shared/state'
import { sectionOf } from '../../shared/tree'
import type { MainContext } from '../context'
import { displayedTabs } from '../tabs/model'
import { AGENT_SOURCE, frameAgentSource, MEDIA_WORLD } from './agent'
import { loadArtwork } from './artwork'
import { PipPlayer } from './player'
import { ScreenShares } from './screen-share'

/** One document's page script: the tab's own page, or one of its frames. */
interface Agent {
  /** The frame's tree node id; -1 for the tab's own page. */
  node: number
  /** The frame, for a frame's script. */
  frame?: WebFrameMain
  run: (code: string, gesture: boolean) => Promise<unknown>
  /** The last report. */
  snap?: AgentSnapshot
  /** The last picture-in-picture ending already handled (reports repeat it). */
  pipEndSeen: number
  /**
   * Orbit opened the engine's picture-in-picture in this document (the controller, the page menu):
   * the next ending reported is that one's, and may bring the tab's window forward (D71).
   */
  orbitPip?: boolean
  /** A long-poll is running for this document. */
  looping: boolean
  /** Settles once the document is gone: a call into a frame that went away never answers. */
  gone: Promise<undefined>
  leave: () => void
}

/** A tab's page scripts. */
interface TabAgents {
  contents: WebContents
  page?: Agent
  /** Its frames' scripts, by frame tree node id. */
  frames: Map<number, Agent>
  /** Frames being given a script now. */
  pending: Map<number, Promise<Agent | undefined>>
  /** Navigations seen per frame: a script installed across one is in the old document. */
  navs: Map<number, number>
}

/**
 * The documents a video in Orbit's player is reached through: the tab's page, the frames on the
 * way and the video's own document last; with each one's index among its parent's frames.
 */
interface Chain {
  agents: Agent[]
  idx: number[]
}

interface ProbeAnswer {
  ok: boolean
  aspect?: number
  rect?: Rect | null
}

/** The frame scripts' property: random for each run of Orbit, so a page can't expect it. */
const FRAME_KEY = `_${randomBytes(8).toString('hex')}`
const PAGE_HANDLE = 'window.__orbitMedia'
const FRAME_HANDLE = `window[${JSON.stringify(FRAME_KEY)}]`
/** A frame that doesn't answer in this long has gone, or is stuck. */
const FRAME_CALL_MS = 5000
/** Loaded artwork kept for this many images. */
const MAX_ARTWORK = 64

const call = (handle: string, fn: string, args: unknown[]) =>
  `${handle} ? ${handle}.${fn}(${args.map((a) => JSON.stringify(a ?? null)).join(', ')}) : null`

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

/** The frame still holds a document, as far as the main process can tell. */
function alive(frame: WebFrameMain): boolean {
  try {
    return !frame.isDestroyed() && !frame.detached
  } catch {
    return false
  }
}

function newAgent(node: number, frame: WebFrameMain | undefined, run: Agent['run']): Agent {
  let leave = () => {}
  const gone = new Promise<undefined>((resolve) => {
    leave = () => resolve(undefined)
  })
  return { node, frame, run, pipEndSeen: 0, looping: true, gone, leave }
}

function cleanRect(r: unknown): Rect | null {
  const x = r as Rect | null | undefined
  if (!x || !isNum(x.x) || !isNum(x.y) || !isNum(x.width) || !isNum(x.height)) return null
  return x.width > 0 && x.height > 0 ? { x: x.x, y: x.y, width: x.width, height: x.height } : null
}

export class MediaManager {
  private tabs = new Map<TabId, TabAgents>()
  /** The way to the video each tab has (or is about to have) in the player, set by its probe. */
  private chains = new Map<TabId, Chain>()
  /** Tabs on screen in any window at the last state change. */
  private shown = new Set<TabId>()
  /** The artwork each tab's page names (profile and URL), and the images loaded for those (MD-09). */
  private artWanted = new Map<TabId, string>()
  private artLoaded = new Map<string, string>()
  /** Last menu template (tests read it instead of a native popup). */
  lastMenu: MenuItemConstructorOptions[] = []
  readonly player: PipPlayer
  /** Tabs sharing a screen or window (MD-11). */
  readonly screens = new ScreenShares((tabId) => this.showScreen(tabId))

  constructor(
    private ctx: MainContext,
    private now: () => number = Date.now,
  ) {
    this.player = new PipPlayer(ctx, {
      call: (tabId, fn, ...args) => this.playerCall(tabId, fn, args),
      changed: (tabId, open, auto) => this.markPip(tabId, open, open, auto),
      focusTab: (tabId, windowId) => this.focusTab(tabId, windowId),
      turnOffForSite: (tabId, mode) => {
        const url = this.ctx.store.state.tabs[tabId]?.url
        if (url) this.setSitePip(url, mode)
        // Turning PiP off never stops playback: the media shows in the sidebar instead (MD-08).
        this.player.closeFor(tabId, 'off')
      },
    })
  }

  start(): void {
    this.shown = displayedTabs(this.ctx.store.state)
    this.ctx.hooks.tabCreated.push((tabId, contents) => this.watch(tabId, contents))
    this.ctx.store.subscribe((next, prev) => this.onState(next, prev))
  }

  /** The tab's media as its page scripts last reported it, all documents together (tests and diagnostics). */
  snapshot(tabId: TabId): AgentSnapshot | undefined {
    const t = this.tabs.get(tabId)
    return t ? combineSnapshots(this.reports(t)) : undefined
  }

  /** The tab's documents with a script: its own page first, then its frames. */
  private agentsOf(t: TabAgents): Agent[] {
    return t.page ? [t.page, ...t.frames.values()] : [...t.frames.values()]
  }

  private reports(t: TabAgents): AgentSnapshot[] {
    return this.agentsOf(t).flatMap((a) => (a.snap ? [a.snap] : []))
  }

  /** The document with the tab's main media (the same one combineSnapshots picks). */
  private best(t: TabAgents): Agent | undefined {
    let best: Agent | undefined
    for (const a of this.agentsOf(t)) if (!best || (a.snap?.score ?? 0) > (best.snap?.score ?? 0)) best = a
    return best
  }

  // ---- Page script lifecycle ----

  private watch(tabId: TabId, contents: WebContents): void {
    contents.on('media-started-playing', () => void this.install(tabId, contents))
    contents.on('audio-state-changed', (e) => {
      if (e.audible) void this.install(tabId, contents)
      // Media removed from the page pauses without an event the script can see: ask again.
      else this.recheck(tabId, contents, true)
    })
    // So does a frame removed with its media: its script can't say so any more.
    contents.on('media-paused', () => setImmediate(() => this.recheck(tabId, contents, false)))
    // A new document: its media (and picture-in-picture) went with the old one.
    contents.on('did-navigate', () => this.drop(tabId, contents, 'navigated'))
    contents.on('did-frame-navigate', (_e, _url, _code, _status, isMainFrame, pid, rid) => {
      if (!isMainFrame) this.frameNavigated(tabId, contents, pid, rid)
    })
    // A page's shared screen ends with its document (MD-11).
    contents.on('did-navigate', () => this.screens.tabGone(tabId, contents))
    contents.once('destroyed', () => this.screens.tabGone(tabId, contents))
    contents.once('destroyed', () => this.drop(tabId, contents, 'gone'))
  }

  /** The tab's scripts, for its current contents. */
  private tabAgents(tabId: TabId, contents: WebContents): TabAgents {
    const t = this.tabs.get(tabId)
    if (t?.contents === contents) return t
    if (t) for (const a of this.agentsOf(t)) a.leave()
    const fresh: TabAgents = { contents, frames: new Map(), pending: new Map(), navs: new Map() }
    this.tabs.set(tabId, fresh)
    return fresh
  }

  /** The agent is still the one for its document in this tab. */
  private holds(tabId: TabId, t: TabAgents, agent: Agent): boolean {
    if (this.tabs.get(tabId) !== t) return false
    return agent.node < 0 ? t.page === agent : t.frames.get(agent.node) === agent
  }

  /**
   * Installs the page script in a tab that plays media (once per document) and follows its
   * reports; its frames with media get theirs.
   */
  private async install(tabId: TabId, contents: WebContents): Promise<void> {
    const t = this.tabAgents(tabId, contents)
    void this.scan(tabId, t)
    if (t.page?.looping) return
    const agent = newAgent(-1, undefined, (code, gesture) =>
      contents.isDestroyed()
        ? Promise.resolve(null)
        : contents.executeJavaScriptInIsolatedWorld(MEDIA_WORLD, [{ code }], gesture),
    )
    t.page = agent
    const snap = parseSnapshot(await this.runIn(agent, AGENT_SOURCE, false, false))
    if (!this.holds(tabId, t, agent)) return
    if (!snap) {
      agent.looping = false
      return
    }
    this.apply(tabId, agent, snap)
    void this.follow(tabId, t, agent)
  }

  /** Gives each frame of the tab that has media elements a script of its own (MD-01, MD-09). */
  private async scan(tabId: TabId, t: TabAgents): Promise<void> {
    this.sweep(tabId, t)
    let frames: WebFrameMain[]
    try {
      frames = t.contents.mainFrame.framesInSubtree.filter((f) => f.parent !== null)
    } catch {
      return
    }
    await Promise.all(frames.map((f) => this.installFrame(tabId, t, f, true)))
  }

  /** A frame's script; `onlyMedia`: only if the frame has media elements. */
  private installFrame(
    tabId: TabId,
    t: TabAgents,
    frame: WebFrameMain,
    onlyMedia: boolean,
  ): Promise<Agent | undefined> {
    let node: number
    try {
      node = frame.frameTreeNodeId
    } catch {
      return Promise.resolve(undefined)
    }
    const have = t.frames.get(node)
    if (have) return Promise.resolve(have)
    const pending = t.pending.get(node)
    if (pending) return onlyMedia ? pending : pending.then((a) => a ?? this.installFrame(tabId, t, frame, false))
    const job = this.startFrame(tabId, t, frame, node, onlyMedia)
    t.pending.set(node, job)
    void job.then(() => {
      if (t.pending.get(node) === job) t.pending.delete(node)
    })
    return job
  }

  private async startFrame(
    tabId: TabId,
    t: TabAgents,
    frame: WebFrameMain,
    node: number,
    onlyMedia: boolean,
  ): Promise<Agent | undefined> {
    const nav = t.navs.get(node) ?? 0
    const agent = newAgent(node, frame, (code, gesture) => frame.executeJavaScript(code, gesture))
    const snap = parseSnapshot(await this.runIn(agent, frameAgentSource(FRAME_KEY, !onlyMedia), false, true))
    if (!snap || this.tabs.get(tabId) !== t || (t.navs.get(node) ?? 0) !== nav || !alive(frame)) return undefined
    const have = t.frames.get(node)
    if (have) return have
    t.frames.set(node, agent)
    this.apply(tabId, agent, snap)
    void this.follow(tabId, t, agent)
    return agent
  }

  private async follow(tabId: TabId, t: TabAgents, agent: Agent): Promise<void> {
    while (this.holds(tabId, t, agent) && !t.contents.isDestroyed()) {
      const handle = agent.frame ? FRAME_HANDLE : PAGE_HANDLE
      const snap = parseSnapshot(await this.runIn(agent, call(handle, 'next', [agent.snap?.v ?? 0]), false, false))
      if (!this.holds(tabId, t, agent)) return
      if (!snap) break
      this.apply(tabId, agent, snap)
    }
    if (!this.holds(tabId, t, agent)) return
    agent.looping = false
    // A frame's script that stopped answering went with its document.
    if (agent.frame) this.dropFrame(tabId, t, agent.node)
  }

  /**
   * Runs code in one document; undefined when it failed or the document went away, or (`timed`)
   * a frame didn't answer in time.
   */
  private async runIn(agent: Agent, code: string, gesture: boolean, timed: boolean): Promise<unknown> {
    if (agent.frame && !alive(agent.frame)) return undefined
    let timer: NodeJS.Timeout | undefined
    try {
      const waits: Promise<unknown>[] = [agent.run(code, gesture), agent.gone]
      if (timed && agent.frame) waits.push(new Promise((resolve) => (timer = setTimeout(resolve, FRAME_CALL_MS))))
      return await Promise.race(waits)
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  /** Calls a function of one document's script. */
  private exec<T>(agent: Agent, fn: string, args: unknown[] = [], gesture = false): Promise<T | undefined> {
    const code = call(agent.frame ? FRAME_HANDLE : PAGE_HANDLE, fn, args)
    return this.runIn(agent, code, gesture, true) as Promise<T | undefined>
  }

  /** Calls a function in every document of the tab that has a script. */
  private async each(tabId: TabId, fn: string, args: unknown[] = [], gesture = false): Promise<unknown[]> {
    const t = this.tabs.get(tabId)
    return t ? Promise.all(this.agentsOf(t).map((a) => this.exec(a, fn, args, gesture))) : []
  }

  /** Forgets a tab's media when its document or contents go away (MD-07, MD-12). */
  private drop(tabId: TabId, contents: WebContents, why: 'navigated' | 'gone'): void {
    const t = this.tabs.get(tabId)
    if (t && t.contents !== contents) return
    this.player.closeFor(tabId, why)
    if (t) for (const a of this.agentsOf(t)) a.leave()
    this.tabs.delete(tabId)
    this.chains.delete(tabId)
    this.artWanted.delete(tabId)
    this.ctx.store.update((d) => {
      const tab = d.tabs[tabId]
      if (tab?.media) delete tab.media
    })
  }

  /** A frame of the tab loaded a new document: its script, media and shares went with the old one. */
  private frameNavigated(tabId: TabId, contents: WebContents, pid: number, rid: number): void {
    let node: number | undefined
    try {
      node = webFrameMain.fromId(pid, rid)?.frameTreeNodeId
    } catch {}
    if (node !== undefined) this.screens.frameGone(tabId, contents, node)
    const t = this.tabs.get(tabId)
    if (!t || t.contents !== contents) return
    if (node !== undefined) {
      t.navs.set(node, (t.navs.get(node) ?? 0) + 1)
      this.dropFrame(tabId, t, node)
    }
    this.sweep(tabId, t)
  }

  /** Forgets a frame's script; a video of it in the player closes it (MD-07). */
  private dropFrame(tabId: TabId, t: TabAgents, node: number): void {
    const agent = t.frames.get(node)
    if (!agent) return
    t.frames.delete(node)
    agent.leave()
    if (this.chains.get(tabId)?.agents.includes(agent)) this.player.closeFor(tabId, 'gone')
    this.update(tabId, t)
  }

  /** Forgets the scripts of frames that were removed from the page. */
  private sweep(tabId: TabId, t: TabAgents): void {
    for (const [node, agent] of [...t.frames]) if (agent.frame && !alive(agent.frame)) this.dropFrame(tabId, t, node)
  }

  private recheck(tabId: TabId, contents: WebContents, ask: boolean): void {
    const t = this.tabs.get(tabId)
    if (!t || t.contents !== contents || contents.isDestroyed()) return
    this.sweep(tabId, t)
    if (ask) for (const a of this.agentsOf(t)) void this.exec(a, 'refresh')
  }

  /** Makes sure the tab has its page scripts (e.g. picture-in-picture for a video that never played). */
  watchTab(tabId: TabId): Promise<boolean> {
    return this.ensureAgent(tabId)
  }

  private async ensureAgent(tabId: TabId): Promise<boolean> {
    const contents = this.ctx.tabs.contents(tabId)
    if (!contents) return false
    const had = this.tabs.get(tabId)
    if (!(had?.contents === contents && had.page?.snap)) await this.install(tabId, contents)
    const t = this.tabs.get(tabId)
    if (!t) return false
    await this.scan(tabId, t)
    return this.reports(t).length > 0
  }

  // ---- State ----

  private apply(tabId: TabId, agent: Agent, snap: AgentSnapshot): void {
    const first = !agent.snap
    agent.snap = snap
    if (first) agent.pipEndSeen = snap.pipEnd?.n ?? 0
    else if (snap.pipEnd && snap.pipEnd.n > agent.pipEndSeen) {
      agent.pipEndSeen = snap.pipEnd.n
      this.onPipEnd(tabId, agent, snap.pipEnd.reason)
    }
    const t = this.tabs.get(tabId)
    if (t) this.update(tabId, t)
  }

  /** The tab's media record from all its documents' reports. */
  private update(tabId: TabId, t: TabAgents): void {
    const snap = combineSnapshots(this.reports(t))
    if (!snap) {
      this.patch(tabId, () => this.withScreen(tabId, undefined))
      return
    }
    // A video plays somewhere: get the player ready, so leaving its tab shows it at once (MD-01).
    if (snap.video) this.player.prewarm()
    const artwork = this.artwork(tabId, t, snap.artwork)
    this.patch(tabId, (prev) => {
      const next = mediaFromSnapshot(prev, snap)
      if (artwork) next.artwork = artwork
      else delete next.artwork
      this.withScreen(tabId, next)
      // Keep the "opened automatically" mark while the same picture-in-picture lasts.
      if (next.pip && prev?.autoPip) next.autoPip = true
      // Orbit's player decides whether it shows this tab (the page's report may lag behind).
      if (this.player.tabId === tabId) {
        next.pip = true
        next.player = true
      } else if (snap.player) {
        next.pip = false
        delete next.player
        delete next.autoPip
      }
      return next
    })
  }

  /**
   * The artwork image for the page's Media Session artwork, once loaded (the site icon shows until
   * then, and when it can't be loaded). A tab's own profile loads it, so private pages stay private.
   */
  private artwork(tabId: TabId, t: TabAgents, url: string): string | undefined {
    if (!url) {
      this.artWanted.delete(tabId)
      return undefined
    }
    const key = `${this.ctx.store.state.tabs[tabId]?.profileId ?? ''} ${url}`
    const loaded = this.artLoaded.get(key)
    if (loaded !== undefined || this.artWanted.get(tabId) === key) {
      this.artWanted.set(tabId, key)
      return loaded || undefined
    }
    if (t.contents.isDestroyed()) return undefined
    this.artWanted.set(tabId, key)
    void loadArtwork(t.contents.session, url).then((image) => {
      if (this.artLoaded.size >= MAX_ARTWORK) this.artLoaded.delete(this.artLoaded.keys().next().value as string)
      this.artLoaded.set(key, image ?? '')
      const now = this.tabs.get(tabId)
      if (image && now && this.artWanted.get(tabId) === key) this.update(tabId, now)
    })
    return undefined
  }

  /** A tab started or stopped sharing a screen or window: its row says so (MD-11, TB-15). */
  private showScreen(tabId: TabId): void {
    const t = this.tabs.get(tabId)
    if (t) {
      this.update(tabId, t)
      return
    }
    // Without page scripts, its record holds nothing else.
    this.patch(tabId, () => this.withScreen(tabId, undefined))
  }

  /**
   * `media` with the tab's sharing marks set (D69): `screen` while either source says it shares,
   * `screenGranted` only while a share Orbit's chooser granted is live. A record kept only for them
   * goes when they do. Changes `media` in place.
   */
  private withScreen(tabId: TabId, media: TabMedia | undefined): TabMedia | undefined {
    const screen = this.screens.sharing(tabId)
    const granted = this.screens.sharingGranted(tabId)
    if (!media) return screen ? { ...emptyMedia(), screen, ...(granted ? { screenGranted: true } : {}) } : undefined
    if (screen) media.screen = true
    else delete media.screen
    if (granted) media.screenGranted = true
    else delete media.screenGranted
    return media
  }

  /** Updates a tab's media record and settles its tray membership; writes only real changes. */
  private patch(tabId: TabId, fn: (prev: TabMedia | undefined) => TabMedia | undefined): void {
    const state = this.ctx.store.state
    const tab = state.tabs[tabId]
    if (!tab) return
    const changed = fn(tab.media ? { ...tab.media } : undefined)
    const settled = changed && settleTray(changed, tab, this.shown.has(tabId), this.now())
    if (sameMedia(tab.media, settled)) return
    this.ctx.store.update((d) => {
      const t = d.tabs[tabId]
      if (!t) return
      if (settled) t.media = settled
      else delete t.media
    })
  }

  private onState(next: OrbitState, prev: OrbitState): void {
    if (
      next.tabs === prev.tabs &&
      next.windows === prev.windows &&
      next.splits === prev.splits &&
      next.spaces === prev.spaces &&
      next.settings === prev.settings
    ) {
      return
    }
    // A closed or archived tab takes its player with it (MD-07, MD-12).
    const playerTab = this.player.tabId
    if (playerTab && !next.tabs[playerTab]) this.player.close('gone')
    const before = this.shown
    const shown = displayedTabs(next)
    this.shown = shown
    for (const id of shown) if (!before.has(id)) this.returned(id, next)
    for (const id of before) if (!shown.has(id) && next.tabs[id]) this.left(id, next)
    // Tray membership follows the screen, mute and audibility (MD-08, MD-09).
    const now = this.now()
    const updates: [TabId, TabMedia][] = []
    for (const id of this.tabs.keys()) {
      const tab = next.tabs[id]
      if (!tab?.media) continue
      let media = tab.media
      if (shown.has(id) && media.dismissed) media = { ...media, dismissed: undefined }
      const settled = settleTray(media, tab, shown.has(id), now)
      if (settled !== tab.media) updates.push([id, settled])
    }
    if (updates.length === 0) return
    this.ctx.store.update((d) => {
      for (const [id, media] of updates) {
        const t = d.tabs[id]
        if (!t?.media) continue
        if (media.dismissed === undefined) delete media.dismissed
        t.media = media
      }
    })
  }

  // ---- Picture-in-picture ----

  /** A tab left the screen: a playing video continues in the floating player (MD-01, MD-13). */
  private left(tabId: TabId, state: OrbitState): void {
    const t = this.tabs.get(tabId)
    const snap = t && combineSnapshots(this.reports(t))
    const tab = state.tabs[tabId]
    if (!t || !snap || !tab?.media || t.contents.isDestroyed()) return
    // The engine's own window (opened on the tab) hands its video over to Orbit's player, with
    // Orbit's controls. The user asked for it, so the automatic-PiP choices don't apply. The
    // tab's state knows first (the page's report of it may still be on its way).
    if ((snap.pip || tab.media.pip) && !snap.player && !tab.media.player) {
      void this.player.open(tabId, { auto: true, keep: true })
      return
    }
    // The page script checks again (the report may be a moment old): only a playing video goes.
    const candidate = snap.pipCandidate || snap.video
    if (!shouldAutoPip(state.settings, tab, candidate, this.now())) return
    void this.player.open(tabId, { auto: true, from: 'page' })
  }

  /** A tab came back on screen: its picture-in-picture ends and the video plays in the page (MD-01, MD-07). */
  private returned(tabId: TabId, state: OrbitState): void {
    if (this.player.tabId === tabId) {
      this.player.close('returned')
      return
    }
    if (state.tabs[tabId]?.media?.pip) void this.each(tabId, 'pip', [false, false])
  }

  private markPip(tabId: TabId, pip: boolean, player = false, auto = false): void {
    this.patch(tabId, (m) => {
      if (!m) return m
      const next = { ...m, pip }
      if (player) next.player = true
      else delete next.player
      if (pip && auto) next.autoPip = true
      else if (!pip) delete next.autoPip
      return next
    })
  }

  /** Picture-in-picture ended in a document of the tab (MD-04, MD-07). */
  private onPipEnd(tabId: TabId, agent: Agent, reason: PipEndReason): void {
    // Orbit's player: its video ended or left the page (or a frame on the way did).
    const chain = this.chains.get(tabId)
    if ((reason === 'ended' || reason === 'gone') && (!chain || chain.agents.includes(agent)))
      this.player.closeFor(tabId, reason)
    // Any ending uses up Orbit's own picture-in-picture in this document: one raise at most (D71).
    const ours = agent.orbitPip === true
    agent.orbitPip = false
    if (reason !== 'back') return
    // The engine window's "Back to tab": select the source tab in its window (and Space).
    const windowId = this.ctx.windows.windowOfTab(tabId) ?? this.ctx.windows.focusedWindowId()
    if (!windowId) return
    // A frame's script runs in the frame's own world, so its report may be the page's own words
    // (D67): unless Orbit opened that picture-in-picture, it only selects the tab where that
    // brings no window forward and switches no Space (D71).
    if (agent.frame && !ours) this.selectInFocused(tabId, windowId)
    else this.focusTab(tabId, windowId)
  }

  /** Selects a tab only in a window that already has focus, and only in the Space it shows (D71). */
  private selectInFocused(tabId: TabId, windowId: WindowId): void {
    const win = this.ctx.windows.get(windowId)
    if (!win || win.isDestroyed() || !win.isFocused()) return
    const state = this.ctx.store.state
    const tab = state.tabs[tabId]
    const spaceId = state.windows[windowId]?.spaceId
    if (!tab || !spaceId) return
    // Favorites show in every Space of their profile (activateInDraft keeps the Space for them).
    const shown =
      tab.spaceId === spaceId ||
      (sectionOf(state, tabId) === 'favorite' && state.spaces[spaceId]?.profileId === tab.profileId)
    if (shown) void this.ctx.commands.run('tabs.activate', { tabId }, { windowId })
  }

  /** The documents to try for picture-in-picture, most likely first (reports may lag: all of them, last). */
  private pipOrder(t: TabAgents, auto: boolean): Agent[] {
    const all = this.agentsOf(t)
    const by = (k: 'pipArea' | 'score') => (a: Agent, b: Agent) => (b.snap?.[k] ?? 0) - (a.snap?.[k] ?? 0)
    const engine = all.filter((a) => a.snap?.pip && !a.snap.player)
    const candidates = all.filter((a) => a.snap?.pipCandidate).sort(by('pipArea'))
    const videos = auto ? [] : all.filter((a) => a.snap?.video).sort(by('score'))
    return [...new Set([...engine, ...candidates, ...videos, ...all])]
  }

  /**
   * Opens or closes picture-in-picture for a tab (MD-02, MD-10 "Back to PiP"). A tab in the
   * background goes to Orbit's player, growing from `from` (a rect in a window, MD-16); the
   * selected tab uses the engine's window, as its page stays on screen.
   */
  async setPip(tabId: TabId, on: boolean, from?: { windowId: WindowId; rect: Rect }): Promise<boolean> {
    if (!on && this.player.tabId === tabId) {
      this.player.close('close')
      return true
    }
    if (!(await this.ensureAgent(tabId))) return false
    if (!on) return (await this.each(tabId, 'pip', [false, false], true)).some((ok) => ok === true)
    if (this.player.tabId === tabId) return true
    if (!this.shown.has(tabId)) return this.player.open(tabId, { auto: false, from })
    const t = this.tabs.get(tabId)
    for (const agent of t ? this.pipOrder(t, false) : []) {
      if ((await this.exec<boolean>(agent, 'pip', [true, false], true)) !== true) continue
      agent.orbitPip = true
      this.markPip(tabId, true)
      return true
    }
    return false
  }

  /**
   * "Picture in Picture" from the page's menu on a video (MD-02): the engine's window for the video
   * under the point (CSS px of the tab's page), in whichever frame the menu was for.
   */
  async pipAt(tabId: TabId, frame: WebFrameMain | null | undefined, x: number, y: number, on: boolean): Promise<void> {
    const contents = this.ctx.tabs.contents(tabId)
    if (!contents) return
    let sub: WebFrameMain | undefined
    try {
      if (frame?.parent && alive(frame)) sub = frame
    } catch {}
    if (!sub) {
      const code = on
        ? `(() => { const el = document.elementFromPoint(${x}, ${y}); const v = el && (el.tagName === 'VIDEO' ? el : el.closest('video')); return v ? v.requestPictureInPicture().then(() => true, () => false) : false })()`
        : 'document.exitPictureInPicture().then(() => true, () => false)'
      await contents.executeJavaScriptInIsolatedWorld(MEDIA_WORLD, [{ code }], true).catch(() => false)
    } else {
      await this.ensureAgent(tabId)
      const t = this.tabs.get(tabId)
      const agent = t && (await this.installFrame(tabId, t, sub, false))
      if (t && agent) {
        // Into the frame's page: less each frame's place in its parent.
        const chain = await this.chainTo(tabId, t, agent)
        let px = x
        let py = y
        for (const box of chain ? await this.frameBoxes(chain) : []) {
          px -= box?.x ?? 0
          py -= box?.y ?? 0
        }
        // Orbit's own menu opened it: its "Back to tab" may bring the window forward, once (D71).
        if ((await this.exec(agent, 'pipAt', [on, px, py], true)) === true && on) agent.orbitPip = true
      }
    }
    // The page scripts follow picture-in-picture from now on (tray, return to the tab).
    await this.watchTab(tabId)
  }

  // ---- The player's way to a video in a frame ----

  /** The player's calls into the page (player.ts): to the video's document, through the frames on the way. */
  private async playerCall<T>(tabId: TabId, fn: string, args: unknown[]): Promise<T | undefined> {
    const t = this.tabs.get(tabId)
    if (!t) return undefined
    if (fn === 'probe') return (await this.probe(tabId, t, (args[0] ?? {}) as { auto?: boolean })) as T
    const chain = this.chains.get(tabId)
    if (fn === 'drop') this.chains.delete(tabId)
    const agents = chain?.agents ?? (t.page ? [t.page] : [])
    const target = agents[agents.length - 1]
    if (!target) return undefined
    if (fn === 'lift' && chain && agents.length > 1) return (await this.liftChain(tabId, chain, args[0])) as T
    if (fn === 'drop') {
      const done = await Promise.all(agents.map((a) => this.exec(a, 'drop')))
      return done[done.length - 1] as T
    }
    const answer = await this.exec<unknown>(target, fn, args)
    if (!target.frame) return answer as T
    // A frame's answers are checked: the player only uses these.
    if (fn === 'zoom') return (isNum(answer) ? Math.min(Math.max(answer, 1), 4) : 1) as T
    return (answer === true) as T
  }

  /** Picks the video for the player (player.ts probe) in the tab's page or one of its frames. */
  private async probe(tabId: TabId, t: TabAgents, o: { auto?: boolean }): Promise<ProbeAnswer> {
    this.sweep(tabId, t)
    for (const target of this.pipOrder(t, !!o.auto)) {
      const chain = await this.chainTo(tabId, t, target)
      if (!chain || this.tabs.get(tabId) !== t) continue
      // A point is in the tab's own page: only its own videos can be under it.
      const r = await this.exec<ProbeAnswer>(target, 'probe', [target.frame ? { auto: o.auto } : o])
      if (r?.ok !== true) continue
      let rect = cleanRect(r.rect)
      // Into the tab's page: plus each frame's place in its parent, while each is in view.
      for (const box of chain.agents.length > 1 && rect ? await this.frameBoxes(chain) : []) {
        rect = rect && box?.visible ? { ...rect, x: rect.x + box.x, y: rect.y + box.y } : null
      }
      this.chains.set(tabId, chain)
      return { ok: true, aspect: isNum(r.aspect) ? r.aspect : 0, rect }
    }
    return { ok: false }
  }

  /** The documents from the tab's page down to the target's, each with a script. */
  private async chainTo(tabId: TabId, t: TabAgents, target: Agent): Promise<Chain | undefined> {
    if (!target.frame) return { agents: [target], idx: [-1] }
    const page = t.page
    if (!page?.snap) return undefined
    const path: WebFrameMain[] = []
    try {
      for (let f: WebFrameMain | null = target.frame; f?.parent; f = f.parent) path.unshift(f)
    } catch {
      return undefined
    }
    const agents = [page]
    for (const f of path) {
      const agent = await this.installFrame(tabId, t, f, false)
      if (!agent) return undefined
      agents.push(agent)
    }
    const idx = await Promise.all(agents.map((a, i) => (i === 0 ? -1 : this.exec<number>(a, 'index'))))
    // A frame its parent can't see (in a shadow tree) can't be lifted.
    if (idx.some((n, i) => i > 0 && !(isNum(n) && Number.isInteger(n) && n >= 0))) return undefined
    return { agents, idx: idx as number[] }
  }

  /** Where each frame of the chain starts in its parent's page (CSS px), and whether it is in view. */
  private frameBoxes(chain: Chain): Promise<({ x: number; y: number; visible: boolean } | null)[]> {
    return Promise.all(
      chain.agents.slice(0, -1).map(async (a, i) => {
        const box = await this.exec<{ x: unknown; y: unknown; visible: unknown }>(a, 'frameBox', [chain.idx[i + 1]])
        return box && isNum(box.x) && isNum(box.y) ? { x: box.x, y: box.y, visible: box.visible === true } : null
      }),
    )
  }

  /** Lifts each frame on the way at the borrowed view's size, and the video in its own (agent.ts). */
  private async liftChain(tabId: TabId, chain: Chain, o: unknown): Promise<boolean> {
    const arm = (o as { arm?: unknown } | null)?.arm
    const target = chain.agents[chain.agents.length - 1] as Agent
    const done = await Promise.all([
      this.exec<boolean>(target, 'lift', [o]),
      ...chain.agents.slice(0, -1).map((a, i) => this.exec<boolean>(a, 'liftFrame', [chain.idx[i + 1], arm])),
    ])
    if (done.every((ok) => ok === true)) return true
    // One of them couldn't: put back what did lift, and give up.
    if (this.chains.get(tabId) === chain) this.chains.delete(tabId)
    await Promise.all(chain.agents.map((a) => this.exec(a, 'drop')))
    return false
  }

  // ---- Controls ----

  /** Play, pause, seek, skip or change speed (MD-04, MD-09). `value`: seconds, a position or a speed. */
  async control(tabId: TabId, action: MediaAction, value?: number): Promise<boolean> {
    const t = this.tabs.get(tabId)
    if (!t) return false
    this.sweep(tabId, t)
    const gesture = action === 'play' || action === 'toggle' || action === 'previous'
    const agents = this.agentsOf(t)
    // The player's video, wherever it is; or the tab's only document.
    const chain = this.player.tabId === tabId ? this.chains.get(tabId) : undefined
    if (chain || agents.length <= 1) {
      const target = chain ? chain.agents[chain.agents.length - 1] : agents[0]
      return !!target && (await this.exec<boolean>(target, 'control', [action, value ?? 0], gesture)) === true
    }
    // Several documents: pause all that play, or resume what Orbit paused, else play the main media.
    let act = action
    if (act === 'toggle') act = agents.some((a) => a.snap?.active) ? 'pause' : 'play'
    const resumable = agents.filter((a) => a.snap?.resumable)
    const best = this.best(t)
    const targets = act === 'pause' ? agents : act === 'play' && resumable.length > 0 ? resumable : best ? [best] : []
    const done = await Promise.all(targets.map((a) => this.exec<boolean>(a, 'control', [act, value ?? 0], gesture)))
    return done.some((ok) => ok === true)
  }

  /** The controller's ×: pause and hide until it plays again (MD-09). */
  async dismiss(tabId: TabId): Promise<void> {
    this.patch(tabId, (m) => (m ? { ...m, dismissed: true } : m))
    await this.each(tabId, 'control', ['pause', 0])
  }

  async callControl(tabId: TabId, action: 'mic' | 'camera'): Promise<boolean> {
    const t = this.tabs.get(tabId)
    if (!t) return false
    const using = this.agentsOf(t).filter((a) => a.snap?.[action])
    const targets = using.length > 0 ? using : this.agentsOf(t).slice(0, 1)
    const done = await Promise.all(targets.map((a) => this.exec<boolean>(a, 'call', [action])))
    return done.some((ok) => ok === true)
  }

  /** Selects a tab in a window (switching Space if needed) and brings that window forward (MD-09). */
  focusTab(tabId: TabId, windowId: WindowId): void {
    void this.ctx.commands.run('tabs.activate', { tabId }, { windowId }).then(() => {
      const win = this.ctx.windows.get(windowId)
      if (!win || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.focus()
    })
  }

  // ---- Per-site choices (MD-08) ----

  sitePip(url: string): SitePipMode {
    return sitePipMode(this.ctx.store.state.settings, url, this.now())
  }

  setSitePip(url: string, mode: SitePipMode): void {
    if (!siteOf(url)) return
    const now = this.now()
    this.ctx.store.update((d) => applySitePip(d.settings, url, mode, now))
  }

  // ---- Menus ----

  /** The controller's "…" menu (MD-08, MD-10). */
  menu(tabId: TabId, windowId: WindowId | undefined): MenuItemConstructorOptions[] {
    const tab = this.ctx.store.state.tabs[tabId]
    if (!tab) return []
    const media = tab.media
    const site = siteOf(tab.url)
    const mode = this.sitePip(tab.url)
    const items: MenuItemConstructorOptions[] = [
      { label: 'Go to Tab', click: () => windowId && this.focusTab(tabId, windowId) },
    ]
    if (media?.video) {
      items.push({
        label: media.pip ? 'Close Picture in Picture' : 'Picture in Picture',
        click: () => void this.setPip(tabId, !media.pip),
      })
    }
    items.push({
      label: tab.muted ? 'Unmute Tab' : 'Mute Tab',
      click: () => void this.ctx.commands.run('tabs.setMuted', { tabId, muted: !tab.muted }, { windowId }),
    })
    if (site) {
      items.push(
        { type: 'separator' },
        {
          label: `Automatic Picture in Picture on ${site}`,
          submenu: [
            { label: 'On', type: 'radio', checked: mode === 'on', click: () => this.setSitePip(tab.url, 'on') },
            {
              label: 'Turn Off for Today',
              type: 'radio',
              checked: mode === 'today',
              click: () => this.setSitePip(tab.url, 'today'),
            },
            {
              label: 'Always Turn Off for This Site',
              type: 'radio',
              checked: mode === 'always',
              click: () => this.setSitePip(tab.url, 'always'),
            },
          ],
        },
      )
    }
    return items
  }
}
