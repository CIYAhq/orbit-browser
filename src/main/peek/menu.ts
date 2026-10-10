import type { MenuItemConstructorOptions } from 'electron'
import { isPrivateTab } from '../../shared/private'
import type { TabId } from '../../shared/state'
import type { MainContext } from '../context'
import { openMiniWindow } from '../miniwindow'
import { openLinkInPeek } from '.'

/**
 * Link context-menu items: "Open Link in Peek" (PK-03) and "Open Link in Mini Window" (MW-07).
 * A Peek or Mini Window page has no Peek of its own (PK-16).
 */
export function linkPeekMenuItems(ctx: MainContext, tabId: TabId, url: string): MenuItemConstructorOptions[] {
  if (!/^https?:/i.test(url)) return []
  // A private window has no Peek, and a Mini Window would take the link into a normal profile (NV-11).
  if (isPrivateTab(ctx.store.state, tabId)) return []
  const floating = ctx.store.state.tabs[tabId]?.floating
  const items: MenuItemConstructorOptions[] = []
  if (!floating) items.push({ label: 'Open Link in Peek', click: () => openLinkInPeek(tabId, url) })
  items.push({ label: 'Open Link in Mini Window', click: () => openMiniWindow(ctx, url) })
  return items
}
