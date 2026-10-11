import type { MenuItemConstructorOptions } from 'electron'
import type { TabId, WindowId } from '../../shared/state'
import { tweakHostOf } from '../../shared/tweaks'
import type { MainContext } from '../context'

/** The tab menu's item (BO-01). */
export const TAB_MENU_TWEAK = 'Tweak this Site…'

/**
 * "Tweak this Site…" in a tab's menu (src/main/tabs/menus.ts, BO-01): a new Tweak for the tab's
 * site, the tab shown first. Only on a website, and while Tweaks are on (BO-16). It shows the key
 * of New Tweak when the user gave it one (TAB_MENU_KEYS, KS-18).
 */
export function tabTweakMenuItems(
  ctx: MainContext,
  tabId: TabId,
  windowId: WindowId | undefined,
): MenuItemConstructorOptions[] {
  const state = ctx.store.state
  const tab = state.tabs[tabId]
  if (!tab || tab.error || !state.settings.tweaksEnabled || !tweakHostOf(tab.url)) return []
  return [
    {
      label: TAB_MENU_TWEAK,
      click: () => void ctx.commands.run('tweaks.create', { tabId }, { windowId }).catch(() => {}),
    },
  ]
}
