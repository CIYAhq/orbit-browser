import { clipboard, net } from 'electron'
import type { SearchQueryArgs, SearchResult } from '../../shared/commands/commandbar'
import type { CommandName } from '../../shared/rpc'
import type { OrbitState, WindowId } from '../../shared/state'
import { fillSearchTemplate, parseInput, SEARCH_ENGINES } from '../../shared/url'
import type { MainContext } from '../context'
import type { HistoryService } from '../history'
import type { CallContext } from '../registry'
import { activeTabOf } from '../windows'
import { pastSearchOf, type RankInput, rank } from './rank'
import { SourceCache } from './sources'
import { parseSuggestions } from './suggest'

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

  const buildInput = (args: SearchQueryArgs, windowId: WindowId | undefined, clip?: string): RankInput => {
    const state = store.state
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
      folders: isPrivate ? [] : sources.folders(state),
      actions: sources.actions((id) => actions.has(id), process.platform),
      siteSearches,
      scope: args.siteSearchId ? siteSearches.find((s) => s.id === args.siteSearchId) : undefined,
      actionsOnly: args.actionsOnly,
      noAutocomplete: args.noAutocomplete,
      clipboardUrl: clip,
    }
    return input
  }

  commands.register('search.query', async (args, c) => {
    const wantsClipboard = args.mode === 'new-tab' && !args.query.trim() && !args.actionsOnly && !args.siteSearchId
    const clip = wantsClipboard ? await clipboardUrl() : undefined
    const t0 = performance.now()
    const response = rank(buildInput(args, windowOf(c), clip))
    queryTimings.push(performance.now() - t0)
    if (queryTimings.length > 200) queryTimings.splice(0, 100)
    return response
  })

  // Warm per-entry caches and the JIT once history has loaded, so the first keystroke is as fast as later ones.
  setTimeout(() => {
    const windowId = windows.focusedWindowId()
    const { profile, isPrivate } = profileOf(store.state, windowId)
    if (!profile || isPrivate) return
    void history
      .store(profile.id)
      .load()
      .then(() => {
        for (const query of ['', 'e', 'ex']) rank(buildInput({ query, mode: 'new-tab' }, windowId))
      })
  }, 1500)

  // CB-15: engine suggestions, only when the user turned them on (they send keystrokes to the engine).
  commands.register('search.suggest', async ({ query }) => {
    const state = store.state
    const q = query.trim()
    if (!state.settings.searchSuggestions || !q || q.length > 200) return []
    const engine = SEARCH_ENGINES[state.settings.searchEngine] ?? SEARCH_ENGINES.google
    // Tests point this at a local fixture; it is never read outside the e2e harness.
    const template = (ctx.e2e && process.env.ORBIT_SUGGEST_URL) || engine.suggest
    if (!template) return []
    try {
      const res = await net.fetch(fillSearchTemplate(template, q), {
        credentials: 'omit',
        signal: AbortSignal.timeout(1500),
      })
      if (!res.ok) return []
      return parseSuggestions(await res.json(), q)
        .slice(0, 4)
        .map(
          (text): SearchResult => ({
            id: `engine:${text.toLowerCase()}`,
            kind: 'suggestion',
            title: text,
            subtitle: `Search ${engine.name}`,
            label: 'Suggestion',
            url: fillSearchTemplate(engine.search, text),
            query: text,
            score: 0,
          }),
        )
    } catch {
      return [] // Offline or slow: local results stand on their own.
    }
  })

  commands.register('search.forwardClick', ({ x, y }, c) => {
    const contents = windows.get(windowOf(c) ?? '')?.webContents
    if (!contents || contents.isDestroyed() || !Number.isFinite(x) || !Number.isFinite(y)) return
    const at = { x: Math.round(x), y: Math.round(y) }
    contents.sendInputEvent({ type: 'mouseMove', ...at })
    contents.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 })
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
      case 'folder': {
        // FD-09: open the folder (expanded) where it lives.
        if (!result.folderId || !state.folders[result.folderId]) return
        if (result.spaceId && result.spaceId !== state.windows[windowId ?? '']?.spaceId) {
          await commands.run('spaces.switch', { spaceId: result.spaceId }, { windowId })
        }
        await commands.run('folders.setCollapsed', { folderId: result.folderId, collapsed: false })
        return
      }
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

  // CB-21: the bar closes when its window loses focus. Not under the e2e harness: parallel
  // test apps share one display and take focus from each other.
  store.subscribe((next, prev) => {
    if (next.windows === prev.windows || windows.quitting || ctx.e2e) return
    for (const [id, win] of Object.entries(next.windows)) {
      if (win.overlay.kind === 'commandbar' && prev.windows[id]?.focused && !win.focused) {
        queueMicrotask(() => closeBar(id))
      }
    }
  })
}
