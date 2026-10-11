import { ACTIONS, buildKeymap, isFixed } from './actions'
import type { SystemClash } from './commands/keys'
import { bindingProblem, type CustomBindings, canonicalAccelerator, editsText, parseAccelerator } from './keymap'

/**
 * KS-03's first-run check: the keys Orbit's actions are bound to that the desktop keeps for itself,
 * so they never reach Orbit, each with a free key Orbit could use instead. Pure: main passes the
 * keys the system keeps (`systemClashes`, the check Settings → Shortcuts marks them with) and the
 * user's bindings; onboarding offers the result on Linux, and nothing changes until the user says yes.
 */

export interface KeyRemap {
  actionId: string
  /** The action's name, as Settings → Shortcuts shows it. */
  title: string
  /** The binding the desktop keeps, written as `canonicalAccelerator` writes it. */
  accel: string
  /** What the desktop uses it for, e.g. "GNOME: Switch to workspace on the left". */
  owner: string
  /** The action's other bindings that do reach Orbit. */
  others: string[]
  /** A free binding to use in its place, when there is one. */
  suggestion?: string
}

const FUNCTION_KEY = /^F([1-9]|1\d|2[0-4])$/

/**
 * Keys desktops often keep without saying so in the settings Orbit reads: never suggested. Super is
 * the desktop's own modifier; Alt with an F-key moves, sizes and closes windows, and Ctrl+Alt with
 * one switches to a text console; Ctrl+Alt+Delete, Backspace, T and L log out, end the session, open
 * a terminal and lock the screen on many desktops.
 */
function desktopMayKeep(accel: string): boolean {
  const a = parseAccelerator(accel)
  if (a.cmd) return true
  if (a.alt && !a.shift && FUNCTION_KEY.test(a.key)) return true
  return a.ctrl && a.alt && !a.shift && ['Delete', 'Backspace', 'T', 'L'].includes(a.key)
}

/** Other modifiers for the same key, most like the original first: Shift added, then the rest. */
const MODIFIER_SETS = [['Ctrl', 'Alt', 'Shift'], ['Ctrl', 'Shift'], ['Alt', 'Shift'], ['Ctrl'], ['Alt'], ['Shift'], []]

function candidates(accel: string): string[] {
  const a = parseAccelerator(accel)
  const list = a.shift ? [] : [[a.ctrl && 'Ctrl', a.alt && 'Alt', 'Shift', a.key].filter(Boolean).join('+')]
  for (const mods of MODIFIER_SETS) list.push([...mods, a.key].join('+'))
  return list
}

/**
 * The actions whose keys the desktop keeps, in the order Settings → Shortcuts lists actions, each
 * with a suggested key: free in Orbit's keymap and not kept by the desktop, one Orbit can bind, that
 * edits no text, and no two suggestions the same. `runs` says which actions Orbit has (the action
 * table also names some no feature runs yet); fixed actions are left out, as they can't change.
 */
export function keyRemaps(
  clashes: readonly SystemClash[],
  custom: CustomBindings,
  platform: string,
  runs: (actionId: string) => boolean = () => true,
): KeyRemap[] {
  const keymap = buildKeymap(custom, platform)
  const canon = (list: readonly string[]) =>
    list.map((a) => canonicalAccelerator(a)).filter((a): a is string => a !== undefined)
  const kept = new Set(canon(clashes.map((c) => c.accel)))
  const taken = new Set([...keymap.direct.keys(), ...keymap.outsideText.keys(), ...kept])
  const order = new Map(ACTIONS.map((a, i) => [a.id, i]))
  const seen = new Set<string>()
  const found: KeyRemap[] = []
  for (const clash of clashes) {
    const accel = canonicalAccelerator(clash.accel)
    if (!accel || seen.has(accel)) continue
    seen.add(accel)
    const action = keymap.direct.get(accel) ?? keymap.outsideText.get(accel)
    if (!action || isFixed(action, platform) || !runs(action.id)) continue
    const others = canon(keymap.lists.get(action.id) ?? []).filter((k) => !kept.has(k))
    const suggestion = canon(candidates(accel)).find(
      (c) =>
        !taken.has(c) && bindingProblem(c, platform) === undefined && !editsText(c, platform) && !desktopMayKeep(c),
    )
    if (suggestion) taken.add(suggestion)
    found.push({
      actionId: action.id,
      title: action.title,
      accel,
      owner: clash.owner,
      others,
      ...(suggestion ? { suggestion } : {}),
    })
  }
  return found.sort((a, b) => (order.get(a.actionId) ?? 0) - (order.get(b.actionId) ?? 0))
}
