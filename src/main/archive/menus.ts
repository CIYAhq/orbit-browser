import type { MenuItemConstructorOptions } from 'electron'
import type { WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import { KEEP_DAYS_CHOICES, keepDaysOf } from './retention'

/** Sets how long Archive entries are kept (AR-08); a shorter time purges at once (retention.ts). */
export function setKeepDays(ctx: Pick<MainContext, 'store'>, days: number): void {
  if (!KEEP_DAYS_CHOICES.some((c) => c.days === days)) return
  if (keepDaysOf(ctx.store.state) === days) return
  ctx.store.update((d) => {
    d.settings.archiveKeepDays = days
  })
}

/** "Keep Archived Tabs For" › 30 Days / 90 Days / 1 Year / Forever, the current one checked (AR-08). */
export function keepForMenu(ctx: Pick<MainContext, 'store'>): MenuItemConstructorOptions {
  const current = keepDaysOf(ctx.store.state)
  return {
    label: 'Keep Archived Tabs For',
    submenu: KEEP_DAYS_CHOICES.map((c) => ({
      label: c.label,
      type: 'radio' as const,
      checked: c.days === current,
      click: () => setKeepDays(ctx, c.days),
    })),
  }
}

/**
 * The Archive's own items (AR-07, AR-08): "Clear Archive…", which opens the Library and asks
 * first, and how long entries are kept. In the app menu's Archive menu and the menu of the
 * Archive's entry in the Library.
 */
export function archiveSectionItems(
  ctx: Pick<MainContext, 'store' | 'actions' | 'windows'>,
  windowIdOf: () => WindowId | undefined = () => ctx.windows.focusedWindowId(),
  opts: { canClear?: boolean } = {},
): MenuItemConstructorOptions[] {
  return [
    {
      label: 'Clear Archive…',
      enabled: opts.canClear !== false,
      click: () => {
        Promise.resolve(ctx.actions.run('archive.clear', { windowId: windowIdOf() })).catch((err) =>
          console.error('[archive] could not clear the Archive', err),
        )
      },
    },
    keepForMenu(ctx),
  ]
}
