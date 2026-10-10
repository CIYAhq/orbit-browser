import { ACTIONS_BY_ID, formatAccelerator, shortcutsFor } from '../../../shared/actions'

/**
 * The keyboard shortcut sheet (OB-12): the essential shortcuts, grouped as Everyday, Navigation,
 * Spaces and Split View, with the keys they have now (KS-18). Pure, so it is unit-tested; the
 * full, editable list is Settings → Shortcuts (ST-08).
 */

/** One line of the sheet: one action, a pair ("Next / Previous Space") or a numbered run ("Go to Tab 1–8"). */
type Line =
  | { title?: string; action: string }
  | { title: string; pair: readonly [string, string] }
  | { title: string; run: readonly [string, string] }

const SHEET: readonly { title: string; lines: readonly Line[] }[] = [
  {
    title: 'Everyday',
    lines: [
      { title: 'New Tab or Search', action: 'tab.new' },
      { action: 'tab.close' },
      { action: 'tab.reopenClosed' },
      { action: 'sidebar.toggle' },
      { action: 'tab.togglePin' },
      { action: 'tab.copyUrl' },
      { action: 'page.find' },
      { action: 'window.new' },
      { action: 'window.newMini' },
      { action: 'app.settings' },
    ],
  },
  {
    title: 'Navigation',
    lines: [
      { action: 'url.edit' },
      { title: 'Back / Forward', pair: ['nav.back', 'nav.forward'] },
      { action: 'nav.reload' },
      { action: 'tab.recent' },
      { title: 'Next / Previous Tab', pair: ['tab.next', 'tab.previous'] },
      { title: 'Go to Tab 1–8', run: ['tab.goto.1', 'tab.goto.8'] },
      { action: 'tab.goto.9' },
    ],
  },
  {
    title: 'Spaces',
    lines: [
      { title: 'Next / Previous Space', pair: ['space.next', 'space.previous'] },
      { title: 'Switch to Space 1–9', run: ['space.goto.1', 'space.goto.9'] },
    ],
  },
  {
    title: 'Split View',
    lines: [
      { action: 'split.add' },
      { action: 'split.close' },
      { title: 'Next / Previous Pane', pair: ['split.focusNext', 'split.focusPrevious'] },
      { title: 'Focus Pane 1–4', run: ['split.focus.1', 'split.focus.4'] },
    ],
  },
]

export interface SheetRow {
  title: string
  /** The keys as this platform shows them ("⌘T", "⌘1–⌘8", "⌘⌥→ / ⌘⌥←"); '' when there are none. */
  keys: string
}

export interface SheetGroup {
  title: string
  rows: SheetRow[]
}

export interface SheetOptions {
  /** ⌘9 goes to the last item (Go to Last Tab) or the ninth (Go to Tab 9) (TB-04). */
  lastTabOnCmd9: boolean
}

/** The sheet as it is now: each line's title and the first key of each of its actions. */
export function sheetGroups(platform: string, options: SheetOptions): SheetGroup[] {
  const key = (id: string) => {
    const action = ACTIONS_BY_ID[id]
    const accel = action ? shortcutsFor(action, platform)[0] : undefined
    return accel ? formatAccelerator(accel, platform) : ''
  }
  const row = (line: Line): SheetRow => {
    if ('action' in line) {
      const title =
        line.action === 'tab.goto.9' && !options.lastTabOnCmd9
          ? 'Go to Tab 9'
          : (line.title ?? ACTIONS_BY_ID[line.action]?.title ?? line.action)
      return { title, keys: key(line.action) }
    }
    if ('pair' in line) {
      const keys = line.pair.map(key)
      return { title: line.title, keys: keys.some(Boolean) ? keys.map((k) => k || '—').join(' / ') : '' }
    }
    const [first, last] = line.run.map(key)
    return { title: line.title, keys: first && last ? `${first}–${last}` : '' }
  }
  return SHEET.map((group) => ({ title: group.title, rows: group.lines.map(row) }))
}
