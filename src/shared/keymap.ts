/**
 * The keymap's building blocks (KS-01, KS-03): accelerator strings, how a key press matches them,
 * what a new binding must look like, and the bindings the user changed on this device.
 *
 * An accelerator is modifiers (Cmd, Ctrl, Alt, Shift) joined by "+" with a key name: A–Z, 0–9,
 * [ ] , . / ; ' ` - = \, Left Right Up Down, Tab Enter Escape Backspace Delete Space Home End
 * PageUp PageDown Insert, F1–F24. Cmd is ⌘ on macOS and the Windows/Super key elsewhere.
 *
 * Each action's default bindings are its `mac` / `other` lists (src/shared/actions.ts). The user's
 * changes are `settings.shortcuts`: for each action they changed, its whole list of bindings (an
 * empty list when they took every key away; the command bar and menus still reach the action).
 * Main and every Orbit renderer keep this module's copy in step with that setting
 * (`setCustomBindings`), so a remap reaches the key router, the menus, tooltips, command-bar rows
 * and the shortcut sheet at once.
 */

export interface KeyInput {
  key: string
  code: string
  meta: boolean
  control: boolean
  alt: boolean
  shift: boolean
  /** An input method (IME) is composing text: keys without ⌘ or Ctrl belong to it (KS-16). */
  isComposing?: boolean
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

const KEY_LABELS: Record<string, string> = {
  Left: '←',
  Right: '→',
  Up: '↑',
  Down: '↓',
  Enter: '↩',
  Escape: 'Esc',
  Space: 'Space',
}
const MAC_KEY_LABELS: Record<string, string> = { Backspace: '⌫', Delete: '⌦', Tab: '⇥', PageUp: '⇞', PageDown: '⇟' }

/** Display form of an accelerator, e.g. "⌘⇧T" on macOS or "Ctrl+Shift+T" elsewhere. */
export function formatAccelerator(accel: string, platform: string): string {
  const a = parseAccelerator(accel)
  const keyLabel = KEY_LABELS[a.key] ?? (platform === 'darwin' ? MAC_KEY_LABELS[a.key] : undefined)
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

// ---- Bindings: one written form, and what a new one must be (KS-01, ST-08) ----

const NAMED_KEYS = [
  'Left',
  'Right',
  'Up',
  'Down',
  'Tab',
  'Enter',
  'Escape',
  'Backspace',
  'Delete',
  'Space',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Insert',
]
const NAMED_BY_LOWER = new Map([
  ...NAMED_KEYS.map((k): [string, string] => [k.toLowerCase(), k]),
  ['esc', 'Escape'],
  ['return', 'Enter'],
  ['plus', '='],
])
const SYMBOL_KEYS = new Set(['[', ']', ',', '.', '/', ';', "'", '`', '-', '=', '\\'])
const FUNCTION_KEY = /^F([1-9]|1\d|2[0-4])$/
const MODIFIER_NAMES: Record<string, 'Cmd' | 'Ctrl' | 'Alt' | 'Shift'> = {
  cmd: 'Cmd',
  command: 'Cmd',
  meta: 'Cmd',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
}

/** The key part of an accelerator in its one written form, or undefined if Orbit doesn't bind it. */
function canonicalKey(raw: string): string | undefined {
  if (raw.length === 1) {
    const upper = raw.toUpperCase()
    if (/^[A-Z0-9]$/.test(upper)) return upper
    const base = SHIFTED_SYMBOLS[raw] ?? raw
    return SYMBOL_KEYS.has(base) ? base : undefined
  }
  const named = NAMED_BY_LOWER.get(raw.toLowerCase())
  if (named) return named
  const fKey = raw.toUpperCase()
  return FUNCTION_KEY.test(fKey) ? fKey : undefined
}

/**
 * An accelerator in its one written form: modifiers in the order Cmd, Ctrl, Alt, Shift, then the key
 * ("Shift+Cmd+t" → "Cmd+Shift+T", "Cmd++" → "Cmd+="). Undefined when it isn't one Orbit can bind:
 * an unknown modifier or key, or a modifier twice.
 */
export function canonicalAccelerator(accel: string): string | undefined {
  if (typeof accel !== 'string' || accel.length === 0 || accel.length > 64) return undefined
  const parts = accel.split('+')
  // "Cmd++": the key is "+" itself.
  let rawKey = parts.pop() ?? ''
  if (rawKey === '' && parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop()
    rawKey = '+'
  }
  const key = canonicalKey(rawKey)
  if (!key) return undefined
  const mods = new Set<string>()
  for (const part of parts) {
    const mod = MODIFIER_NAMES[part.toLowerCase()]
    if (!mod || mods.has(mod)) return undefined
    mods.add(mod)
  }
  return [...(['Cmd', 'Ctrl', 'Alt', 'Shift'] as const).filter((m) => mods.has(m)), key].join('+')
}

/** Keys that are only modifiers (or locks): pressed alone they make no binding. */
const MODIFIER_KEYS = new Set([
  'Shift',
  'Control',
  'Alt',
  'AltGraph',
  'Meta',
  'OS',
  'Super',
  'Hyper',
  'Fn',
  'FnLock',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Symbol',
  'SymbolLock',
])

/** The modifiers held in a key press, as a binding writes them; "" when none. */
export function modifiersOf(input: Pick<KeyInput, 'meta' | 'control' | 'alt' | 'shift'>): string {
  return [input.meta && 'Cmd', input.control && 'Ctrl', input.alt && 'Alt', input.shift && 'Shift']
    .filter(Boolean)
    .join('+')
}

/**
 * The binding a key press makes (written as `canonicalAccelerator` writes it), e.g. for Settings →
 * Shortcuts recording a new one (ST-08). Undefined for a modifier pressed on its own and for keys
 * Orbit doesn't bind.
 */
export function acceleratorFromInput(input: KeyInput): string | undefined {
  if (MODIFIER_KEYS.has(input.key)) return undefined
  const mods = modifiersOf(input)
  return canonicalAccelerator(mods ? `${mods}+${keyName(input)}` : keyName(input))
}

/** Function keys F1–F12 may be bound with no modifier (KS-01). */
const BARE_KEY = /^F([1-9]|1[0-2])$/

/** Keys the system or Orbit keeps for themselves (KS-15, KS-12): not offered as bindings. */
const RESERVED: Record<'mac' | 'other', Record<string, string>> = {
  mac: {
    'Cmd+Q': 'Quit Orbit',
    'Cmd+H': 'Hide Orbit',
    'Cmd+Alt+H': 'Hide Others',
    'Cmd+M': 'Minimize',
    'Cmd+`': 'switching between Orbit windows',
    'Cmd+Shift+/': 'Help menu search',
    'Cmd+Tab': 'switching apps',
    'Cmd+Space': 'system search',
  },
  other: {
    'Alt+F4': 'closing the window',
    'Alt+Tab': 'switching apps',
    'Alt+F': 'the app menu',
  },
}

/** What keeps a binding from being used, as Settings → Shortcuts says it; undefined when it is fine. */
export function bindingProblem(accel: string, platform: string): string | undefined {
  const canonical = canonicalAccelerator(accel)
  if (!canonical) return "Orbit can't use that key for a shortcut."
  const a = parseAccelerator(canonical)
  const mac = platform === 'darwin'
  if (!a.cmd && !a.ctrl && !a.alt && !a.shift && !BARE_KEY.test(a.key)) {
    return mac
      ? 'A shortcut starts with ⇧, ⌃, ⌥ or ⌘ (F1–F12 can be used on their own).'
      : 'A shortcut starts with Shift, Ctrl or Alt (F1–F12 can be used on their own).'
  }
  const taken = RESERVED[mac ? 'mac' : 'other'][canonical]
  if (taken) return `${formatAccelerator(canonical, platform)} is kept for ${taken}.`
  return undefined
}

// ---- Keys that type or edit text (KS-03, KS-16) ----

const MAC_TEXT_COMMANDS = new Set(['Cmd+A', 'Cmd+C', 'Cmd+X', 'Cmd+V', 'Cmd+Z', 'Cmd+Shift+Z', 'Cmd+Alt+Shift+V'])
const OTHER_TEXT_COMMANDS = new Set([
  'Ctrl+A',
  'Ctrl+C',
  'Ctrl+X',
  'Ctrl+V',
  'Ctrl+Z',
  'Ctrl+Y',
  'Ctrl+Shift+Z',
  'Ctrl+Shift+V',
  'Ctrl+Insert',
  'Shift+Insert',
  'Shift+Delete',
])

type Modifier = 'cmd' | 'ctrl' | 'alt' | 'shift'

/** True when every modifier the binding holds is one of `allowed` (none held counts). */
function holdsOnly(a: ParsedAccelerator, ...allowed: Modifier[]): boolean {
  return (['cmd', 'ctrl', 'alt', 'shift'] as const).every((m) => !a[m] || allowed.includes(m))
}

/** Caret, selection and deletion keys with the modifiers that make them edit text, per platform. */
function editingKeyEdits(a: ParsedAccelerator, mac: boolean): boolean | undefined {
  switch (a.key) {
    case 'Left':
    case 'Right':
    case 'Up':
    case 'Down':
      // macOS: ⌘ moves by line, ⌥ by word, ⇧ selects (⌘⌥ arrows edit nothing). Elsewhere Ctrl
      // moves by word and Shift selects; Alt+←/→ go back and forward.
      return mac ? holdsOnly(a, 'cmd', 'shift') || holdsOnly(a, 'alt', 'shift') : holdsOnly(a, 'ctrl', 'shift')
    case 'Home':
    case 'End':
      return mac ? holdsOnly(a, 'shift') : holdsOnly(a, 'ctrl', 'shift')
    case 'PageUp':
    case 'PageDown':
      // Ctrl+PageUp/PageDown switch tabs, even from a field.
      return holdsOnly(a, 'shift')
    case 'Backspace':
    case 'Delete':
      // One of ⌘ (to line start), ⌥ (word) or ⇧ on macOS; Ctrl (word) elsewhere. ⌘⇧⌫ and
      // Ctrl+Shift+Delete edit nothing (they clear browsing data).
      return mac
        ? holdsOnly(a, 'cmd') || holdsOnly(a, 'alt') || holdsOnly(a, 'shift')
        : holdsOnly(a, 'ctrl') || holdsOnly(a, 'shift')
    case 'Enter':
    case 'Space':
      return mac ? holdsOnly(a, 'alt', 'shift') : holdsOnly(a, 'shift')
    case 'Tab':
      return holdsOnly(a, 'shift')
    case 'Insert':
      return holdsOnly(a, 'ctrl', 'shift')
    default:
      return undefined
  }
}

/**
 * Whether a binding is a key that types or edits text in a field on this platform (KS-16): a
 * printable key with no ⌘ or Ctrl (Shift types capitals; macOS's ⌥ types symbols), the caret,
 * selection and deletion keys with the modifiers that move by word or line, and the clipboard and
 * undo commands. Such a binding runs its action only while keyboard focus is outside text fields,
 * and the key is never taken from the field.
 */
export function editsText(accel: string, platform: string): boolean {
  const canonical = canonicalAccelerator(accel)
  if (!canonical) return false
  const mac = platform === 'darwin'
  if ((mac ? MAC_TEXT_COMMANDS : OTHER_TEXT_COMMANDS).has(canonical)) return true
  const a = parseAccelerator(canonical)
  if (FUNCTION_KEY.test(a.key) || a.key === 'Escape') return false
  const editing = editingKeyEdits(a, mac)
  if (editing !== undefined) return editing
  // A printable key types a character unless ⌘ or Ctrl is held (outside macOS, Alt too).
  return mac ? !a.cmd && !a.ctrl : !a.cmd && !a.ctrl && !a.alt
}

/**
 * Whether this key press typed a character that a plain press of the same key would not: on
 * Windows, AltGr arrives as Ctrl+Alt, so a Ctrl+Alt binding must not fire when the press made "ń"
 * or "@" in a text field (KS-03).
 */
export function typedWithAltGr(input: KeyInput, platform: string): boolean {
  if (platform === 'darwin' || !input.control || !input.alt || input.meta) return false
  if ([...input.key].length !== 1) return false
  if (input.code.startsWith('Key') && input.key.toUpperCase() === input.code.slice(3)) return false
  if (input.code.startsWith('Digit') && input.key === input.code.slice(5)) return false
  // The symbol the key carries on a US layout, shifted or not: "[" from BracketLeft is no AltGr character.
  const symbol = CODE_NAMES[input.code]
  if (symbol !== undefined && symbol.length === 1 && (SHIFTED_SYMBOLS[input.key] ?? input.key) === symbol) return false
  return true
}

// ---- The user's bindings on this device (KS-01) ----

/** Action id → its whole binding list, for actions whose bindings the user changed. */
export type CustomBindings = Readonly<Record<string, readonly string[]>>

const NONE: CustomBindings = Object.freeze({})
let custom: CustomBindings = NONE
let version = 0
const listeners = new Set<() => void>()

/** Takes the user's bindings (`settings.shortcuts`) as they are now; listeners hear of a change. */
export function setCustomBindings(next: CustomBindings | undefined): void {
  const value = next ?? NONE
  if (value === custom) return
  custom = value
  version++
  for (const listener of [...listeners]) listener()
}

export function customBindings(): CustomBindings {
  return custom
}

/** Goes up by one each time the user's bindings change: caches of hints compare it. */
export function keymapVersion(): number {
  return version
}

/** Calls `listener` after each change of the user's bindings; returns the unsubscribe. */
export function onKeymapChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
