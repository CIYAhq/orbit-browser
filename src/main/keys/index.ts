import type { BindResult, ShortcutPriority } from '../../shared/commands/keys'
import { onKeymapChange, setCustomBindings } from '../../shared/keymap'
import type { MainContext } from '../context'
import { installMenu } from '../menu'
import { bind, reset, setPriority, unbind } from './bindings'
import { keyRouter } from './router'

/**
 * The keymap in main (KS-01): the user's bindings follow `settings.shortcuts`, the menu bar is
 * built again after a remap, and the keys.* commands change bindings and priorities for Settings →
 * Shortcuts (ST-08). Registered before every other feature, so whatever reads a shortcut while it
 * starts reads the user's.
 */
export function registerKeys(ctx: MainContext): void {
  const { store, commands } = ctx
  const platform = process.platform
  setCustomBindings(store.state.settings.shortcuts)
  store.subscribe((next, prev) => {
    if (next.settings.shortcuts !== prev.settings.shortcuts) setCustomBindings(next.settings.shortcuts)
  })
  // The macOS menu bar shows each item's binding (KS-18).
  onKeymapChange(() => installMenu(ctx))

  const saveBindings = (custom: Record<string, string[]>) =>
    store.update((d) => {
      if (Object.keys(custom).length > 0) d.settings.shortcuts = custom
      else delete d.settings.shortcuts
    })
  const savePriorities = (chosen: Record<string, ShortcutPriority>) =>
    store.update((d) => {
      if (Object.keys(chosen).length > 0) d.settings.shortcutPriority = chosen
      else delete d.settings.shortcutPriority
    })
  const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128

  commands.register('keys.bind', (args): BindResult => {
    if (!text(args?.actionId) || !text(args.accel)) return { ok: false, problem: 'Nothing to bind.' }
    const req = {
      actionId: args.actionId,
      accel: args.accel,
      ...(text(args.replace) ? { replace: args.replace } : {}),
      ...(args.onConflict === 'clear' || args.onConflict === 'swap' ? { onConflict: args.onConflict } : {}),
    }
    const { custom, result } = bind(store.state.settings.shortcuts, req, platform)
    if (result.ok) saveBindings(custom)
    return result
  })
  commands.register('keys.unbind', ({ actionId, accel }) => {
    if (!text(actionId) || !text(accel)) return
    saveBindings(unbind(store.state.settings.shortcuts, actionId, accel, platform))
  })
  commands.register('keys.reset', ({ actionId }) => {
    if (!text(actionId)) return
    saveBindings(reset(store.state.settings.shortcuts, actionId, platform))
    const chosen = { ...(store.state.settings.shortcutPriority ?? {}) }
    delete chosen[actionId]
    savePriorities(chosen)
  })
  commands.register('keys.resetAll', () => {
    saveBindings({})
    savePriorities({})
  })
  commands.register('keys.setPriority', ({ actionId, priority }) => {
    if (!text(actionId)) return
    savePriorities(setPriority(store.state.settings.shortcutPriority, actionId, priority, platform))
  })
  keyRouter.init(ctx)
  commands.register('keys.record', ({ on }, c) => keyRouter.setRecording(on ? c.windowId : undefined))
}
