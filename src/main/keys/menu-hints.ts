import type { MenuItemConstructorOptions } from 'electron'
import { ACTIONS_BY_ID, shortcutsFor, toElectronAccelerator } from '../../shared/actions'

/**
 * Shortcut hints in Orbit's right-click menus (KS-18). An item that does what an action does shows
 * the action's first key, read from the live keymap each time the menu is built, so a remap shows
 * the next time the menu opens. The hint is only shown: Orbit's key router runs the keys, so the
 * item never registers them.
 */

/** Items, by label, and the action whose keys do the same. */
export type KeyHints = readonly (readonly [label: string | RegExp, actionId: string])[]

/**
 * The tab menu and the menu of a multi-selection (src/main/tabs/menus.ts). Only items that do what
 * the key does: ⌘W and ⌘⇧C act on every selected tab, as Close 3 Tabs and Copy Links do, but the
 * Markdown copy key copies one link.
 */
export const TAB_MENU_KEYS: KeyHints = [
  ['Pin Tab', 'tab.togglePin'],
  ['Unpin Tab', 'tab.togglePin'],
  ['Add to Favorites', 'tab.favorite'],
  ['Reset to Pinned URL', 'tab.resetToPinned'],
  ['Rename…', 'tab.rename'],
  ['Copy Link', 'tab.copyUrl'],
  ['Copy Links', 'tab.copyUrl'],
  ['Copy Link as Markdown', 'tab.copyUrlMarkdown'],
  ['Duplicate', 'tab.duplicate'],
  ['Mute Tab', 'tab.toggleMute'],
  ['Unmute Tab', 'tab.toggleMute'],
  ['Close Tab', 'tab.close'],
  [/^Close \d+ Tabs$/, 'tab.close'],
]

/**
 * The page menu (src/main/tabs/context-menu.ts, src/main/nav/page-menu.ts). Copy Page URL copies
 * the address as it is, and the Copy URL key copies it without tracking parameters, so it gets no hint.
 */
export const PAGE_MENU_KEYS: KeyHints = [
  ['Back', 'nav.back'],
  ['Forward', 'nav.forward'],
  ['Reload', 'nav.reload'],
  ['Save Page As…', 'page.save'],
  ['Print…', 'page.print'],
  ['View Page Source', 'page.viewSource'],
]

/** A split pane's menu (src/main/split/index.ts): its items do to that pane what the keys do to the focused one. */
export const SPLIT_PANE_MENU_KEYS: KeyHints = [
  ['Add Split Right', 'split.addRight'],
  ['Add Split Left', 'split.addLeft'],
  ['Add Split Above', 'split.addAbove'],
  ['Add Split Below', 'split.addBelow'],
  ['Flip Orientation', 'split.flip'],
  ['Equalize Sizes', 'split.equalize'],
  ['Separate Tabs', 'split.separate'],
  ['Close Pane', 'split.close'],
]

/** The hints of the menu built last, as "Label=Accelerator" (tests). */
let lastHints: string[] = []

/** The action an item's label names in `hints`, if any. */
function actionOf(label: string, hints: KeyHints): string | undefined {
  return hints.find(([match]) => (typeof match === 'string' ? match === label : match.test(label)))?.[1]
}

/**
 * The menu with each item that `hints` names showing its action's first key now. An item with a
 * role or an accelerator of its own keeps it; submenus are looked through too.
 */
export function withKeyHints(
  items: MenuItemConstructorOptions[],
  hints: KeyHints,
  platform: string = process.platform,
): MenuItemConstructorOptions[] {
  const shown: string[] = []
  const walk = (list: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
    list.map((item) => {
      const submenu = Array.isArray(item.submenu) ? walk(item.submenu) : item.submenu
      const actionId =
        item.label && !item.role && item.accelerator === undefined ? actionOf(item.label, hints) : undefined
      const action = actionId ? ACTIONS_BY_ID[actionId] : undefined
      const key = action ? shortcutsFor(action, platform)[0] : undefined
      const next = submenu === item.submenu ? item : { ...item, submenu }
      if (!key) return next
      const accelerator = toElectronAccelerator(key)
      shown.push(`${item.label}=${accelerator}`)
      return { ...next, accelerator, registerAccelerator: false }
    })
  const out = walk(items)
  lastHints = shown
  return out
}

/** The hints of the menu built last (tests). */
export function lastMenuHints(): string[] {
  return lastHints
}
