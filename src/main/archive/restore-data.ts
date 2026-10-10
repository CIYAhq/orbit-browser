import type { BackupRestoreResult } from '../../shared/commands/archive'
import type { MainContext } from '../context'
import type { BackupStore } from './backups'
import { sidebarRestored } from './inbox'
import { restoreSidebar } from './snapshot'
import type { ArchiveStore } from './store'

/**
 * Restore Data (AR-11): puts the sidebar back as a backup has it, one restore at a time. The
 * sidebar as it is now is backed up first; when that backup can't be written, nothing changes.
 */
export class RestoreData {
  private queue: Promise<unknown> = Promise.resolve()

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
    // The sidebar as it is now is backed up first: restoring that backup undoes this. Without that
    // backup nothing changes (the restore could not be taken back).
    let before: Awaited<ReturnType<BackupStore['take']>>
    try {
      before = await this.backups.take(this.ctx.store.state, this.now())
    } catch (err) {
      console.error('[backups] could not back up the sidebar before a restore; nothing was changed', err)
      return { restored: false, reason: 'backup-failed' }
    }
    const plan = restoreSidebar(this.ctx, this.archive, snap)
    const undoId = before.id !== id ? before.id : undefined
    // ⌘Z takes it back too; the sidebar's earlier undo steps no longer apply.
    sidebarRestored(
      undoId
        ? () => {
            this.restore(undoId).catch((err) => console.error('[backups] could not undo a restore', err))
          }
        : undefined,
    )
    return {
      restored: true,
      ...(undoId ? { undoId } : {}),
      added: plan.added.length,
      archived: plan.removed.length,
    }
  }
}
