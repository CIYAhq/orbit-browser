import {
  ACTIONS,
  type ActionDef,
  defaultPriorityFor,
  defaultShortcutsFor,
  formatAccelerator,
  priorityFor,
  shortcutsFor,
} from '../../../shared/actions'
import type { ShortcutPriority, SystemClash } from '../../../shared/commands/keys'
import { canonicalAccelerator } from '../../../shared/keymap'

/**
 * What Settings → Shortcuts lists (ST-08): every action with its bindings as they are now, in
 * groups, and the search that filters them. Pure, so it is unit-tested.
 */

/** The list's groups, in order. */
export const CATEGORY_ORDER: readonly ActionDef['category'][] = [
  'Tabs',
  'Navigation',
  'Page',
  'Sidebar',
  'Spaces',
  'Split View',
  'Window',
  'Developer',
  'App',
]

export interface ShortcutEntry {
  action: ActionDef
  /** The name the list shows. */
  title: string
  /** The action's bindings now, written as `canonicalAccelerator` writes them. */
  bindings: string[]
  /** Who gets the keys first when a page also uses them (KS-02). */
  priority: ShortcutPriority
  /** Bindings and priority are what Orbit ships. */
  isDefault: boolean
}

export interface ShortcutGroup {
  category: ActionDef['category']
  entries: ShortcutEntry[]
}

export interface ListOptions {
  /** The user's priorities (`settings.shortcutPriority`). */
  priorities?: Readonly<Record<string, ShortcutPriority>>
  /** ⌘9 goes to the last item (Go to Last Tab) or the ninth (Go to Tab 9). */
  lastTabOnCmd9: boolean
}

const canon = (list: readonly string[]): string[] =>
  list.map((a) => canonicalAccelerator(a)).filter((a): a is string => a !== undefined)

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** The name an action has in the list. */
export function shortcutTitle(action: ActionDef, options: Pick<ListOptions, 'lastTabOnCmd9'>): string {
  if (action.id === 'tab.goto.9' && !options.lastTabOnCmd9) return 'Go to Tab 9'
  return action.title
}

/** One action's row as it is now. */
export function shortcutEntry(action: ActionDef, platform: string, options: ListOptions): ShortcutEntry {
  const bindings = canon(shortcutsFor(action, platform))
  const priority = priorityFor(action, platform, options.priorities)
  return {
    action,
    title: shortcutTitle(action, options),
    bindings,
    priority,
    isDefault:
      sameList(bindings, canon(defaultShortcutsFor(action, platform))) &&
      priority === defaultPriorityFor(action, platform),
  }
}

/** Every action, in its group, in the order the action table lists them. */
export function shortcutGroups(platform: string, options: ListOptions, actions = ACTIONS): ShortcutGroup[] {
  const byCategory = new Map<ActionDef['category'], ShortcutEntry[]>()
  for (const action of actions) {
    const list = byCategory.get(action.category) ?? []
    list.push(shortcutEntry(action, platform, options))
    byCategory.set(action.category, list)
  }
  return CATEGORY_ORDER.flatMap((category) => {
    const entries = byCategory.get(category)
    return entries?.length ? [{ category, entries }] : []
  })
}

/** The words of a search, lower case. */
export function searchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * Whether a row matches every word typed: its name, group and search words, and its keys as this
 * platform shows them ("⌘S", "Ctrl+S") or writes them ("cmd+s").
 */
export function entryMatches(entry: ShortcutEntry, words: readonly string[], platform: string): boolean {
  if (words.length === 0) return true
  const text = [
    entry.title,
    entry.action.category,
    ...(entry.action.keywords ?? []),
    ...entry.bindings.map((a) => formatAccelerator(a, platform)),
    ...entry.bindings,
  ]
    .join(' ')
    .toLowerCase()
  return words.every((w) => text.includes(w))
}

/** The modifiers held while recording ("Cmd+Shift") as this platform shows them: "⇧⌘" or "Ctrl+Shift+". */
export function formatModifiers(modifiers: string, platform: string): string {
  const held = new Set(modifiers.split('+').filter(Boolean))
  if (platform === 'darwin') {
    return `${held.has('Ctrl') ? '⌃' : ''}${held.has('Alt') ? '⌥' : ''}${held.has('Shift') ? '⇧' : ''}${held.has('Cmd') ? '⌘' : ''}`
  }
  const names = [
    held.has('Ctrl') && 'Ctrl',
    held.has('Alt') && 'Alt',
    held.has('Shift') && 'Shift',
    held.has('Cmd') && 'Meta',
  ]
  return names
    .filter(Boolean)
    .map((n) => `${n}+`)
    .join('')
}

/** The keys of a row that the system keeps for itself, with what has them (KS-03). */
export function clashesOf(entry: ShortcutEntry, clashes: readonly SystemClash[] | undefined): SystemClash[] {
  return (clashes ?? []).filter((c) => entry.bindings.includes(c.accel))
}
