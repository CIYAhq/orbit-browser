/**
 * Background housekeeping for tabs (owned by the tabs lane):
 * - auto-archive of idle Today tabs (TD-02, TD-03, TD-06),
 * - sleeping idle background tabs (TB-16, FV-08),
 * - idle clocks: a tab's idle time starts when it stops being on screen (TD-02).
 * Time comes from an injected clock so tests can jump ahead.
 */
import { powerMonitor } from 'electron'
import type { ItemId, TabId } from '../../shared/state'
import { tabsInItem } from '../../shared/tree'
import type { MainContext } from '../context'
import { autoArchiveCandidates, displayedTabs, sleepCandidates } from './model'
import type { TabOps } from './ops'

export const MAINTENANCE_INTERVAL_MS = 60_000

export class TabMaintenance {
  private timer: NodeJS.Timeout | undefined
  private shown = new Set<TabId>()

  constructor(
    private ctx: MainContext,
    private ops: TabOps,
    private now: () => number = Date.now,
  ) {}

  start(): void {
    this.shown = displayedTabs(this.ctx.store.state)
    // A tab stops being "viewed" when it leaves the screen: that moment starts its idle clock.
    this.ctx.store.subscribe((next) => {
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
    powerMonitor.on('resume', () => this.run())
    // Launch counts too: idle time accrues while the app is closed.
    setTimeout(() => this.run(), 2_000).unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** One pass: archive idle Today items, then put idle background tabs to sleep. */
  run(now = this.now()): { archived: ItemId[]; slept: TabId[] } {
    const archived = autoArchiveCandidates(this.ctx.store.state, now)
    if (archived.length > 0) {
      const tabIds = archived.flatMap((id) => tabsInItem(this.ctx.store.state, id))
      this.ops.closeTabs(tabIds, 'auto', { undoLabel: false })
    }
    const slept = sleepCandidates(this.ctx.store.state, now, this.ctx.tabs.liveTabIds())
    for (const id of slept) this.ctx.tabs.sleep(id)
    return { archived, slept }
  }
}
