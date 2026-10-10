import {
  ACTIONS,
  ACTIONS_BY_ID,
  type ActionDef,
  buildKeymap,
  defaultPriorityFor,
  defaultShortcutsFor,
} from '../../shared/actions'
import type { BindRequest, BindResult, ShortcutPriority } from '../../shared/commands/keys'
import { bindingProblem, type CustomBindings, canonicalAccelerator, formatAccelerator } from '../../shared/keymap'
import type { Settings } from '../../shared/state'

/**
 * The user's key bindings (KS-01) and priorities (KS-02) as `settings.shortcuts` and
 * `settings.shortcutPriority` keep them. Pure: each change takes the stored map and returns the
 * next one, which src/main/keys/index.ts saves.
 */

/** Most bindings one action keeps (KS-01: aliases such as Back = ⌘[ and ⌘←). */
export const MAX_BINDINGS = 5

type Bindings = Record<string, string[]>

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const canon = (list: readonly string[]): string[] =>
  list.map((a) => canonicalAccelerator(a)).filter((a): a is string => a !== undefined)

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

const copy = (custom: CustomBindings | undefined): Bindings =>
  Object.fromEntries(Object.entries(custom ?? {}).map(([id, list]) => [id, [...list]]))

/** Stores an action's list, or drops its entry when the list is its defaults again. */
function settle(custom: Bindings, action: ActionDef, list: string[], platform: string): void {
  if (sameList(list, canon(defaultShortcutsFor(action, platform)))) delete custom[action.id]
  else custom[action.id] = list
}

/**
 * The stored bindings made safe to use (on load): actions that exist and can change, bindings
 * Orbit can use (KS-01 validation), each binding on one action (the first in the action list
 * keeps it; fixed actions' keys are never taken), at most MAX_BINDINGS each. Undefined when
 * nothing differs from the defaults.
 */
export function normalizeShortcuts(value: unknown, platform: string): Bindings | undefined {
  if (!isRecord(value)) return undefined
  const out: Bindings = {}
  const taken = new Set<string>()
  for (const action of ACTIONS)
    if (action.fixed) for (const key of canon(defaultShortcutsFor(action, platform))) taken.add(key)
  for (const action of ACTIONS) {
    const raw = value[action.id]
    if (action.fixed || !Array.isArray(raw)) continue
    const list: string[] = []
    for (const accel of raw) {
      if (typeof accel !== 'string' || bindingProblem(accel, platform) !== undefined) continue
      const key = canonicalAccelerator(accel) as string
      if (taken.has(key) || list.length >= MAX_BINDINGS) continue
      taken.add(key)
      list.push(key)
    }
    settle(out, action, list, platform)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** The stored priorities made safe to use: known actions, known values, only where they differ from the default. */
export function normalizePriorities(value: unknown, platform: string): Record<string, ShortcutPriority> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, ShortcutPriority> = {}
  for (const [id, priority] of Object.entries(value)) {
    const action = ACTIONS_BY_ID[id]
    if (!action || action.fixed || (priority !== 'websites' && priority !== 'orbit')) continue
    if (priority !== defaultPriorityFor(action, platform)) out[id] = priority
  }
  return Object.keys(out).length > 0 ? out : undefined
}

const fail = (custom: Bindings, problem: string): { custom: Bindings; result: BindResult } => ({
  custom,
  result: { ok: false, problem },
})

/** Gives an action a binding (ST-08): see BindRequest. The map is unchanged unless the result is ok. */
export function bind(
  stored: CustomBindings | undefined,
  req: BindRequest,
  platform: string,
): { custom: Bindings; result: BindResult } {
  const custom = copy(stored)
  const action = ACTIONS_BY_ID[req.actionId]
  if (!action) return fail(custom, 'That action no longer exists.')
  if (action.fixed) return fail(custom, `${action.title} keeps its shortcut.`)
  const problem = bindingProblem(req.accel, platform)
  if (problem) return fail(custom, problem)
  const accel = canonicalAccelerator(req.accel) as string
  const replace = req.replace === undefined ? undefined : canonicalAccelerator(req.replace)
  const keymap = buildKeymap(custom, platform)
  const mine = canon(keymap.lists.get(action.id) ?? [])
  const owner = keymap.direct.get(accel) ?? keymap.outsideText.get(accel)
  if (owner && owner.id !== action.id) {
    if (owner.fixed) {
      return fail(custom, `${formatAccelerator(accel, platform)} is kept for ${owner.title}.`)
    }
    if (!req.onConflict) {
      return { custom, result: { ok: false, conflict: { actionId: owner.id, title: owner.title } } }
    }
    const theirs = canon(keymap.lists.get(owner.id) ?? [])
    const at = theirs.indexOf(accel)
    // Swap: the other action gets the binding this one gives up, where the taken one was.
    if (req.onConflict === 'swap' && replace && mine.includes(replace) && !theirs.includes(replace)) {
      theirs.splice(at, 1, replace)
    } else {
      theirs.splice(at, 1)
    }
    settle(custom, owner, theirs, platform)
  }
  let list = replace && mine.includes(replace) ? mine.map((a) => (a === replace ? accel : a)) : [...mine, accel]
  list = [...new Set(list)]
  if (list.length > MAX_BINDINGS) return fail(copy(stored), `An action can have up to ${MAX_BINDINGS} shortcuts.`)
  settle(custom, action, list, platform)
  return { custom, result: { ok: true } }
}

/** Takes one binding off an action. */
export function unbind(
  stored: CustomBindings | undefined,
  actionId: string,
  accel: string,
  platform: string,
): Bindings {
  const custom = copy(stored)
  const action = ACTIONS_BY_ID[actionId]
  const key = canonicalAccelerator(accel)
  if (!action || action.fixed || !key) return custom
  const list = canon(buildKeymap(custom, platform).lists.get(actionId) ?? [])
  if (list.includes(key))
    settle(
      custom,
      action,
      list.filter((a) => a !== key),
      platform,
    )
  return custom
}

/** Puts an action's defaults back, taking each default binding back from any action given it since. */
export function reset(stored: CustomBindings | undefined, actionId: string, platform: string): Bindings {
  const custom = copy(stored)
  const action = ACTIONS_BY_ID[actionId]
  if (!action || action.fixed) return custom
  delete custom[actionId]
  const defaults = new Set(canon(defaultShortcutsFor(action, platform)))
  for (const [id, list] of Object.entries(custom)) {
    const other = ACTIONS_BY_ID[id]
    if (!other) continue
    const kept = canon(list).filter((a) => !defaults.has(a))
    if (kept.length !== list.length) settle(custom, other, kept, platform)
  }
  return custom
}

/** Sets who gets an action's keys first (KS-02); the default needs no entry. */
export function setPriority(
  stored: Readonly<Record<string, ShortcutPriority>> | undefined,
  actionId: string,
  priority: ShortcutPriority,
  platform: string,
): Record<string, ShortcutPriority> {
  const out = { ...(stored ?? {}) }
  const action = ACTIONS_BY_ID[actionId]
  if (!action || action.fixed || (priority !== 'websites' && priority !== 'orbit')) return out
  if (priority === defaultPriorityFor(action, platform)) delete out[actionId]
  else out[actionId] = priority
  return out
}

/** The keys lane's fields of loaded settings (KS-01, KS-02), made safe. Called from normalizeState. */
export function normalizeKeySettings(settings: Settings, platform: string): void {
  const shortcuts = normalizeShortcuts(settings.shortcuts, platform)
  if (shortcuts) settings.shortcuts = shortcuts
  else delete settings.shortcuts
  const priorities = normalizePriorities(settings.shortcutPriority, platform)
  if (priorities) settings.shortcutPriority = priorities
  else delete settings.shortcutPriority
}
