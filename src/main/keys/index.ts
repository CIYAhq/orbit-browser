import { webContents } from 'electron'
import { ACTIONS } from '../../shared/actions'
import type { BindResult, ShortcutPriority, SystemClash } from '../../shared/commands/keys'
import { onKeymapChange, setCustomBindings } from '../../shared/keymap'
import type { MainContext } from '../context'
import { installMenu, watchWindowsForMenu } from '../menu'
import { bind, reset, setPriority, unbind } from './bindings'
import { escapeLog, listenForEscapes } from './escape'
import { lastMenuHints } from './menu-hints'
import { registerOpenFile } from './open-file'
import { pageFocus } from './page-focus'
import { keyRouter } from './router'
import { registerShortcutSheet } from './sheet'
import { registerSpecialWindows } from './special-windows'
import { setSystemClashesForTest, systemClashes, systemKeysForTest } from './system'
import { registerTabKeys } from './tab-keys'
import { registerWindowKeys } from './window-keys'

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
  // The macOS menu bar shows each item's binding (KS-18), and with no window up takes ⌘O (KS-12).
  onKeymapChange(() => installMenu(ctx))
  watchWindowsForMenu(ctx)

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
  commands.register('keys.setOptions', ({ countFavorites, lastTabOnCmd9 }) =>
    store.update((d) => {
      if (typeof countFavorites === 'boolean') d.settings.countFavoritesInShortcuts = countFavorites
      if (typeof lastTabOnCmd9 === 'boolean') d.settings.lastTabOnCmd9 = lastTabOnCmd9
    }),
  )
  commands.register('keys.available', () => ACTIONS.filter((a) => ctx.actions.has(a.id)).map((a) => a.id))
  commands.register('keys.systemClashes', () => systemClashes())
  registerWindowKeys(ctx)
  registerTabKeys(ctx)
  registerShortcutSheet(ctx)
  registerOpenFile(ctx)
  registerSpecialWindows(ctx)
  keyRouter.init(ctx)
  // Whether a page used an Esc pressed while it loads, from its preload (D59).
  listenForEscapes((contents) => !!ctx.tabs.tabIdFor(contents))
  commands.register('keys.record', ({ on }, c) => keyRouter.setRecording(on ? c.windowId : undefined))
  // Tests say which keys the system keeps instead of asking it, and read the keys a menu showed,
  // where Orbit knows the keyboard is in a page, and what became of Esc on loading pages.
  if (ctx.e2e) {
    // Tests never ask the desktop (KS-03): it keeps the keys the test names, none unless it does.
    setSystemClashesForTest(systemKeysForTest(process.env.ORBIT_SYSTEM_KEYS))
    ;(globalThis as unknown as { __orbitKeys: unknown }).__orbitKeys = {
      setSystemClashes: (list: SystemClash[] | undefined) => setSystemClashesForTest(list ?? []),
      lastMenuHints,
      focusIn: (urlPart: string) => {
        const contents = webContents
          .getAllWebContents()
          .find((w) => !w.isDestroyed() && !!ctx.tabs.tabIdFor(w) && w.getURL().includes(urlPart))
        const now = contents ? pageFocus(contents) : undefined
        if (!now) return null
        try {
          return { frame: now.inFrame ? now.frame.url : 'main', where: now.where ?? null }
        } catch {
          return null
        }
      },
      escapes: escapeLog,
    }
  }
}
