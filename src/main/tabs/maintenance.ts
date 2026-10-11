/**
 * Background housekeeping for tabs (owned by the tabs lane):
 * - auto-archive of idle Today tabs (TD-02, TD-03, TD-06),
 * - sleeping idle background tabs (TB-16, FV-08),
 * - idle clocks: a tab's idle time starts when it stops being on screen (TD-02).
 * Time comes from an injected clock so tests can jump ahead.
 */
import { powerMonitor } from 'electron'
import type { ItemId, OrbitState, TabId } from '../../shared/state'
import { tabsInItem } from '../../shared/tree'
import type { MainContext } from '../context'
import { autoArchiveCandidates, displayedTabs, sleepCandidates } from './model'
import type { TabOps } from './ops'

export const MAINTENANCE_INTERVAL_MS = 60_000

/** Every archive period in force: the global one and each profile's own (TD-03). */
function archivePeriods(state: OrbitState): string {
  const own = Object.entries(state.profiles).map(([id, p]) => `${id}=${p.archiveAfterMs ?? ''}`)
  return [state.settings.archiveAfterMs, ...own].join(',')
}

export class TabMaintenance {
  private timer: NodeJS.Timeout | undefined
  private launch: NodeJS.Timeout | undefined
  private unsubscribe: (() => void) | undefined
  private shown = new Set<TabId>()
  private onResume = () => this.run()

  constructor(
    private ctx: MainContext,
    private ops: TabOps,
    private now: () => number = Date.now,
  ) {}

  start(): void {
    this.shown = displayedTabs(this.ctx.store.state)
    // A tab stops being "viewed" when it leaves the screen: that moment starts its idle clock.
    this.unsubscribe = this.ctx.store.subscribe((next, prev) => {
      // A changed archive period applies at once to the Today tabs there are (TD-03).
      if ((next.profiles !== prev.profiles || next.settings !== prev.settings) && this.timer) {
        if (archivePeriods(next) !== archivePeriods(prev)) queueMicrotask(() => this.timer && this.run())
      }
      const shown = displayedTabs(next)
      const left = [...this.shown].filter((id) => !shown.has(id) && next.tabs[id])
      this.shown = shown
      if (left.length === 0) return
      const at = this.now()
      queueMicrotask(() =>
        this.ctx.store.update((d) => {
          for (const id of left) {
            const tab = d.tabs[id]
            if (tab && tab.lastActiveAt < at) tab.lastActiveAt = at
          }
        }),
      )
    })
    this.timer = setInterval(() => this.run(), MAINTENANCE_INTERVAL_MS)
    this.timer.unref?.()
    powerMonitor.on('resume', this.onResume)
    // Launch counts too: idle time accrues while the app is closed.
    this.launch = setTimeout(() => {
      this.launch = undefined
      this.run()
    }, 2_000)
    this.launch.unref?.()
  }

  /** The pass shortly after launch is still to come. */
  get launchPending(): boolean {
    return this.launch !== undefined
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.launch) clearTimeout(this.launch)
    this.timer = undefined
    this.launch = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
    powerMonitor.off('resume', this.onResume)
  }

  /** One pass: archive idle Today items, then put idle background tabs to sleep. */
  run(now = this.now()): { archived: ItemId[]; slept: TabId[] } {
    // A page that warns before it goes stays, and isn't tried again until it navigates or gets a
    // new user gesture (NV-24).
    const mayGo = (tabId: TabId) => this.ops.mayDiscard?.(tabId) ?? true
    const archived = autoArchiveCandidates(this.ctx.store.state, now).filter((id) =>
      tabsInItem(this.ctx.store.state, id).every(mayGo),
    )
    if (archived.length > 0) {
      const tabIds = archived.flatMap((id) => tabsInItem(this.ctx.store.state, id))
      this.ops.closeTabs(tabIds, 'auto', { undoLabel: false, idle: true })
    }
    const slept = sleepCandidates(this.ctx.store.state, now, this.ctx.tabs.liveTabIds()).filter(mayGo)
    for (const id of slept) if (!this.ops.sleepGuard?.(id)) this.ctx.tabs.sleep(id)
    return { archived, slept }
  }
}
