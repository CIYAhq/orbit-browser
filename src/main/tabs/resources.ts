/**
 * Background limits beyond the sleep timer (TB-16), owned by the tabs lane.
 *
 * - CPU: every 10 s each tab's page process is sampled. A tab in the background whose process kept
 *   half a core busy for 30 s running (10 s with the battery saver) is frozen with the engine's page
 *   freezing, as Chrome freezes CPU-heavy tabs: its scripts, timers and workers stop where they are,
 *   and carry on once the tab is shown again or navigates. Only when every page in that process is
 *   a tab that may be frozen.
 * - Memory: when the system has less than 10 % of its memory available (1 GB at most), tabs idle
 *   five minutes in the background sleep at once, whatever the timer says.
 * - Battery: below 20 % on battery power, the battery saver: tabs in the background sleep after a
 *   quarter of the timer (five minutes at least) and CPU-heavy ones freeze after 10 s. A toast says
 *   so as it comes on. It lifts above 20 % or once the computer charges.
 *
 * Never frozen, nor put to sleep sooner: tabs on screen, playing or recording (MD-12), and a page
 * that would warn before it goes (NV-24).
 */
import { cpus } from 'node:os'
import { app, type WebContents, webContents } from 'electron'
import { isMediaBusy } from '../../shared/media'
import type { TabId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import type { TabMaintenance } from './maintenance'
import { displayedTabs } from './model'
import type { TabOps } from './ops'

export const RESOURCE_INTERVAL_MS = 10_000
/** A process keeping at least this share of one core busy is CPU-heavy… */
export const HOG_SHARE = 0.5
/** …once it has been for this many passes running (30 s); with the battery saver, one. */
export const HOG_PASSES = 3
/** Low memory: less available than this share of the system's memory, or than 1 GB if less. */
export const LOW_MEMORY_SHARE = 0.1
export const LOW_MEMORY_KB = 1024 * 1024
/** The battery saver comes on below this level on battery power, and lifts above it. */
export const SAVER_LEVEL = 0.2
export const SAVER_MESSAGE = 'Battery saver is on: tabs in the background sleep sooner'

/** In KB, as the system gives it. */
export interface MemoryInfo {
  total: number
  available: number
}

export function isLowMemory(m: MemoryInfo): boolean {
  return m.total > 0 && m.available < Math.min(m.total * LOW_MEMORY_SHARE, LOW_MEMORY_KB)
}

/** Whether the battery saver is on, given the battery now and whether it was. */
export function saverAfter(was: boolean, battery: { level: number; charging: boolean }): boolean {
  if (battery.charging || battery.level > SAVER_LEVEL) return false
  return battery.level < SAVER_LEVEL || was
}

export interface CpuSample {
  tabId: TabId
  /** Its page's process. */
  pid: number
  /** The share of one core that process used since the last pass. */
  share: number
  /** In the background, not playing or recording, and goes without asking. */
  freezable: boolean
}

/**
 * The tabs to freeze after a pass (TB-16). `busy` counts each tab's passes running at `HOG_SHARE` or
 * more. Each tab of a process that has been CPU-heavy for `passes` is frozen, if all of them may be
 * and the process draws nothing else (`shared`: Orbit's own views, a Peek, a pop-up window).
 */
export function cpuHeavy(
  samples: readonly CpuSample[],
  busy: Map<TabId, number>,
  passes: number,
  shared: ReadonlySet<number>,
): TabId[] {
  const byPid = new Map<number, CpuSample[]>()
  for (const s of samples) {
    busy.set(s.tabId, s.share >= HOG_SHARE ? (busy.get(s.tabId) ?? 0) + 1 : 0)
    byPid.set(s.pid, [...(byPid.get(s.pid) ?? []), s])
  }
  const sampled = new Set(samples.map((s) => s.tabId))
  for (const id of [...busy.keys()]) if (!sampled.has(id)) busy.delete(id)
  const out: TabId[] = []
  for (const [pid, group] of byPid) {
    if (pid <= 0 || shared.has(pid) || !group.every((s) => s.freezable)) continue
    if (group.some((s) => (busy.get(s.tabId) ?? 0) >= passes)) out.push(...group.map((s) => s.tabId))
  }
  return out
}

/** The engine's page lifecycle: frozen, or running again. */
async function setLifecycle(contents: WebContents, state: 'frozen' | 'active'): Promise<void> {
  if (contents.isDestroyed()) return
  const client = contents.debugger
  const ours = !client.isAttached()
  try {
    if (ours) client.attach('1.3')
    await client.sendCommand('Page.setWebLifecycleState', { state })
  } catch {
    // Gone meanwhile, or the engine said no: the page runs as it was.
  } finally {
    // Attached only for the command: a page with a DevTools client attached is waited on longer
    // as it closes (NV-24).
    if (ours && !contents.isDestroyed() && client.isAttached()) client.detach()
  }
}

function systemMemory(): MemoryInfo | null {
  try {
    const m = process.getSystemMemoryInfo() as { total: number; free: number; available?: number }
    return { total: m.total, available: m.available ?? m.free }
  } catch {
    return null
  }
}

export interface ResourceInfo {
  frozen: TabId[]
  /** Each awake tab's process: share of one core in the last pass, in %. */
  usage: Record<TabId, number>
  lowMemory: boolean
  saver: boolean
}

export class ResourceWatch {
  private timer: NodeJS.Timeout | undefined
  private unsubscribe: (() => void) | undefined
  private busy = new Map<TabId, number>()
  private frozen = new Map<TabId, { contents: WebContents; off: () => void }>()
  private usage: Record<TabId, number> = {}
  private lowMemory = false
  private saver = false
  /** One lifecycle change at a time: a thaw never overtakes the freeze before it. */
  private queue: Promise<void> = Promise.resolve()
  /** Tests stand in for the system's memory (null: the real one). */
  memory: MemoryInfo | null = null

  constructor(
    private ctx: MainContext,
    private ops: TabOps,
    private maintenance: TabMaintenance,
  ) {}

  start(): void {
    this.maintenance.pressure = () => ({ lowMemory: this.lowMemory, saver: this.saver })
    // A frozen tab shown again carries on.
    this.unsubscribe = this.ctx.store.subscribe((next) => {
      if (this.frozen.size === 0) return
      const shown = displayedTabs(next)
      for (const id of [...this.frozen.keys()]) if (shown.has(id) || !next.tabs[id]) this.thaw(id)
    })
    this.timer = setInterval(() => this.pass(), RESOURCE_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  /** One pass: memory, then each tab's CPU. */
  pass(): ResourceInfo {
    const memory = this.memory ?? systemMemory()
    const wasLow = this.lowMemory
    this.lowMemory = !!memory && isLowMemory(memory)
    if (this.lowMemory && !wasLow) this.maintenance.run()
    this.sampleCpu()
    return { frozen: [...this.frozen.keys()], usage: { ...this.usage }, lowMemory: this.lowMemory, saver: this.saver }
  }

  /** The battery, as a window's page reads it (`navigator.getBattery()`). */
  battery(level: number, charging: boolean, windowId?: WindowId): void {
    const was = this.saver
    this.saver = saverAfter(was, { level, charging })
    if (!this.saver || was) return
    this.ctx.toast(this.ctx.windows.focusedWindowId() ?? windowId, SAVER_MESSAGE)
    this.maintenance.run()
  }

  private sampleCpu(): void {
    const { tabs, store } = this.ctx
    // A process's share of all cores, as the engine gives it, made a share of one.
    const cores = cpus().length || 1
    const share = new Map<number, number>()
    for (const m of app.getAppMetrics()) share.set(m.pid, (m.cpu.percentCPUUsage * cores) / 100)
    const state = store.state
    const shown = displayedTabs(state)
    const samples: CpuSample[] = []
    this.usage = {}
    for (const tabId of tabs.liveTabIds()) {
      const contents = tabs.contents(tabId)
      if (!contents || contents.isDestroyed()) continue
      const pid = contents.getOSProcessId()
      const used = share.get(pid) ?? 0
      this.usage[tabId] = Math.round(used * 100)
      if (this.frozen.has(tabId)) continue
      const freezable = !shown.has(tabId) && !isMediaBusy(state.tabs[tabId]) && (this.ops.mayDiscard?.(tabId) ?? true)
      samples.push({ tabId, pid, share: used, freezable })
    }
    const shared = new Set<number>()
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.isDestroyed() && !tabs.tabIdFor(contents)) shared.add(contents.getOSProcessId())
    }
    for (const tabId of cpuHeavy(samples, this.busy, this.saver ? 1 : HOG_PASSES, shared)) this.freeze(tabId)
  }

  private freeze(tabId: TabId): void {
    const contents = this.ctx.tabs.contents(tabId)
    if (!contents || this.frozen.has(tabId)) return
    // A frozen page that navigates (another frame's link, Orbit's Reload) carries on first.
    const navigating = (details: { isMainFrame: boolean }) => {
      if (details.isMainFrame) this.thaw(tabId)
    }
    const gone = () => {
      if (this.frozen.get(tabId)?.contents === contents) this.frozen.delete(tabId)
    }
    contents.on('did-start-navigation', navigating)
    contents.once('destroyed', gone)
    this.frozen.set(tabId, {
      contents,
      off: () => {
        contents.off('did-start-navigation', navigating)
        contents.off('destroyed', gone)
      },
    })
    this.busy.delete(tabId)
    this.queue = this.queue.then(() => setLifecycle(contents, 'frozen'))
  }

  private thaw(tabId: TabId): void {
    const entry = this.frozen.get(tabId)
    if (!entry) return
    this.frozen.delete(tabId)
    entry.off()
    this.queue = this.queue.then(() => setLifecycle(entry.contents, 'active'))
  }
}
