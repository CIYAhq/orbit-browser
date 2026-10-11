/**
 * User-facing actions: things a person can trigger from a keyboard shortcut,
 * the app menu or the command bar. Handlers live in the main process
 * (src/main/registry.ts ActionRegistry); each feature registers its own.
 *
 * This list is the one keymap (KS-01): each action's stable id, its title, and its default
 * shortcuts, `mac` on macOS and `other` on Linux/Windows (accelerator strings, see
 * src/shared/keymap.ts). The key router, the menus, tooltips, command-bar rows, the shortcut
 * sheet and Settings → Shortcuts all read an action's shortcuts through `shortcutsFor`, which
 * gives the user's own bindings where they changed them, so a remap reaches every one at once.
 *
 * The default set follows the KS-* tables of the shortcuts spec.
 */

import { IMPORT_ACTIONS } from './commands/import'
import type { ShortcutPriority } from './commands/keys'
import { SETTINGS_ACTIONS, SETTINGS_LANE_ACTIONS } from './commands/settings'
import {
  acceleratorFromInput,
  type CustomBindings,
  canonicalAccelerator,
  customBindings,
  editsText,
  type KeyInput,
  keymapVersion,
  typedWithAltGr,
} from './keymap'

export {
  formatAccelerator,
  type KeyInput,
  keyName,
  matchesAccelerator,
  type ParsedAccelerator,
  parseAccelerator,
  toElectronAccelerator,
} from './keymap'

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
  /**
   * Extra bindings that are text-editing keys inside a field (KS-16: ⌘← moves the caret to the
   * line start). They run the action only when keyboard focus is not in an editable field, so
   * they are matched separately (`outsideTextActionFor`), never by `actionForInput`.
   */
  macOutsideText?: string[]
  otherOutsideText?: string[]
  /**
   * The shortcuts can't be changed (KS-01 "fixed": OS conventions such as ⌘, for Settings, and keys
   * that belong to an overlay such as the recent-tab switcher's). Settings → Shortcuts shows them
   * without a way to record new ones. 'other': on Windows and Linux only (F1 for Help, KS-15).
   * Read it through `isFixed`.
   */
  fixed?: boolean | 'other'
  /**
   * KS-02 "prefer websites": when a page also handles one of the action's keys, the page gets the
   * first press, and pressing again within about a second runs the action. `true` on every
   * platform, 'other' on Windows and Linux only. Otherwise the action runs and the page never sees
   * the key ("prefer Orbit", the default). Users choose per action in Settings → Shortcuts.
   */
  preferWebsites?: boolean | 'other'
  /**
   * With "prefer Orbit", the keys still go first to a page whose text field has focus, and the
   * action runs unless that page uses them (Back and Forward's ⌘[ and ⌘], KS-16). Anywhere else
   * the action runs at once and the page never sees the key, however busy the page is. With
   * keyboard focus in a frame, the frame's own text field and handlers decide (D60).
   */
  pageFirstInFields?: boolean
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
    fixed: true,
  },
  {
    id: 'tab.recentBack',
    title: 'Switch to Recent Tab (Back)',
    category: 'Tabs',
    // ⌃` steps back too, on every platform, but only while the switcher is up: the key router's
    // (src/main/keys/router.ts `switcherKey`), so a page gets it the rest of the time (D60, TB-05).
    mac: ['Ctrl+Shift+Tab'],
    other: ['Ctrl+Shift+Tab'],
    hidden: true,
    fixed: true,
  },
  { id: 'tab.togglePin', title: 'Pin / Unpin Tab', category: 'Tabs', mac: ['Cmd+D'], other: ['Ctrl+D'] },
  { id: 'tab.duplicate', title: 'Duplicate Tab', category: 'Tabs' },
  // KS-05's assignable tab actions (no default keys).
  { id: 'tab.rename', title: 'Rename Tab', category: 'Tabs' },
  { id: 'tab.archive', title: 'Archive Tab', category: 'Tabs' },
  { id: 'tab.pickSpace', title: 'Move Tab to Space…', category: 'Tabs', keywords: ['move to', 'space'] },
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
    // NV-17: on Windows and Linux the page gets Ctrl+Shift+C first (KS-02).
    preferWebsites: 'other',
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
    // In a Mini Window the same keys move its page into the most recent Space (MW-05); in a
    // window with no Peek they open a file (KS-12, BORROWED_KEYS).
    id: 'peek.expand',
    title: 'Open Peek as Tab',
    category: 'Tabs',
    mac: ['Cmd+O'],
    other: ['Ctrl+O'],
    keywords: ['expand', 'preview', 'mini window', 'move to space'],
  },
  // Files from the disk in new tabs (KS-12): on Open Peek as Tab's keys where there is no Peek or
  // Mini Window, and keys of its own if given some.
  {
    id: 'file.open',
    title: 'Open File…',
    category: 'App',
    keywords: ['open file', 'local file', 'file from disk', 'browse files', 'html', 'pdf'],
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
  {
    id: 'nav.back',
    title: 'Back',
    category: 'Navigation',
    mac: ['Cmd+['],
    other: ['Alt+Left'],
    macOutsideText: ['Cmd+Left'],
    // A text field's page may use ⌘[ / Alt+← (an editor's outdent): it goes there first (KS-16).
    pageFirstInFields: true,
  },
  {
    id: 'nav.forward',
    title: 'Forward',
    category: 'Navigation',
    mac: ['Cmd+]'],
    other: ['Alt+Right'],
    macOutsideText: ['Cmd+Right'],
    // A text field's page may use ⌘] / Alt+→ (an editor's indent): it goes there first (KS-16).
    pageFirstInFields: true,
  },
  { id: 'nav.reload', title: 'Reload Page', category: 'Navigation', mac: ['Cmd+R'], other: ['Ctrl+R', 'F5'] },
  {
    id: 'nav.hardReload',
    title: 'Hard Reload',
    category: 'Navigation',
    mac: ['Cmd+Shift+R'],
    other: ['Ctrl+Shift+R', 'Shift+F5', 'Ctrl+F5'],
  },
  { id: 'nav.stop', title: 'Stop Loading', category: 'Navigation', mac: ['Cmd+.'], other: [] },
  { id: 'page.find', title: 'Find in Page', category: 'Page', mac: ['Cmd+F'], other: ['Ctrl+F'] },
  { id: 'page.findNext', title: 'Find Next', category: 'Page', mac: ['Cmd+G'], other: ['F3', 'Ctrl+G'] },
  {
    id: 'page.findPrevious',
    title: 'Find Previous',
    category: 'Page',
    mac: ['Cmd+Shift+G'],
    other: ['Shift+F3', 'Ctrl+Shift+G'],
  },
  // Scrolls the page to its selection (KS-08: macOS only, the Edit menu convention).
  { id: 'page.jumpToSelection', title: 'Jump to Selection', category: 'Page', mac: ['Cmd+J'], other: [] },
  {
    id: 'site.controls',
    title: 'Site Controls',
    category: 'Page',
    keywords: ['permissions', 'site settings', 'connection', 'zoom'],
  },
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
  // Pages lane (NV-21): ⌘S (Ctrl+S) is the sidebar's (SB-11), so ⇧⌘S everywhere.
  {
    id: 'page.save',
    title: 'Save Page As…',
    category: 'Page',
    mac: ['Cmd+Shift+S'],
    other: ['Ctrl+Shift+S'],
    keywords: ['download', 'html', 'mhtml', 'web archive'],
  },
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
    mac: ['Cmd+Alt+I', 'F12'],
    other: ['Ctrl+Shift+I', 'F12'],
    keywords: ['inspect', 'console'],
  },
  {
    id: 'devtools.console',
    title: 'JavaScript Console',
    category: 'Developer',
    mac: ['Cmd+Alt+J'],
    other: ['Ctrl+Shift+J'],
    keywords: ['developer tools', 'devtools'],
  },
  // The element picker. ⇧⌘C / Ctrl+Shift+C stays Copy URL (DT-02); it can be remapped here.
  {
    id: 'devtools.inspect',
    title: 'Inspect Element',
    category: 'Developer',
    mac: ['Cmd+Alt+C'],
    other: [],
    keywords: ['developer tools', 'devtools', 'select an element', 'picker'],
  },

  // Sidebar & window
  {
    id: 'sidebar.toggle',
    title: 'Toggle Sidebar',
    category: 'Sidebar',
    mac: ['Cmd+S'],
    other: ['Ctrl+S'],
    // SB-11: a web editor's Ctrl+S gets the first press on Windows and Linux (KS-02). On macOS ⌘S
    // prefers Orbit, as every other action does there; people can change it per action (D60).
    preferWebsites: 'other',
  },
  { id: 'window.new', title: 'New Window', category: 'Window', mac: ['Cmd+N'], other: ['Ctrl+N'] },
  // Alt+F4 closes the window too, as the system's key (KS-05).
  { id: 'window.close', title: 'Close Window', category: 'Window', mac: ['Cmd+Shift+W'], other: ['Ctrl+Shift+W'] },
  {
    // NV-20. On macOS fn+F (Globe+F) does it too: the system's key, which never reaches Orbit.
    id: 'window.toggleFullScreen',
    title: 'Toggle Full Screen',
    category: 'Window',
    mac: ['Cmd+Ctrl+F'],
    other: ['F11', 'Alt+Shift+F'],
    keywords: ['full screen', 'fullscreen', 'enter full screen', 'exit full screen', 'presentation'],
  },
  {
    // Esc in a page leaves full screen (NV-20): pressed twice within about a second, or held; the
    // page gets the first press (KS-02, D68). Esc is no binding of it: an overlay's Esc closes the
    // overlay first (KS-19), so the rule lives with the page (src/main/pages/fullscreen.ts). Settings
    // → Shortcuts sets its priority, and can give it keys of its own.
    id: 'window.exitFullScreen',
    title: 'Exit Full Screen',
    category: 'Window',
    hidden: true,
    preferWebsites: true,
    keywords: ['esc', 'escape', 'hold esc', 'press esc twice', 'leave full screen', 'fullscreen'],
  },
  {
    // Keyboard focus between the sidebar and the page (KS-05, SB-22).
    id: 'focus.cycle',
    title: 'Move Focus Between Sidebar and Page',
    category: 'Sidebar',
    mac: ['F6'],
    other: ['F6'],
    keywords: ['keyboard', 'accessibility', 'focus sidebar', 'focus page'],
  },
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
    // An OS convention (KS-12).
    fixed: true,
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
  // Downloads (DL-14, KS-12): the Library's Downloads section on macOS, the downloads flyout elsewhere.
  {
    id: 'app.downloads',
    title: 'Downloads',
    category: 'App',
    mac: ['Cmd+Shift+J', 'Cmd+Alt+L'],
    other: ['Ctrl+J'],
    keywords: ['open downloads', 'downloaded files', 'library'],
  },
  // Every page visit of the profile, as a page in a tab (AR-10, orbit://history/).
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
  // Help → Keyboard Shortcuts: the essential shortcuts (OB-12); the full list is Settings → Shortcuts.
  {
    id: 'help.shortcuts',
    title: 'Keyboard Shortcuts',
    category: 'App',
    keywords: ['shortcut sheet', 'cheat sheet', 'essential shortcuts', 'keys', 'hotkeys', 'help'],
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
  ...IMPORT_ACTIONS,
]

export const ACTIONS_BY_ID: Record<string, ActionDef> = Object.fromEntries(ACTIONS.map((a) => [a.id, a]))

/**
 * Actions that also run on another action's keys where that one has nothing to act on (KS-12):
 * Open File on Open Peek as Tab's ⌘O / Ctrl+O in a window with no Peek or Mini Window. The key
 * router picks between them (src/main/keys/open-file.ts); menus and Settings show the keys.
 */
export const BORROWED_KEYS: Readonly<Record<string, { from: string; where: string }>> = {
  'file.open': { from: 'peek.expand', where: 'where no Peek or Mini Window is open' },
}

/** The action's shortcuts as Orbit ships them (KS-03): `mac` on macOS, `other` elsewhere. */
export function defaultShortcutsFor(action: ActionDef, platform: string): string[] {
  const mac = platform === 'darwin'
  return [
    ...((mac ? action.mac : action.other) ?? []),
    ...((mac ? action.macOutsideText : action.otherOutsideText) ?? []),
  ]
}

/** Whether the action's shortcuts can't be changed on this platform (KS-01, KS-15). */
export function isFixed(action: ActionDef, platform: string): boolean {
  return action.fixed === true || (action.fixed === 'other' && platform !== 'darwin')
}

/** Who gets the action's keys first by default when a page also handles them (KS-02). */
export function defaultPriorityFor(action: ActionDef, platform: string): ShortcutPriority {
  const prefer = action.preferWebsites
  return prefer === true || (prefer === 'other' && platform !== 'darwin') ? 'websites' : 'orbit'
}

/** Who gets the action's keys first: the user's choice (`settings.shortcutPriority`), else the default. */
export function priorityFor(
  action: ActionDef,
  platform: string,
  chosen?: Readonly<Record<string, ShortcutPriority>>,
): ShortcutPriority {
  return (!isFixed(action, platform) && chosen?.[action.id]) || defaultPriorityFor(action, platform)
}

/** A keymap: which action each binding runs, and each action's bindings (KS-01). */
export interface Keymap {
  /** Each action's bindings, in their written order. */
  lists: Map<string, string[]>
  /** Binding (canonical) → action, for keys that never edit text. */
  direct: Map<string, ActionDef>
  /** Binding (canonical) → action, for keys that edit text in a field (KS-16): they act only outside one. */
  outsideText: Map<string, ActionDef>
}

/** Whether the user's list for an action applies: fixed actions keep their defaults. */
const ownsList = (action: ActionDef, custom: CustomBindings, platform: string) =>
  !isFixed(action, platform) && custom[action.id] !== undefined

/**
 * The keymap for a platform with the user's bindings `custom`: theirs where they changed an
 * action, the defaults elsewhere. A binding belongs to one action: fixed actions keep theirs first,
 * then the user's own bindings win over a default that came later (the default is left off its
 * action).
 */
export function buildKeymap(custom: CustomBindings, platform: string): Keymap {
  const owner = new Map<string, ActionDef>()
  const lists = new Map<string, string[]>()
  const claim = (action: ActionDef, accels: readonly string[]) => {
    const list: string[] = []
    for (const accel of accels) {
      const key = canonicalAccelerator(accel)
      if (!key || owner.has(key)) continue
      owner.set(key, action)
      list.push(accel)
    }
    lists.set(action.id, list)
  }
  for (const action of ACTIONS) if (isFixed(action, platform)) claim(action, defaultShortcutsFor(action, platform))
  for (const action of ACTIONS) if (ownsList(action, custom, platform)) claim(action, custom[action.id] ?? [])
  for (const action of ACTIONS) {
    if (!isFixed(action, platform) && !ownsList(action, custom, platform)) {
      claim(action, defaultShortcutsFor(action, platform))
    }
  }
  const direct = new Map<string, ActionDef>()
  const outsideText = new Map<string, ActionDef>()
  for (const [key, action] of owner) (editsText(key, platform) ? outsideText : direct).set(key, action)
  return { lists, direct, outsideText }
}

let current: { version: number; platform: string; keymap: Keymap } | undefined

/** The keymap in use now (KS-01): rebuilt when the user's bindings change. */
function liveIndex(platform: string): Keymap {
  const version = keymapVersion()
  if (current?.version !== version || current.platform !== platform) {
    current = { version, platform, keymap: buildKeymap(customBindings(), platform) }
  }
  return current.keymap
}

/**
 * The action's shortcuts on this platform as they are now (KS-01): the user's bindings if they
 * changed them, else the defaults. The first is the one hints show.
 */
export function shortcutsFor(action: ActionDef, platform: string): string[] {
  return liveIndex(platform).lists.get(action.id) ?? []
}

/** The keys another action lends this one (BORROWED_KEYS) as they are now, and that action. */
export function borrowedShortcutsFor(
  action: ActionDef,
  platform: string,
): { keys: string[]; from: ActionDef; where: string } | undefined {
  const lent = BORROWED_KEYS[action.id]
  const from = lent ? ACTIONS_BY_ID[lent.from] : undefined
  if (!lent || !from) return undefined
  const keys = shortcutsFor(from, platform)
  return keys.length > 0 ? { keys, from, where: lent.where } : undefined
}

/** The action that owns a binding now, if any (Settings → Shortcuts' conflict check). */
export function actionForAccelerator(accel: string, platform: string): ActionDef | undefined {
  const key = canonicalAccelerator(accel)
  if (!key) return undefined
  const keymap = liveIndex(platform)
  return keymap.direct.get(key) ?? keymap.outsideText.get(key)
}

/** An IME is composing: only keys with ⌘ or Ctrl may act (KS-16). */
const composingPlainKey = (input: KeyInput) => !!input.isComposing && !input.meta && !input.control

/** Returns the action bound to this key press on the given platform, if any. */
export function actionForInput(input: KeyInput, platform: string): ActionDef | undefined {
  // A key that typed a character through AltGr acts only outside text fields (KS-03).
  if (composingPlainKey(input) || typedWithAltGr(input, platform)) return undefined
  const key = acceleratorFromInput(input)
  return key ? liveIndex(platform).direct.get(key) : undefined
}

/**
 * The action bound to this key press only while focus is outside text fields (KS-16), if any.
 * The caller checks where focus is before running it.
 */
export function outsideTextActionFor(input: KeyInput, platform: string): ActionDef | undefined {
  if (composingPlainKey(input)) return undefined
  const key = acceleratorFromInput(input)
  if (!key) return undefined
  const keymap = liveIndex(platform)
  return keymap.outsideText.get(key) ?? (typedWithAltGr(input, platform) ? keymap.direct.get(key) : undefined)
}
