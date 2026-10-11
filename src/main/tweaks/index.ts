import { newId } from '../../shared/ids'
import { peekShown } from '../../shared/nav'
import type { TabId, WindowId } from '../../shared/state'
import { applyTweakPatch, isEmptyTweak, newTweak, tweakAppliesTo, tweakHostOf, tweaksFor } from '../../shared/tweaks'
import type { MainContext } from '../context'
import type { CallContext } from '../registry'
import { activeTabOf, shownTabs } from '../windows'
import { registerTweakEditor, type TweakEditorInfo } from './editor'
import { registerTweakPages, type TweakPages } from './pages'

/** What a window says when Tweaks can't go where they were asked to (BO-01, BO-16). */
export const TWEAK_MESSAGES = {
  web: 'Tweaks work on websites only',
  off: 'Tweaks are turned off in Settings',
  peek: 'Open the page in a tab to tweak it',
  none: 'This site has no Tweaks',
} as const

/** Test-only handle (ORBIT_E2E=1): globalThis.__orbitTweaks. */
export interface TweakTestHooks {
  editor: (windowId?: WindowId) => TweakEditorInfo
  page: (tabId: TabId) => ReturnType<TweakPages['info']>
}

/**
 * Tweaks (BO-01 to BO-21): per-site restyling the user makes in the editor panel. Main keeps the
 * Tweaks in state (they never leave the device), applies them to pages (pages.ts) and places the
 * editor panel (editor.ts); the panel's page is src/renderer/src/tweaks/.
 */
export function registerTweaks(ctx: MainContext): void {
  const { store, commands, events, actions, windows, tabs } = ctx
  const pages = registerTweakPages(ctx)
  const editor = registerTweakEditor(ctx)

  const windowOf = (c: CallContext): WindowId | undefined => c.windowId ?? windows.focusedWindowId()

  /**
   * The host a tab's Tweaks are for: its page's, once that page asked for its Tweaks (a website, not
   * a PDF or an error page); a sleeping tab's from its address.
   */
  const hostOf = (tabId: TabId): string | null =>
    tabs.contents(tabId) ? pages.hostOf(tabId) : tweakHostOf(store.state.tabs[tabId]?.url)

  /**
   * The tab an entry point acts on, shown in its window so the panel can go over it; null (with a
   * note in the window saying why) where Tweaks can't open.
   */
  const target = async (
    asked: TabId | undefined,
    c: CallContext,
  ): Promise<{ windowId: WindowId; tabId: TabId; host: string } | null> => {
    const state = store.state
    const windowId = (asked ? windows.windowOfTab(asked) : undefined) ?? windowOf(c)
    if (!windowId) return null
    const tabId = asked ?? activeTabOf(state, windowId)
    if (!tabId || !state.tabs[tabId]) return null
    if (!state.settings.tweaksEnabled) {
      ctx.toast(windowId, TWEAK_MESSAGES.off)
      return null
    }
    if (peekShown(state, windowId)) {
      ctx.toast(windowId, TWEAK_MESSAGES.peek)
      return null
    }
    const host = hostOf(tabId)
    if (!host) {
      ctx.toast(windowId, TWEAK_MESSAGES.web)
      return null
    }
    // The tab menu's tab may be another one: it is shown first, as the panel goes over its page.
    if (!shownTabs(state, windowId).has(tabId)) await commands.run('tabs.activate', { tabId }, { windowId })
    return { windowId, tabId, host }
  }

  // ---- Commands ----

  commands.register('tweaks.create', async ({ tabId: asked }, c) => {
    const at = await target(asked, c)
    if (!at) return null
    const { windowId, tabId, host } = at
    // The panel already shows a Tweak it just made for this page, still empty: that one it is.
    const editing = editor.editing(windowId)
    const current = editing?.tabId === tabId ? store.state.tweaks[editing.tweakId] : undefined
    if (current && current.host === host && isEmptyTweak(current) && current.name === current.host) {
      editor.open(windowId, tabId, current.id)
      return current.id
    }
    const id = newId('x')
    const tweak = newTweak(id, host, Date.now())
    store.update((draft) => {
      draft.tweaks[id] = tweak
    })
    editor.open(windowId, tabId, id, true)
    return id
  })

  commands.register('tweaks.edit', async ({ id, tabId: asked }, c) => {
    const tweak = store.state.tweaks[id]
    if (!tweak) return false
    const at = await target(asked, c)
    if (!at || !tweakAppliesTo(tweak, at.host)) return false
    editor.open(at.windowId, at.tabId, id)
    return true
  })

  commands.register('tweaks.update', ({ id, patch }) => {
    if (!store.state.tweaks[id]) return false
    store.update((draft) => {
      const tweak = draft.tweaks[id]
      if (tweak) applyTweakPatch(tweak, patch, Date.now())
    })
    return true
  })

  commands.register('tweaks.runNow', ({ id, tabId }) => pages.runNow(tabId, id))

  commands.register('tweaks.setEnabled', ({ id, enabled }) => {
    if (typeof enabled !== 'boolean') return
    store.update((draft) => {
      const tweak = draft.tweaks[id]
      if (tweak) applyTweakPatch(tweak, { enabled }, Date.now())
    })
  })

  commands.register('tweaks.delete', ({ id }) => {
    store.update((draft) => {
      delete draft.tweaks[id]
    })
  })

  commands.register('tweaks.editorState', (_args, c) => editor.state(c.windowId))
  commands.register('tweaks.closeEditor', (_args, c) => {
    if (c.windowId) editor.close(c.windowId)
  })
  commands.register('tweaks.editorLayout', ({ width, height }, c) => {
    if (c.windowId && Number.isFinite(width) && Number.isFinite(height)) editor.layout(c.windowId, { width, height })
  })
  commands.register('tweaks.dismissIntro', () => {
    store.update((draft) => {
      draft.settings.tweakIntroSeen = true
    })
  })

  events.on('tweaks.editorDrag', ({ phase, x, y }, c) => {
    if (c.windowId && (phase === 'start' || phase === 'move' || phase === 'end')) editor.drag(c.windowId, phase, x, y)
  })

  // ---- Actions (BO-21): none bound by default ----

  actions.register('tweak.new', async ({ windowId }) => {
    await commands.run('tweaks.create', {}, { windowId })
  })

  // The shown page's Tweak in the panel; with several, the site controls panel lists them to pick from.
  actions.register('tweak.edit', async ({ windowId }) => {
    const at = await target(undefined, { windowId })
    if (!at) return
    const list = tweaksFor(store.state.tweaks, at.host)
    const only = list.length === 1 ? list[0] : undefined
    if (only) editor.open(at.windowId, at.tabId, only.id)
    else if (list.length === 0) ctx.toast(at.windowId, TWEAK_MESSAGES.none)
    else await commands.run('site.openControls', {}, { windowId: at.windowId })
  })

  /** Turns every Tweak of the shown page's site on or off (BO-21, BO-14). */
  const setSite = async (windowId: WindowId | undefined, enabled: boolean) => {
    const at = await target(undefined, { windowId })
    if (!at) return
    const ids = tweaksFor(store.state.tweaks, at.host).map((t) => t.id)
    if (ids.length === 0) {
      ctx.toast(at.windowId, TWEAK_MESSAGES.none)
      return
    }
    const now = Date.now()
    store.update((draft) => {
      for (const id of ids) {
        const tweak = draft.tweaks[id]
        if (tweak) applyTweakPatch(tweak, { enabled }, now)
      }
    })
    ctx.toast(at.windowId, `Tweaks ${enabled ? 'on' : 'off'} for ${at.host}`)
  }
  actions.register('tweak.siteOff', ({ windowId }) => setSite(windowId, false))
  actions.register('tweak.siteOn', ({ windowId }) => setSite(windowId, true))

  if (ctx.e2e) {
    const hooks: TweakTestHooks = {
      editor: (windowId) => editor.info(windowId ?? windows.ids()[0] ?? ''),
      page: (tabId) => pages.info(tabId),
    }
    ;(globalThis as unknown as { __orbitTweaks: TweakTestHooks }).__orbitTweaks = hooks
  }
}
