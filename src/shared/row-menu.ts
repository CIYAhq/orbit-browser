/**
 * The sidebar's row menus (TB-14): a tab's, a pinned tab's, a Favorite's, a folder's, a
 * multi-selection's and a split row's right-click menu. Main builds the items; the overlay draws
 * them in the Space's colours (SP-16) and sends back the item chosen.
 */

/** The overlay panel that draws a row menu. */
export const ROW_MENU_PANEL = 'row-menu'

export interface RowMenuItem {
  /** Where the item is: its index in the menu, then in each submenu ("4.1.0"). */
  id: string
  label: string
  enabled: boolean
  /** A tick beside it. */
  checked?: boolean
  /** The key that does the same thing now, as the keymap has it (KS-18). */
  hint?: string
  submenu?: RowMenuEntry[]
}

export type RowMenuEntry = RowMenuItem | { id: string; separator: true }

export const isSeparator = (entry: RowMenuEntry): entry is { id: string; separator: true } => 'separator' in entry

/** Where the menu opens, in window coordinates: the pointer, or under the row's slot (keyboard). */
export interface RowMenuAt {
  x: number
  y: number
}

/** The model the overlay draws, kept in the window's overlay state while the menu is open. */
export interface RowMenuModel {
  /** Numbers each menu: a choice for a menu that has since closed is ignored. */
  menu: number
  /** The row the menu is for (its slot's `data-key`). */
  key: string
  label: string
  entries: RowMenuEntry[]
}

/** Labels of a model's items, submenus as "Parent > Child" (tests). */
export function rowMenuLabels(entries: RowMenuEntry[], prefix = ''): string[] {
  const out: string[] = []
  for (const entry of entries) {
    if (isSeparator(entry)) continue
    out.push(`${prefix}${entry.label}`)
    if (entry.submenu) out.push(...rowMenuLabels(entry.submenu, `${prefix}${entry.label} > `))
  }
  return out
}

/** The item at a label path ("Move to > Work > Pinned"). */
export function rowMenuItemAt(entries: RowMenuEntry[], path: string): RowMenuItem | undefined {
  let list: RowMenuEntry[] | undefined = entries
  let found: RowMenuItem | undefined
  for (const part of path.split(' > ')) {
    found = list?.find((e): e is RowMenuItem => !isSeparator(e) && e.label === part)
    if (!found) return undefined
    list = found.submenu
  }
  return found
}

/**
 * Type-ahead (TB-14): the next enabled item after `from` whose label starts with `typed`, wrapping
 * round; a single letter typed again moves on to the next item with that letter.
 */
export function typeAheadIndex(labels: { label: string; enabled: boolean }[], typed: string, from: number): number {
  const needle = typed.toLocaleLowerCase()
  if (!needle) return -1
  const n = labels.length
  const repeat = needle.length > 1 && [...needle].every((ch) => ch === needle[0])
  const match = repeat ? (needle[0] as string) : needle
  // A longer prefix may still match the item already focused; a single letter moves on.
  const start = match.length > 1 && !repeat ? Math.max(from, 0) : from + 1
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n
    const item = labels[i]
    if (item?.enabled && item.label.toLocaleLowerCase().startsWith(match)) return i
  }
  return -1
}
