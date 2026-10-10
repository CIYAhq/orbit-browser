import type { MenuItemConstructorOptions } from 'electron'
import type { WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import { KEEP_DAYS_CHOICES, keepDaysOf } from './retention'

/**
 * A Keep time chosen in a menu (AR-08): set at once, unless the shorter time deletes entries; then
 * the Library asks first, saying how many. Resolves to whether it was set.
 */
export async function chooseKeepDays(
  ctx: Pick<MainContext, 'commands'>,
  days: number,
  windowId: WindowId | undefined,
): Promise<boolean> {
  const result = await ctx.commands.run('archive.setKeepDays', { days }, { windowId })
  if (!result.set && result.purges > 0) {
    await ctx.commands.run(
      'library.open',
      { section: 'archive', confirmKeep: { days, count: result.purges } },
      { windowId },
    )
  }
  return result.set
}

/**
 * "Keep Archived Tabs For" › 30 Days / 90 Days / 1 Year / Forever, the current one checked (AR-08).
 * `refresh` rebuilds the menu when a choice waits for the user's yes, so its check stays on the
 * time in force.
 */
export function keepForMenu(
  ctx: Pick<MainContext, 'store' | 'commands' | 'windows'>,
  opts: { windowIdOf?: () => WindowId | undefined; refresh?: () => void } = {},
): MenuItemConstructorOptions {
  const current = keepDaysOf(ctx.store.state)
  const windowIdOf = opts.windowIdOf ?? (() => ctx.windows.focusedWindowId())
  return {
    label: 'Keep Archived Tabs For',
    submenu: KEEP_DAYS_CHOICES.map((c) => ({
      label: c.label,
      type: 'radio' as const,
      checked: c.days === current,
      click: () => {
        chooseKeepDays(ctx, c.days, windowIdOf())
          .then((set) => {
            if (!set) opts.refresh?.()
          })
          .catch((err) => console.error('[archive] could not change how long archived tabs are kept', err))
      },
    })),
  }
}

/**
 * The Archive's own items (AR-07, AR-08): "Clear Archive…", which opens the Library and asks
 * first, and how long entries are kept. In the app menu's Archive menu and the menu of the
 * Archive's entry in the Library.
 */
export function archiveSectionItems(
  ctx: Pick<MainContext, 'store' | 'actions' | 'windows' | 'commands'>,
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
    keepForMenu(ctx, { windowIdOf }),
  ]
}
