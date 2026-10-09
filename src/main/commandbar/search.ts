import { clipboard } from 'electron'
import type { SearchResult } from '../../shared/commands/commandbar'
import type { CommandName } from '../../shared/rpc'
import type { OrbitState, WindowId } from '../../shared/state'
import { parseInput, SEARCH_ENGINES } from '../../shared/url'
import type { MainContext } from '../context'
import type { HistoryService } from '../history'
import type { CallContext } from '../registry'
import { activeTabOf } from '../windows'
import { pastSearchOf, type RankInput, rank } from './rank'
import { SourceCache } from './sources'

/** Keystroke → results timings (ms) of the last queries, for tests and tuning. */
export const queryTimings: number[] = []

/**
 * The command bar's main-process side: ranks open tabs, history, archived
 * tabs, Spaces, actions and the typed URL/search per keystroke (no state
 * copies; see sources.ts), and carries out the chosen row.
 */
export function registerSearch(ctx: MainContext, history: HistoryService): void {
  const { store, commands, actions, windows } = ctx
  const sources = new SourceCache()
  const windowOf = (c: CallContext): WindowId | undefined => c.windowId ?? windows.focusedWindowId()

  const barOpen = (windowId: WindowId | undefined): boolean =>
    !!windowId && store.state.windows[windowId]?.overlay.kind === 'commandbar'

  const closeBar = (windowId: WindowId | undefined) => {
    if (!windowId) return
    store.update((d) => {
      const win = d.windows[windowId]
      if (win && win.overlay.kind === 'commandbar') win.overlay = { kind: 'none' }
    })
  }

  /** Profile of the window's current Space, and whether it is private (non-persistent session). */
  const profileOf = (state: OrbitState, windowId: WindowId | undefined) => {
    const win = windowId ? state.windows[windowId] : undefined
    const space = state.spaces[win?.spaceId ?? ''] ?? state.spaces[state.spaceOrder[0] ?? '']
    const profile = space ? state.profiles[space.profileId] : undefined
    return { space, profile, isPrivate: !!profile && !profile.partition.startsWith('persist:') }
  }

  /** A URL on the clipboard (CB-12); never holds up the empty state for long. */
  const clipboardUrl = async (): Promise<string | undefined> => {
    const text = await Promise.race([
      clipboard.readText().catch(() => ''),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 40)),
    ])
    const trimmed = text.trim()
    if (!trimmed || trimmed.length > 2048 || /\s/.test(trimmed)) return undefined
    const parsed = parseInput(trimmed)
    return parsed.kind === 'url' && /^https?:/i.test(parsed.url) ? parsed.url : undefined
  }

  commands.register('search.query', async (args, c) => {
    const wantsClipboard = args.mode === 'new-tab' && !args.query.trim() && !args.actionsOnly && !args.siteSearchId
    const clip = wantsClipboard ? await clipboardUrl() : undefined
    const t0 = performance.now()
    const state = store.state
    const windowId = windowOf(c)
    const { space, profile, isPrivate } = profileOf(state, windowId)
    const activeTabId = windowId ? activeTabOf(state, windowId) : null
    const active = activeTabId ? state.tabs[activeTabId] : undefined
    // Private windows: only their own tabs, never history or the archive (CB-23).
    const hs = profile && !isPrivate ? history.store(profile.id) : undefined
    const engine = SEARCH_ENGINES[state.settings.searchEngine] ?? SEARCH_ENGINES.google
    const siteSearches = state.settings.siteSearch ?? []
    const allTabs = sources.tabs(state)
    const input: RankInput = {
      query: args.query,
      mode: args.mode,
      now: Date.now(),
      engine: { name: engine.name, search: engine.search },
      tabs: isPrivate ? allTabs.filter((t) => state.tabs[t.id]?.profileId === profile?.id) : allTabs,
      activeTabId,
      currentSpaceId: space?.id ?? '',
      spaceNames: sources.spaceNames(state),
      current: active
        ? { url: active.url, title: active.customTitle ?? active.title, favicon: active.favicon }
        : undefined,
      history: hs?.entries() ?? [],
      hosts: hs?.hostList() ?? [],
      archive: profile && !isPrivate ? sources.archive(state, profile.id) : [],
      spaces: isPrivate ? [] : sources.spaces(state),
      actions: sources.actions((id) => actions.has(id), process.platform),
      siteSearches,
      scope: args.siteSearchId ? siteSearches.find((s) => s.id === args.siteSearchId) : undefined,
      actionsOnly: args.actionsOnly,
      noAutocomplete: args.noAutocomplete,
      clipboardUrl: clip,
    }
    const response = rank(input)
    queryTimings.push(performance.now() - t0)
    if (queryTimings.length > 200) queryTimings.splice(0, 100)
    return response
  })

  commands.register('search.siteSearches', () =>
    (store.state.settings.siteSearch ?? []).map((s) => ({ id: s.id, name: s.name, keyword: s.keyword })),
  )

  commands.register('search.open', async ({ result, mode, disposition }, c) => {
    const windowId = windowOf(c)
    closeBar(windowId)
    const state = store.state
    const current = windowId ? activeTabOf(state, windowId) : null
    const inPlace = mode === 'edit-url' && !!current && disposition !== 'new-tab'

    const openUrl = async (url: string | undefined, typed: boolean) => {
      if (!url) return
      if (inPlace && current) {
        if (typed) history.noteTyped(current)
        await commands.run('tabs.navigate', { tabId: current, url })
        return
      }
      // New tabs go to Today of the window's current Space (TB-03, CB-19).
      const tabId = await commands.run('tabs.create', { url }, { windowId })
      if (typed) history.noteTyped(tabId)
    }

    switch (result.kind) {
      case 'tab': {
        if (disposition === 'new-tab') return openUrl(result.url, false)
        if (result.tabId && state.tabs[result.tabId]) {
          await commands.run('tabs.activate', { tabId: result.tabId }, { windowId })
          return
        }
        return openUrl(result.url, false)
      }
      case 'space':
        if (result.spaceId) await commands.run('spaces.switch', { spaceId: result.spaceId }, { windowId })
        return
      case 'action':
        if (result.actionId) await actions.run(result.actionId, { windowId })
        return
      case 'current':
        if (current) await commands.run('tabs.reload', { tabId: current })
        return
      case 'archived':
        return restoreArchived(result, windowId)
      case 'url':
      case 'history':
      case 'paste':
        return openUrl(result.url, true)
      case 'search':
      case 'suggestion':
        return openUrl(result.url, false)
      default:
        return
    }
  })

  /** Restores an archived tab as a new Today tab in the current Space (no forced Space jump, CB-19). */
  const restoreArchived = async (result: SearchResult, windowId: WindowId | undefined) => {
    const id = result.archiveId
    // The archive lane's restore keeps back/forward history; use it once it exists.
    const restore = 'archive.restore' as CommandName
    if (id && commands.has(restore)) {
      await commands.run(restore, { id } as never, { windowId })
      return
    }
    const entry = store.state.archive.find((a) => a.id === id)
    const url = entry?.url ?? result.url
    if (!url) return
    await commands.run('tabs.create', { url }, { windowId })
    if (entry) {
      store.update((d) => {
        const i = d.archive.findIndex((a) => a.id === entry.id)
        if (i >= 0) d.archive.splice(i, 1)
      })
    }
  }

  commands.register('search.remove', async ({ result }, c) => {
    const { profile, isPrivate } = profileOf(store.state, windowOf(c))
    if (!profile || isPrivate) return
    const hs = history.store(profile.id)
    if (result.kind === 'history' && result.url) {
      await hs.delete(result.url)
    } else if (result.kind === 'suggestion' && result.query) {
      const q = result.query.toLowerCase()
      const urls = hs
        .entries()
        .filter((e) => pastSearchOf(e)?.toLowerCase() === q)
        .map((e) => e.url)
      for (const url of urls) await hs.delete(url)
    }
  })

  // KS-19: while the bar is open, ⌘W closes the bar rather than the tab.
  actions.intercept((id, c) => {
    if (id !== 'tab.close') return false
    const windowId = c.windowId ?? windows.focusedWindowId()
    if (!barOpen(windowId)) return false
    closeBar(windowId)
    return true
  })

  // CB-21: the bar closes when its window loses focus.
  store.subscribe((next, prev) => {
    if (next.windows === prev.windows || windows.quitting) return
    for (const [id, win] of Object.entries(next.windows)) {
      if (win.overlay.kind === 'commandbar' && prev.windows[id]?.focused && !win.focused) {
        queueMicrotask(() => closeBar(id))
      }
    }
  })
}
