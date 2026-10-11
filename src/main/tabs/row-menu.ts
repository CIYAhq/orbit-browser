import {
  webContents as allContents,
  Menu,
  type MenuItem,
  type MenuItemConstructorOptions,
  screen,
  type WebContents,
} from 'electron'
import { formatAccelerator } from '../../shared/keymap'
import {
  isSeparator,
  ROW_MENU_PANEL,
  type RowMenuAt,
  type RowMenuEntry,
  type RowMenuModel,
  rowMenuItemAt,
  rowMenuLabels,
} from '../../shared/row-menu'
import type { OverlayState, WindowId } from '../../shared/state'
import type { MainContext } from '../context'

/**
 * The sidebar's row menus in Orbit's overlay (TB-14), where they take the Space's colours (SP-16):
 * a tab's, a pinned tab's, a Favorite's, a folder's, a multi-selection's and a split row's. Main
 * builds the items as before (`menus.ts`, with the keys the keymap has now, KS-18) and keeps their
 * actions; the overlay draws the menu and sends back the item chosen. While a menu is open it takes
 * the keys first (KS-19): its own keys never reach the page, and a key bound to an Orbit action
 * closes the menu and does nothing else. When it closes, the keyboard goes back where it was (KS-16).
 *
 * While a Peek is open the overlay is the Peek's: it covers only the page area, under the Peek's
 * card, and the sidebar beside it stays usable without closing the Peek (PK-13). A row menu opened
 * then is the system's, as all of them were before, so the Peek stays.
 */

interface OpenMenu {
  windowId: WindowId
  model: RowMenuModel
  items: MenuItemConstructorOptions[]
  /** Where the keyboard was when the menu opened. */
  returnTo?: WebContents
  /** A system menu, shown while a Peek has the overlay (PK-13). */
  native?: boolean
}

export interface RowMenuInfo {
  key: string
  label: string
  labels: string[]
  enabled: Record<string, boolean>
  checked: Record<string, boolean>
  /** "Label=hint" for each item that shows a key. */
  hints: string[]
  /** The system's menu (a Peek has the overlay), not the overlay's. */
  native: boolean
}

export interface RowMenus {
  /** Opens a row menu over the window: at `at` (window coordinates), else at the pointer. */
  show(
    windowId: WindowId | undefined,
    items: MenuItemConstructorOptions[],
    opts: { key: string; label: string; at?: RowMenuAt; sender?: WebContents },
  ): void
  /** Runs the item at `id` ("4.1.0") of menu `menu`, if that menu is still open. */
  choose(windowId: WindowId | undefined, menu: number, id: string): boolean
  /** The open menu (tests). */
  info(windowId: WindowId | undefined): RowMenuInfo | null
  /** Chooses an item by its label path, as a click in the menu does (tests). */
  chooseByLabel(windowId: WindowId | undefined, path: string): boolean
}

let instance: RowMenus | undefined

/** For other areas' row menus (the split row, SV-*): shows `items` as a row menu. */
export function showRowMenu(
  windowId: WindowId | undefined,
  items: MenuItemConstructorOptions[],
  opts: { key: string; label: string; at?: RowMenuAt; sender?: WebContents },
): void {
  instance?.show(windowId, items, opts)
}

/** The row menu a window's overlay state shows, if any. */
export function rowMenuOf(overlay: OverlayState | undefined): RowMenuModel | undefined {
  if (overlay?.kind !== 'panel' || overlay.panel !== ROW_MENU_PANEL) return undefined
  const json = overlay.params?.model
  if (typeof json !== 'string') return undefined
  try {
    return JSON.parse(json) as RowMenuModel
  } catch {
    return undefined
  }
}

/** The model's entries: separators only between items, hidden items left out. */
export function menuEntries(items: MenuItemConstructorOptions[], platform: string, prefix = ''): RowMenuEntry[] {
  const out: RowMenuEntry[] = []
  items.forEach((item, i) => {
    const id = prefix ? `${prefix}.${i}` : String(i)
    if (item.visible === false) return
    if (item.type === 'separator') {
      const last = out[out.length - 1]
      if (last && !isSeparator(last)) out.push({ id, separator: true })
      return
    }
    if (!item.label) return
    const submenu = Array.isArray(item.submenu) ? menuEntries(item.submenu, platform, id) : undefined
    const hint =
      typeof item.accelerator === 'string' && item.accelerator
        ? formatAccelerator(item.accelerator, platform)
        : undefined
    out.push({
      id,
      label: item.label,
      enabled: item.enabled !== false && (!submenu || submenu.some((e) => !isSeparator(e) && e.enabled)),
      ...(item.type === 'checkbox' || item.type === 'radio' ? { checked: !!item.checked } : {}),
      ...(hint ? { hint } : {}),
      ...(submenu ? { submenu } : {}),
    })
  })
  const last = out[out.length - 1]
  if (last && isSeparator(last)) out.pop()
  return out
}

/** The template item at an index path. */
function templateItemAt(items: MenuItemConstructorOptions[], id: string): MenuItemConstructorOptions | undefined {
  let list: MenuItemConstructorOptions[] | undefined = items
  let item: MenuItemConstructorOptions | undefined
  for (const part of id.split('.')) {
    item = list?.[Number(part)]
    if (!item) return undefined
    list = Array.isArray(item.submenu) ? item.submenu : undefined
  }
  return item
}

export function registerRowMenus(ctx: MainContext): RowMenus {
  const { store, commands, actions, windows } = ctx
  const open = new Map<WindowId, OpenMenu>()
  let menuNumber = 0

  /** Where a renderer's (0, 0) is in its window: the floating sidebar card sits over the page (SB-12). */
  const originOf = (windowId: WindowId, sender: WebContents | undefined) => {
    if (sender && sender === windows.floatingContents(windowId)) {
      const bounds = windows.floatingInfo(windowId).bounds
      if (bounds) return { x: bounds.x, y: bounds.y }
    }
    return { x: 0, y: 0 }
  }

  /** The pointer in the window's coordinates (a menu opened with no position given). */
  const pointerIn = (windowId: WindowId): RowMenuAt => {
    const win = windows.get(windowId)
    if (!win || win.isDestroyed()) return { x: 0, y: 0 }
    const content = win.getContentBounds()
    const p = screen.getCursorScreenPoint()
    return { x: Math.max(0, p.x - content.x), y: Math.max(0, p.y - content.y) }
  }

  const close = (windowId: WindowId) => {
    if (!open.has(windowId)) return
    open.delete(windowId)
    if (rowMenuOf(store.state.windows[windowId]?.overlay)) void commands.run('overlay.close', {}, { windowId })
  }

  // A menu goes when its overlay does (Escape, a click outside, another overlay), and the keyboard
  // goes back where it was (KS-16): the sidebar for a menu opened there, else the page.
  store.subscribe((next, prev) => {
    if (next.windows === prev.windows) return
    for (const [windowId, menu] of open) {
      if (menu.native) continue
      const shown = rowMenuOf(next.windows[windowId]?.overlay)
      if (shown?.menu === menu.model.menu) continue
      open.delete(windowId)
      const returnTo = menu.returnTo
      const win = windows.get(windowId)
      if (
        !shown &&
        next.windows[windowId]?.overlay.kind === 'none' &&
        returnTo &&
        !returnTo.isDestroyed() &&
        win &&
        !win.isDestroyed() &&
        win.isFocused()
      ) {
        returnTo.focus()
      }
    }
  })

  // KS-19: a key bound to an Orbit action closes the open menu and does nothing else (⌘W closes the
  // menu, not the tab under it). Nothing a menu item does is held back: choosing closes it first.
  actions.intercept((_id, c) => {
    const windowId = c.windowId ?? windows.focusedWindowId()
    const menu = windowId ? open.get(windowId) : undefined
    if (!windowId || !menu || menu.native) return false
    close(windowId)
    return true
  })

  const choose = (windowId: WindowId | undefined, menu: number, id: string): boolean => {
    if (!windowId) return false
    const current = open.get(windowId)
    if (!current || current.model.menu !== menu) return false
    const item = templateItemAt(current.items, id)
    if (!item || item.type === 'separator' || item.enabled === false || Array.isArray(item.submenu)) return false
    close(windowId)
    const win = windows.get(windowId)
    item.click?.({ checked: !item.checked } as MenuItem, win ?? undefined, {} as Electron.KeyboardEvent)
    return true
  }

  commands.register('rowMenu.choose', ({ menu, id }, c) => choose(c.windowId ?? windows.focusedWindowId(), menu, id))

  const api: RowMenus = {
    show(windowId, items, { key, label, at, sender }) {
      if (!windowId) return
      const entries = menuEntries(items, process.platform)
      if (entries.length === 0) return
      const origin = originOf(windowId, sender)
      const point = at ? { x: at.x + origin.x, y: at.y + origin.y } : pointerIn(windowId)
      const model: RowMenuModel = { menu: ++menuNumber, key, label, entries }
      if (store.state.windows[windowId]?.overlay.kind === 'peek') {
        const entry: OpenMenu = { windowId, model, items, native: true }
        open.set(windowId, entry)
        const win = windows.get(windowId)
        if (ctx.e2e || !win || win.isDestroyed()) return
        Menu.buildFromTemplate(items).popup({
          window: win,
          x: Math.round(point.x),
          y: Math.round(point.y),
          callback: () => {
            if (open.get(windowId) === entry) open.delete(windowId)
          },
        })
        return
      }
      // The overlay itself (a panel was open) gives the keyboard to the page when it closes.
      const focused = allContents.getFocusedWebContents()
      const returnTo =
        focused && !focused.getURL().includes('view=overlay') && windows.windowIdFor(focused) === windowId
          ? focused
          : undefined
      open.set(windowId, { windowId, model, items, returnTo })
      void commands.run(
        'overlay.open',
        {
          overlay: {
            kind: 'panel',
            panel: ROW_MENU_PANEL,
            params: { model: JSON.stringify(model), x: Math.round(point.x), y: Math.round(point.y), key },
          },
        },
        { windowId },
      )
    },
    choose,
    info(windowId) {
      const menu = windowId ? open.get(windowId) : undefined
      if (!menu) return null
      const enabled: Record<string, boolean> = {}
      const checked: Record<string, boolean> = {}
      const hints: string[] = []
      const walk = (entries: RowMenuEntry[], prefix: string) => {
        for (const e of entries) {
          if (isSeparator(e)) continue
          const path = `${prefix}${e.label}`
          enabled[path] = e.enabled
          if (e.checked !== undefined) checked[path] = e.checked
          if (e.hint) hints.push(`${path}=${e.hint}`)
          if (e.submenu) walk(e.submenu, `${path} > `)
        }
      }
      walk(menu.model.entries, '')
      return {
        key: menu.model.key,
        label: menu.model.label,
        labels: rowMenuLabels(menu.model.entries),
        enabled,
        checked,
        hints,
        native: !!menu.native,
      }
    },
    chooseByLabel(windowId, path) {
      const menu = windowId ? open.get(windowId) : undefined
      const item = menu ? rowMenuItemAt(menu.model.entries, path) : undefined
      return !!menu && !!item && choose(windowId, menu.model.menu, item.id)
    },
  }
  instance = api
  return api
}
