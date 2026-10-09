/**
 * Media in the main process (media lane): picture-in-picture, the sidebar media tray and call
 * controls. Event driven, no polling:
 * - a tab gets Orbit's page script (agent.ts) only once it plays media (`media-started-playing`,
 *   or it turns audible); the script reports changes through a long-poll;
 * - tab switches arrive as store changes: a tab leaving the screen with a playing video goes to
 *   Orbit's floating player (player.ts, MD-01), and coming back ends it;
 * - each tab's `media` record (shared/state.ts) holds what the sidebar and the player need, and
 *   `tray` says whether its controller shows (shared/media.ts settleTray).
 *
 * The engine's own picture-in-picture window is still used while the tab stays on screen (the
 * page's own PiP button, "Picture in Picture" on the selected tab): Orbit's player borrows the
 * tab's view, which can't show in two places at once. Leaving the tab hands such a video over to
 * Orbit's player.
 */
import type { MenuItemConstructorOptions, WebContents } from 'electron'
import {
  type AgentSnapshot,
  applySitePip,
  type MediaAction,
  mediaFromSnapshot,
  type PipEndReason,
  type SitePipMode,
  sameMedia,
  settleTray,
  shouldAutoPip,
  siteOf,
  sitePipMode,
} from '../../shared/media'
import type { Rect } from '../../shared/rpc'
import type { OrbitState, TabId, TabMedia, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import { displayedTabs } from '../tabs/model'
import { AGENT_SOURCE, MEDIA_WORLD } from './agent'
import { PipPlayer } from './player'

interface Agent {
  contents: WebContents
  /** The last report. */
  snap?: AgentSnapshot
  /** The last picture-in-picture ending already handled (reports repeat it). */
  pipEndSeen: number
  /** A long-poll is running for this document. */
  looping: boolean
}

const call = (fn: string, ...args: unknown[]) =>
  `window.__orbitMedia ? window.__orbitMedia.${fn}(${args.map((a) => JSON.stringify(a ?? null)).join(', ')}) : null`

export class MediaManager {
  private agents = new Map<TabId, Agent>()
  /** Tabs on screen in any window at the last state change. */
  private shown = new Set<TabId>()
  /** Last menu template (tests read it instead of a native popup). */
  lastMenu: MenuItemConstructorOptions[] = []
  readonly player: PipPlayer

  constructor(
    private ctx: MainContext,
    private now: () => number = Date.now,
  ) {
    this.player = new PipPlayer(ctx, {
      call: (tabId, fn, ...args) => this.run(tabId, call(fn, ...args)),
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

  /** The page script's last report for a tab (tests and diagnostics). */
  snapshot(tabId: TabId): AgentSnapshot | undefined {
    return this.agents.get(tabId)?.snap
  }

  // ---- Page script lifecycle ----

  private watch(tabId: TabId, contents: WebContents): void {
    contents.on('media-started-playing', () => void this.install(tabId, contents))
    contents.on('audio-state-changed', (e) => {
      if (e.audible) void this.install(tabId, contents)
      // Media removed from the page pauses without an event the script can see: ask again.
      else void this.run(tabId, call('refresh'))
    })
    // A new document: its media (and picture-in-picture) went with the old one.
    contents.on('did-navigate', () => this.drop(tabId, contents, 'navigated'))
    contents.once('destroyed', () => this.drop(tabId, contents, 'gone'))
  }

  /** Installs the page script in a tab that plays media (once per document) and follows its reports. */
  private async install(tabId: TabId, contents: WebContents): Promise<void> {
    const existing = this.agents.get(tabId)
    if (existing?.contents === contents && existing.looping) return
    const agent: Agent = { contents, pipEndSeen: 0, looping: true }
    this.agents.set(tabId, agent)
    let snap: AgentSnapshot | null = null
    try {
      snap = await contents.executeJavaScriptInIsolatedWorld(MEDIA_WORLD, [{ code: AGENT_SOURCE }])
    } catch {
      // The page went away meanwhile.
    }
    if (this.agents.get(tabId) !== agent) return
    if (!snap) {
      agent.looping = false
      return
    }
    this.apply(tabId, agent, snap)
    void this.follow(tabId, agent)
  }

  private async follow(tabId: TabId, agent: Agent): Promise<void> {
    while (this.agents.get(tabId) === agent && !agent.contents.isDestroyed()) {
      let snap: AgentSnapshot | null = null
      try {
        snap = await agent.contents.executeJavaScriptInIsolatedWorld(MEDIA_WORLD, [
          { code: call('next', agent.snap?.v ?? 0) },
        ])
      } catch {
        break
      }
      if (this.agents.get(tabId) !== agent) return
      if (!snap) break
      this.apply(tabId, agent, snap)
    }
    if (this.agents.get(tabId) === agent) agent.looping = false
  }

  /** Forgets a tab's media when its document or contents go away (MD-07, MD-12). */
  private drop(tabId: TabId, contents: WebContents, why: 'navigated' | 'gone'): void {
    const agent = this.agents.get(tabId)
    if (agent && agent.contents !== contents) return
    this.player.closeFor(tabId, why)
    this.agents.delete(tabId)
    this.ctx.store.update((d) => {
      const tab = d.tabs[tabId]
      if (tab?.media) delete tab.media
    })
  }

  /** Runs a script function in the tab's page script; undefined if the tab has none. */
  private async run<T>(tabId: TabId, code: string, gesture = false): Promise<T | undefined> {
    const agent = this.agents.get(tabId)
    if (!agent || agent.contents.isDestroyed()) return undefined
    try {
      return (await agent.contents.executeJavaScriptInIsolatedWorld(MEDIA_WORLD, [{ code }], gesture)) as T
    } catch {
      return undefined
    }
  }

  /** Makes sure the tab has the page script (e.g. picture-in-picture for a video that never played). */
  watchTab(tabId: TabId): Promise<boolean> {
    return this.ensureAgent(tabId)
  }

  private async ensureAgent(tabId: TabId): Promise<boolean> {
    if (this.agents.get(tabId)?.snap) return true
    const contents = this.ctx.tabs.contents(tabId)
    if (!contents) return false
    await this.install(tabId, contents)
    return !!this.agents.get(tabId)?.snap
  }

  // ---- State ----

  private apply(tabId: TabId, agent: Agent, snap: AgentSnapshot): void {
    const first = !agent.snap
    agent.snap = snap
    if (first) agent.pipEndSeen = snap.pipEnd?.n ?? 0
    else if (snap.pipEnd && snap.pipEnd.n > agent.pipEndSeen) {
      agent.pipEndSeen = snap.pipEnd.n
      this.onPipEnd(tabId, snap.pipEnd.reason)
    }
    // A video plays somewhere: get the player ready, so leaving its tab shows it at once (MD-01).
    if (snap.video) this.player.prewarm()
    this.patch(tabId, (prev) => {
      const next = mediaFromSnapshot(prev, snap)
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
    for (const id of this.agents.keys()) {
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
    const agent = this.agents.get(tabId)
    const tab = state.tabs[tabId]
    if (!agent?.snap || !tab?.media || agent.contents.isDestroyed()) return
    // The engine's own window (opened on the tab) hands its video over to Orbit's player, with
    // Orbit's controls. The user asked for it, so the automatic-PiP choices don't apply.
    if (agent.snap.pip && !agent.snap.player) {
      void this.player.open(tabId, { auto: true, keep: true })
      return
    }
    // The page script checks again (the report may be a moment old): only a playing video goes.
    const candidate = agent.snap.pipCandidate || agent.snap.video
    if (!shouldAutoPip(state.settings, tab, candidate, this.now())) return
    void this.player.open(tabId, { auto: true, from: 'page' })
  }

  /** A tab came back on screen: its picture-in-picture ends and the video plays in the page (MD-01, MD-07). */
  private returned(tabId: TabId, state: OrbitState): void {
    if (this.player.tabId === tabId) {
      this.player.close('returned')
      return
    }
    if (state.tabs[tabId]?.media?.pip) void this.run(tabId, call('pip', false, false))
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

  /** Picture-in-picture ended in the page (MD-04, MD-07). */
  private onPipEnd(tabId: TabId, reason: PipEndReason): void {
    // Orbit's player: its video ended or left the page.
    if (reason === 'ended' || reason === 'gone') this.player.closeFor(tabId, reason)
    if (reason !== 'back') return
    // The engine window's "Back to tab": select the source tab in its window (and Space).
    const windowId = this.ctx.windows.windowOfTab(tabId) ?? this.ctx.windows.focusedWindowId()
    if (windowId) this.focusTab(tabId, windowId)
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
    if (!on) return !!(await this.run<boolean>(tabId, call('pip', false, false), true))
    if (this.player.tabId === tabId) return true
    if (!this.shown.has(tabId)) return this.player.open(tabId, { auto: false, from })
    const ok = await this.run<boolean>(tabId, call('pip', true, false), true)
    if (ok) this.markPip(tabId, true)
    return !!ok
  }

  // ---- Controls ----

  /** Play, pause, seek, skip or change speed (MD-04, MD-09). `value`: seconds, a position or a speed. */
  async control(tabId: TabId, action: MediaAction, value?: number): Promise<boolean> {
    const gesture = action === 'play' || action === 'toggle' || action === 'previous'
    const ok = await this.run<boolean>(tabId, call('control', action, value ?? 0), gesture)
    return !!ok
  }

  /** The controller's ×: pause and hide until it plays again (MD-09). */
  async dismiss(tabId: TabId): Promise<void> {
    this.patch(tabId, (m) => (m ? { ...m, dismissed: true } : m))
    await this.run(tabId, call('control', 'pause', 0))
  }

  async callControl(tabId: TabId, action: 'mic' | 'camera'): Promise<boolean> {
    return !!(await this.run<boolean>(tabId, call('call', action)))
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
