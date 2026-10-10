import type { BackupRestoreResult, BackupUndoResult } from '../../shared/commands/archive'
import type { MainContext } from '../context'
import type { BackupStore } from './backups'
import { sidebarUndo } from './inbox'
import { buildSnapshot, restoreSidebar, type SidebarSnapshot } from './snapshot'
import type { ArchiveStore } from './store'

/** The restore's step on the sidebar's undo stack. */
export const RESTORE_UNDO_LABEL = 'Restore Data'
/** Restores whose toast may still offer Undo. */
const STEPS_KEPT = 10

/**
 * Restore Data (AR-11): puts the sidebar back as a backup has it, one restore at a time.
 *
 * - The sidebar as it is now is backed up first; when that backup can't be written, nothing
 *   changes.
 * - Each restore is one step on the sidebar's undo stack (TB-18), above the steps from before it.
 *   ⌘Z puts back the sidebar it replaced, held in memory (so no backup the schedule prunes is
 *   needed); the next ⌘Z goes further back, and ⌘⇧Z restores again.
 */
export class RestoreData {
  private queue: Promise<unknown> = Promise.resolve()
  private lastStep = 0
  /** The undo of each recent restore still waiting on the stack, by step number (the toast's Undo). */
  private steps = new Map<number, () => unknown>()

  constructor(
    private ctx: Pick<MainContext, 'store' | 'tabs'>,
    private archive: Pick<ArchiveStore, 'get' | 'idsOfTab' | 'delete' | 'load'>,
    private backups: Pick<BackupStore, 'read' | 'take'>,
    private now: () => number = Date.now,
  ) {}

  /** Restores backup `id`, after the restores asked for before it. */
  restore(id: unknown): Promise<BackupRestoreResult> {
    const run = this.queue.then(() => this.restoreNow(id))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async restoreNow(id: unknown): Promise<BackupRestoreResult> {
    const snap = await this.backups.read(id)
    if (!snap) return { restored: false, reason: 'unreadable' }
    await this.archive.load()
    // The sidebar as it is now is backed up first (Backups lists it). Without that backup nothing
    // changes.
    try {
      await this.backups.take(this.ctx.store.state, this.now())
    } catch (err) {
      console.error('[backups] could not back up the sidebar before a restore; nothing was changed', err)
      return { restored: false, reason: 'backup-failed' }
    }
    const at = this.now()
    const state = this.ctx.store.state
    const replaced = buildSnapshot(state, at)
    const plan = restoreSidebar(this.ctx, this.archive, snap, at)
    // A restore that changed nothing is no step to undo.
    const undoStep = this.ctx.store.state !== state ? this.record(snap, replaced) : undefined
    return {
      restored: true,
      ...(undoStep !== undefined ? { undoStep } : {}),
      added: plan.added.length,
      archived: plan.removed.length,
    }
  }

  /**
   * Records a restore to `target` on the sidebar's undo stack. Its undo puts back `replaced` and
   * returns the redo, which restores `target` again and records it again.
   */
  private record(target: SidebarSnapshot, replaced: SidebarSnapshot): number | undefined {
    const stack = sidebarUndo()
    if (!stack) return undefined
    const step = ++this.lastStep
    const undo = () => {
      this.steps.delete(step)
      restoreSidebar(this.ctx, this.archive, replaced, this.now())
      return () => {
        restoreSidebar(this.ctx, this.archive, target, this.now())
        this.record(target, replaced)
      }
    }
    stack.push(RESTORE_UNDO_LABEL, undo, this.now())
    this.steps.set(step, undo)
    if (this.steps.size > STEPS_KEPT) this.steps.delete(this.steps.keys().next().value as number)
    return step
  }

  /**
   * The restore toast's Undo: takes restore `step` back while it is the sidebar's newest change, as
   * ⌘Z would. A change made since stays, and so does the restore (`later`); `gone` when it was
   * undone already.
   */
  undo(step: unknown): BackupUndoResult {
    const undo = typeof step === 'number' ? this.steps.get(step) : undefined
    const stack = sidebarUndo()
    if (!undo || !stack) return 'gone'
    if (stack.peek()?.undo !== undo) return 'later'
    stack.undo()
    return 'undone'
  }
}
