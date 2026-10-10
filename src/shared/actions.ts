/**
 * User-facing actions: things a person can trigger from a keyboard shortcut,
 * the app menu or the command bar. Handlers live in the main process
 * (src/main/actions.ts registry); each feature registers its own.
 *
 * Shortcuts use accelerator strings: modifiers Cmd, Ctrl, Alt, Shift joined by
 * "+" with a key name (A-Z, 0-9, [ ] , . / ; ' ` - = \, Left Right Up Down,
 * Tab Enter Escape Backspace Delete Space F1-F12 Home End PageUp PageDown).
 * `mac` applies on macOS and `other` on Linux/Windows.
 *
 * The final shortcut set follows spec/keyboard-shortcuts.md (KS-* IDs).
 */

import { SETTINGS_ACTIONS, SETTINGS_LANE_ACTIONS } from './commands/settings'

export interface ActionDef {
  id: string
  title: string
  category: 'Tabs' | 'Navigation' | 'Sidebar' | 'Spaces' | 'Window' | 'Page' | 'Split View' | 'Developer' | 'App'
  mac?: string[]
  other?: string[]
  /** Hidden from the command bar's action list (e.g. numbered variants). */
  hidden?: boolean
  /** Extra search words for the command bar. */
  keywords?: string[]
}

const numbered = (
  prefix: string,
  title: (n: number) => string,
  category: ActionDef['category'],
  mac: (n: number) => string,
  other: (n: number) => string,
): ActionDef[] =>
  [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
    id: `${prefix}.${n}`,
    title: title(n),
    category,
    mac: [mac(n)],
    other: [other(n)],
    hidden: true,
  }))

export const ACTIONS: ActionDef[] = [
  // Tabs
  { id: 'tab.new', title: 'New Tab', category: 'Tabs', mac: ['Cmd+T'], other: ['Ctrl+T'] },
  { id: 'tab.close', title: 'Close Tab', category: 'Tabs', mac: ['Cmd+W'], other: ['Ctrl+W', 'Ctrl+F4'] },
  {
    id: 'tab.reopenClosed',
    title: 'Reopen Closed Tab',
    category: 'Tabs',
    mac: ['Cmd+Shift+T'],
    other: ['Ctrl+Shift+T'],
  },
  {
    id: 'tab.next',
    title: 'Next Tab',
    category: 'Tabs',
    mac: ['Cmd+Alt+Down', 'Cmd+Shift+]'],
    other: ['Ctrl+Alt+Down', 'Ctrl+PageDown'],
  },
  {
    id: 'tab.previous',
    title: 'Previous Tab',
    category: 'Tabs',
    mac: ['Cmd+Alt+Up', 'Cmd+Shift+['],
    other: ['Ctrl+Alt+Up', 'Ctrl+PageUp'],
  },
  {
    id: 'tab.recent',
    title: 'Switch to Recent Tab',
    category: 'Tabs',
    mac: ['Ctrl+Tab'],
    other: ['Ctrl+Tab'],
    hidden: true,
  },
  {
    id: 'tab.recentBack',
    title: 'Switch to Recent Tab (Back)',
    category: 'Tabs',
    mac: ['Ctrl+Shift+Tab', 'Ctrl+`'],
    other: ['Ctrl+Shift+Tab'],
    hidden: true,
  },
  { id: 'tab.togglePin', title: 'Pin / Unpin Tab', category: 'Tabs', mac: ['Cmd+D'], other: ['Ctrl+D'] },
  { id: 'tab.duplicate', title: 'Duplicate Tab', category: 'Tabs' },
  { id: 'tab.resetToPinned', title: 'Reset Tab', category: 'Tabs', keywords: ['pinned url', 'home', 'go back'] },
  {
    id: 'tab.favorite',
    title: 'Favorite This Tab',
    category: 'Tabs',
    keywords: ['add to favorites', 'move to favorites', 'unfavorite'],
  },
  {
    id: 'tab.copyUrl',
    title: 'Copy URL',
    category: 'Tabs',
    mac: ['Cmd+Shift+C'],
    other: ['Ctrl+Shift+C'],
    keywords: ['link', 'share'],
  },
  {
    id: 'tab.copyUrlMarkdown',
    title: 'Copy URL as Markdown',
    category: 'Tabs',
    mac: ['Cmd+Shift+Alt+C'],
    other: ['Ctrl+Shift+Alt+C'],
    keywords: ['link'],
  },
  {
    id: 'tab.pasteAsNewTab',
    title: 'Paste URL as New Tab',
    category: 'Tabs',
    mac: ['Cmd+Alt+V'],
    other: ['Ctrl+Alt+V'],
    keywords: ['clipboard'],
  },
  { id: 'tab.undo', title: 'Undo Sidebar Change', category: 'Tabs', keywords: ['undo', 'reopen'] },
  {
    id: 'pinned.toggleCollapsed',
    title: 'Collapse / Expand Pinned',
    category: 'Sidebar',
    keywords: ['collapse pinned', 'expand pinned'],
  },
  {
    id: 'sidebar.focus',
    title: 'Focus Sidebar',
    category: 'Sidebar',
    mac: ['Cmd+Shift+E'],
    other: ['Ctrl+Shift+E'],
    keywords: ['keyboard'],
  },
  { id: 'tab.toggleMute', title: 'Mute / Unmute Tab', category: 'Tabs', keywords: ['audio', 'sound'] },
  {
    // In a Mini Window the same keys move its page into the most recent Space (MW-05).
    id: 'peek.expand',
    title: 'Open Peek as Tab',
    category: 'Tabs',
    mac: ['Cmd+O'],
    other: ['Ctrl+O'],
    keywords: ['expand', 'preview', 'mini window', 'move to space'],
  },
  {
    id: 'tabs.clearToday',
    title: 'Clear Today Tabs',
    category: 'Tabs',
    mac: ['Cmd+Shift+K'],
    other: ['Ctrl+Shift+K'],
    keywords: ['archive', 'close unpinned'],
  },
  {
    id: 'folder.new',
    title: 'New Folder',
    category: 'Tabs',
    mac: ['Cmd+Alt+Shift+N'],
    other: ['Ctrl+Alt+Shift+N'],
  },
  ...numbered(
    'tab.goto',
    (n) => (n === 9 ? 'Go to Last Tab' : `Go to Tab ${n}`),
    'Tabs',
    (n) => `Cmd+${n}`,
    (n) => `Ctrl+${n}`,
  ),

  // Navigation & page
  { id: 'url.edit', title: 'Edit URL', category: 'Navigation', mac: ['Cmd+L'], other: ['Ctrl+L', 'Alt+D'] },
  { id: 'nav.back', title: 'Back', category: 'Navigation', mac: ['Cmd+['], other: ['Alt+Left'] },
  { id: 'nav.forward', title: 'Forward', category: 'Navigation', mac: ['Cmd+]'], other: ['Alt+Right'] },
  { id: 'nav.reload', title: 'Reload Page', category: 'Navigation', mac: ['Cmd+R'], other: ['Ctrl+R', 'F5'] },
  {
    id: 'nav.hardReload',
    title: 'Hard Reload',
    category: 'Navigation',
    mac: ['Cmd+Shift+R'],
    other: ['Ctrl+Shift+R', 'Ctrl+F5'],
  },
  { id: 'nav.stop', title: 'Stop Loading', category: 'Navigation', mac: ['Cmd+.'], other: [] },
  { id: 'page.find', title: 'Find in Page', category: 'Page', mac: ['Cmd+F'], other: ['Ctrl+F'] },
  {
    id: 'page.zoomIn',
    title: 'Zoom In',
    category: 'Page',
    mac: ['Cmd+=', 'Cmd+Shift+='],
    // Ctrl+Shift+= adds a split pane on Windows/Linux (split-view.md SV-02).
    other: ['Ctrl+='],
  },
  { id: 'page.zoomOut', title: 'Zoom Out', category: 'Page', mac: ['Cmd+-'], other: ['Ctrl+-'] },
  { id: 'page.zoomReset', title: 'Actual Size', category: 'Page', mac: ['Cmd+0'], other: ['Ctrl+0'] },
  { id: 'page.print', title: 'Print…', category: 'Page', mac: ['Cmd+P'], other: ['Ctrl+P'] },
  // Media (media lane, MD-02, MD-08)
  {
    id: 'media.togglePip',
    title: 'Picture in Picture',
    category: 'Page',
    keywords: ['pip', 'video', 'float', 'floating'],
  },
  {
    id: 'media.toggleAutoPip',
    title: 'Turn Automatic Picture in Picture On or Off',
    category: 'Page',
    keywords: ['pip', 'video', 'auto'],
  },
  { id: 'page.viewSource', title: 'View Source', category: 'Developer', mac: ['Cmd+Alt+U'], other: ['Ctrl+U'] },
  {
    id: 'devtools.toggle',
    title: 'Developer Tools',
    category: 'Developer',
    mac: ['Cmd+Alt+I'],
    other: ['Ctrl+Shift+I', 'F12'],
    keywords: ['inspect', 'console'],
  },

  // Sidebar & window
  { id: 'sidebar.toggle', title: 'Toggle Sidebar', category: 'Sidebar', mac: ['Cmd+S'], other: ['Ctrl+S'] },
  { id: 'window.new', title: 'New Window', category: 'Window', mac: ['Cmd+N'], other: ['Ctrl+N'] },
  {
    id: 'window.newMini',
    title: 'New Mini Window',
    category: 'Window',
    mac: ['Cmd+Alt+N'],
    other: ['Ctrl+Alt+N'],
  },
  {
    id: 'mini.chooseSpace',
    title: 'Open Mini Window Page in Space…',
    category: 'Window',
    mac: ['Cmd+Alt+O', 'Cmd+Shift+O'],
    other: ['Ctrl+Alt+O'],
    keywords: ['move', 'triage'],
  },
  { id: 'mini.toggleAll', title: 'Show / Hide All Mini Windows', category: 'Window' },
  {
    id: 'window.newPrivate',
    title: 'New Private Window',
    category: 'Window',
    mac: ['Cmd+Shift+N'],
    other: ['Ctrl+Shift+N'],
    keywords: ['incognito'],
  },
  {
    id: 'app.settings',
    title: 'Settings',
    category: 'App',
    mac: ['Cmd+,'],
    other: ['Ctrl+,'],
    keywords: ['preferences'],
  },
  {
    id: 'app.archive',
    title: 'View Archive',
    category: 'App',
    keywords: ['archive', 'archived tabs', 'closed tabs', 'library'],
  },
  {
    id: 'app.library',
    title: 'Open Library',
    category: 'App',
    mac: ['Cmd+Shift+L'],
    keywords: ['library', 'archive', 'downloads', 'media'],
  },
  // Every page visit of the profile, in the Library (AR-10).
  {
    id: 'app.history',
    title: 'View History',
    category: 'App',
    mac: ['Cmd+Y'],
    other: ['Ctrl+H'],
    keywords: ['history', 'browsing history', 'visited pages'],
  },
  // Help → Restore Data… and the command bar: sidebar backups in the Library (AR-11).
  {
    id: 'app.restoreData',
    title: 'Restore Data…',
    category: 'App',
    keywords: ['backup', 'backups', 'snapshot', 'restore sidebar', 'recover tabs', 'lost tab'],
  },
  // Asks first; browsing history is kept (AR-07).
  {
    id: 'archive.clear',
    title: 'Clear Archive…',
    category: 'App',
    keywords: ['clear archive', 'delete archived tabs', 'empty archive'],
  },

  // Spaces
  { id: 'space.new', title: 'New Space', category: 'Spaces', keywords: ['create space'] },
  { id: 'space.rename', title: 'Rename Space', category: 'Spaces' },
  {
    id: 'space.theme',
    title: 'Edit Theme',
    category: 'Spaces',
    keywords: ['theme', 'colour', 'color', 'gradient', 'dark mode', 'light mode'],
  },
  { id: 'space.changeIcon', title: 'Change Space Icon', category: 'Spaces', keywords: ['emoji'] },
  { id: 'space.delete', title: 'Delete Space…', category: 'Spaces', keywords: ['remove space'] },
  {
    id: 'space.next',
    title: 'Next Space',
    category: 'Spaces',
    mac: ['Cmd+Alt+Right'],
    other: ['Ctrl+Alt+Right'],
  },
  {
    id: 'space.previous',
    title: 'Previous Space',
    category: 'Spaces',
    mac: ['Cmd+Alt+Left'],
    other: ['Ctrl+Alt+Left'],
  },
  ...numbered(
    'space.goto',
    (n) => `Switch to Space ${n}`,
    'Spaces',
    (n) => `Ctrl+${n}`,
    (n) => `Alt+${n}`,
  ),

  // Split view (split-view.md SV-*)
  {
    id: 'split.add',
    title: 'New Split View',
    category: 'Split View',
    mac: ['Ctrl+Shift+='],
    other: ['Ctrl+Shift+='],
    keywords: ['split', 'side by side', 'pane', 'add split'],
  },
  { id: 'split.addRight', title: 'Add Split Right', category: 'Split View', keywords: ['split', 'pane'] },
  { id: 'split.addLeft', title: 'Add Split Left', category: 'Split View', keywords: ['split', 'pane'] },
  { id: 'split.addAbove', title: 'Add Split Above', category: 'Split View', keywords: ['split', 'pane', 'top'] },
  { id: 'split.addBelow', title: 'Add Split Below', category: 'Split View', keywords: ['split', 'pane', 'bottom'] },
  {
    id: 'split.close',
    title: 'Close Split Pane',
    category: 'Split View',
    mac: ['Ctrl+Shift+-'],
    other: ['Ctrl+Shift+-'],
    keywords: ['split'],
  },
  {
    id: 'split.flip',
    title: 'Flip Split Orientation',
    category: 'Split View',
    keywords: ['split', 'rotate', 'stacked', 'side by side'],
  },
  { id: 'split.separate', title: 'Separate Split Tabs', category: 'Split View', keywords: ['split', 'unsplit'] },
  { id: 'split.equalize', title: 'Equalize Split Panes', category: 'Split View', keywords: ['split', 'resize'] },
  {
    id: 'split.focusNext',
    title: 'Focus Next Split Pane',
    category: 'Split View',
    mac: ['Ctrl+Shift+]'],
    other: ['Ctrl+Shift+]'],
    keywords: ['split'],
  },
  {
    id: 'split.focusPrevious',
    title: 'Focus Previous Split Pane',
    category: 'Split View',
    mac: ['Ctrl+Shift+['],
    other: ['Ctrl+Shift+['],
    keywords: ['split'],
  },
  ...[1, 2, 3, 4].map(
    (n): ActionDef => ({
      id: `split.focus.${n}`,
      title: `Focus Split Pane ${n}`,
      category: 'Split View',
      mac: [`Ctrl+Shift+${n}`],
      other: [`Ctrl+Shift+${n}`],
      hidden: true,
    }),
  ),

  // Settings sections and common settings (ST-02); onboarding, updates and help
  ...SETTINGS_ACTIONS,
  ...SETTINGS_LANE_ACTIONS,
]

export const ACTIONS_BY_ID: Record<string, ActionDef> = Object.fromEntries(ACTIONS.map((a) => [a.id, a]))

export function shortcutsFor(action: ActionDef, platform: string): string[] {
  return (platform === 'darwin' ? action.mac : action.other) ?? []
}

// ---- Accelerator matching ----

export interface KeyInput {
  key: string
  code: string
  meta: boolean
  control: boolean
  alt: boolean
  shift: boolean
}

const CODE_NAMES: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  NumpadAdd: '=',
  NumpadSubtract: '-',
  NumpadEnter: 'Enter',
}

/** Shifted ASCII symbols (US positions) → the unshifted key they share, so "Cmd+Shift+=" matches "+". */
const SHIFTED_SYMBOLS: Record<string, string> = {
  '+': '=',
  _: '-',
  '{': '[',
  '}': ']',
  '<': ',',
  '>': '.',
  '?': '/',
  ':': ';',
  '"': "'",
  '~': '`',
  '|': '\\',
}
const ASCII_SYMBOL = /^[!-/:-@[-`{-~]$/

/**
 * Key name for an input, matched against accelerator keys. Like Chrome:
 *  - letters follow the keyboard layout (`key`), so AZERTY's Cmd+Z is undo, not the physical W key;
 *  - digits use the physical key (`code`), so AZERTY's unshifted digit row still selects tabs;
 *  - ASCII symbols follow the layout too (Dvorak's "." sits on the physical E key);
 *  - anything else (macOS Option combos, Cyrillic and other non-Latin layouts, dead keys) falls
 *    back to the physical key, so Cmd+Option+V or Ctrl+T on a Russian layout still work.
 */
export function keyName(input: Pick<KeyInput, 'key' | 'code'>): string {
  const { code, key } = input
  if (/^[a-z]$/i.test(key)) return key.toUpperCase()
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5)
  if (code.startsWith('Numpad') && code.length === 7 && /\d/.test(code[6] ?? '')) return code.slice(6)
  if (ASCII_SYMBOL.test(key)) return SHIFTED_SYMBOLS[key] ?? key
  if (code.startsWith('Key') && code.length === 4) return code.slice(3)
  if (CODE_NAMES[code]) return CODE_NAMES[code] as string
  if (key === ' ') return 'Space'
  return key.length === 1 ? key.toUpperCase() : key
}

export interface ParsedAccelerator {
  cmd: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  key: string
}

export function parseAccelerator(accel: string): ParsedAccelerator {
  const parts = accel.split('+')
  // "Cmd+=" style keys are never "+" themselves; a trailing empty part means the key was "+".
  const key = parts.pop() || '+'
  const mods = new Set(parts.map((p) => p.toLowerCase()))
  return {
    cmd: mods.has('cmd') || mods.has('command') || mods.has('meta'),
    ctrl: mods.has('ctrl') || mods.has('control'),
    alt: mods.has('alt') || mods.has('option'),
    shift: mods.has('shift'),
    key: key.length === 1 ? key.toUpperCase() : key,
  }
}

export function matchesAccelerator(input: KeyInput, accel: string): boolean {
  const a = parseAccelerator(accel)
  return (
    a.cmd === input.meta &&
    a.ctrl === input.control &&
    a.alt === input.alt &&
    a.shift === input.shift &&
    a.key === keyName(input)
  )
}

/** Returns the action bound to this key press on the given platform, if any. */
export function actionForInput(input: KeyInput, platform: string): ActionDef | undefined {
  for (const action of ACTIONS) {
    for (const accel of shortcutsFor(action, platform)) {
      if (matchesAccelerator(input, accel)) return action
    }
  }
  return undefined
}

/** Display form of an accelerator, e.g. "⌘⇧T" on macOS or "Ctrl+Shift+T" elsewhere. */
export function formatAccelerator(accel: string, platform: string): string {
  const a = parseAccelerator(accel)
  const keyLabel = (
    { Left: '←', Right: '→', Up: '↑', Down: '↓', Enter: '↩', Escape: 'Esc', Space: 'Space' } as Record<string, string>
  )[a.key]
  if (platform === 'darwin') {
    return `${a.ctrl ? '⌃' : ''}${a.alt ? '⌥' : ''}${a.shift ? '⇧' : ''}${a.cmd ? '⌘' : ''}${keyLabel ?? a.key}`
  }
  return [a.ctrl && 'Ctrl', a.alt && 'Alt', a.shift && 'Shift', a.cmd && 'Meta', keyLabel ?? a.key]
    .filter(Boolean)
    .join('+')
}

/** Electron menu accelerator form ("CommandOrControl" etc.). */
export function toElectronAccelerator(accel: string): string {
  const a = parseAccelerator(accel)
  const key = a.key === '=' ? '=' : a.key === '+' ? 'Plus' : a.key
  return [a.cmd && 'Command', a.ctrl && 'Control', a.alt && 'Alt', a.shift && 'Shift', key].filter(Boolean).join('+')
}
