/**
 * Owned by the keys lane: the keymap's commands (KS-01, KS-02) and Settings → Shortcuts (ST-08).
 * Bindings are accelerator strings (src/shared/keymap.ts); actions are ids from src/shared/actions.ts.
 */

/** Who gets a key first when a page also handles it (KS-02). */
export type ShortcutPriority = 'websites' | 'orbit'

/** Another action that already has the binding asked for (ST-08 conflict warning). */
export interface BindingConflict {
  actionId: string
  title: string
}

export type BindResult =
  | { ok: true }
  /** The binding can't be used: no modifier, a key Orbit doesn't bind, one the system keeps… */
  | { ok: false; problem: string }
  /** Another action has it; ask again with `onConflict` to take it. */
  | { ok: false; conflict: BindingConflict }

export interface BindRequest {
  actionId: string
  /** The new binding, e.g. "Cmd+Shift+B". */
  accel: string
  /** One of the action's bindings the new one takes the place of; without it, the new one is added. */
  replace?: string
  /**
   * When another action has `accel`: 'clear' takes it off that action; 'swap' gives that action
   * `replace` in its place (or clears it when there is nothing to give). Without it, the conflict
   * is returned and nothing changes.
   */
  onConflict?: 'clear' | 'swap'
}

/** What main reports to Settings → Shortcuts while it records a binding. */
export interface RecordedKey {
  /** The binding the press made, written as `canonicalAccelerator` writes it; absent for a lone modifier. */
  accel?: string
  /** The modifiers held, e.g. "Cmd+Shift" ("" for none), to show while the user builds a combination. */
  modifiers: string
}

/** A key the operating system keeps for itself, so Orbit never receives it (KS-03). */
export interface SystemClash {
  /** The binding, written as `canonicalAccelerator` writes it. */
  accel: string
  /** What has it, e.g. "Mission Control: Switch to Desktop 1". */
  owner: string
}

/** The overlay panel of Help → Keyboard Shortcuts (OB-12): `{ kind: 'panel', panel: SHORTCUT_SHEET }`. */
export const SHORTCUT_SHEET = 'shortcuts'

/** The Go to Tab options (TB-04, FV-10, ST-08). */
export interface TabNumberOptions {
  /** ⌘1–⌘8 count Favorites first. */
  countFavorites?: boolean
  /** ⌘9 goes to the last item (true) or the ninth (false). */
  lastTabOnCmd9?: boolean
}

export interface KeyCommands {
  /** Gives an action a binding (KS-01, ST-08). See BindRequest. */
  'keys.bind': { args: BindRequest; result: BindResult }
  /** Takes one binding off an action; the command bar and menus still reach it (KS-01). */
  'keys.unbind': { args: { actionId: string; accel: string }; result: void }
  /** Puts an action's bindings back to its defaults, taking each back from any action that has it now. */
  'keys.reset': { args: { actionId: string }; result: void }
  /** Puts every action's bindings and priorities back to the defaults. */
  'keys.resetAll': { args: Record<string, never>; result: void }
  /**
   * Settings → Shortcuts records a binding: while on, each key press in the Settings window is
   * sent to it as `keys.recorded` (a RecordedKey) and runs nothing. Off when the window closes.
   */
  'keys.record': { args: { on: boolean }; result: void }
  /** Who gets the action's keys first when a page also handles them (KS-02). */
  'keys.setPriority': { args: { actionId: string; priority: ShortcutPriority }; result: void }
  /** The Go to Tab options of Settings → Shortcuts (ST-08). */
  'keys.setOptions': { args: TabNumberOptions; result: void }
  /** The ids of the actions Orbit runs (the action table also names some no feature runs yet): Settings → Shortcuts lists these. */
  'keys.available': { args: Record<string, never>; result: string[] }
  /** Keys the operating system keeps, so Orbit never receives them (KS-03): shown in Settings → Shortcuts. */
  'keys.systemClashes': { args: Record<string, never>; result: SystemClash[] }
}
