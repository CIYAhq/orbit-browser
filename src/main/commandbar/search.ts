import { ACTIONS, shortcutsFor } from '../../shared/actions'
import type { SearchResult } from '../../shared/commands/commandbar'
import { matchScore } from '../../shared/match'
import type { WindowId } from '../../shared/state'
import { parseInput, SEARCH_ENGINES } from '../../shared/url'
import type { MainContext } from '../context'
import type { CallContext } from '../registry'
import { activeTabOf } from '../windows'

/** Basic command bar search: open tabs, actions, Spaces and the typed URL/search. */
export function registerSearch(ctx: MainContext): void {
  const { store, commands, actions, windows } = ctx
  const windowOf = (c: CallContext): WindowId | undefined => c.windowId ?? windows.focusedWindowId()

  commands.register('search.query', ({ query, mode }) => {
    const state = store.state
    const q = query.trim()
    const results: SearchResult[] = []
    const engine = state.settings.searchEngine
    if (q) {
      const parsed = parseInput(q, engine)
      if (parsed.kind === 'url') {
        results.push({
          id: `url:${parsed.url}`,
          kind: 'url',
          title: parsed.url,
          subtitle: 'Open URL',
          url: parsed.url,
          score: 90,
        })
      }
      results.push({
        id: `search:${q}`,
        kind: 'search',
        title: q,
        subtitle: `Search ${SEARCH_ENGINES[engine].name}`,
        url: parsed.kind === 'search' ? parsed.url : SEARCH_ENGINES[engine].search.replace('%s', encodeURIComponent(q)),
        score: parsed.kind === 'url' ? 10 : 50,
      })
      for (const tab of Object.values(state.tabs)) {
        const title = tab.customTitle ?? tab.title
        const score = Math.max(matchScore(q, title), matchScore(q, tab.url) * 0.9)
        if (score > 0) {
          const space = state.spaces[tab.spaceId]
          results.push({
            id: `tab:${tab.id}`,
            kind: 'tab',
            title,
            subtitle: `Switch to tab${space ? ` · ${space.name}` : ''}`,
            url: tab.url,
            favicon: tab.favicon,
            tabId: tab.id,
            spaceId: tab.spaceId,
            score: score + 15,
          })
        }
      }
      if (mode !== 'edit-url') {
        for (const action of ACTIONS) {
          if (action.hidden) continue
          const score = Math.max(
            matchScore(q, action.title),
            ...(action.keywords ?? []).map((k) => matchScore(q, k) * 0.8),
          )
          if (score > 20) {
            results.push({
              id: `action:${action.id}`,
              kind: 'action',
              title: action.title,
              subtitle: shortcutsFor(action, process.platform)[0],
              actionId: action.id,
              score: score + 5,
            })
          }
        }
        for (const spaceId of state.spaceOrder) {
          const space = state.spaces[spaceId]
          if (!space) continue
          const score = matchScore(q, space.name)
          if (score > 20) {
            results.push({
              id: `space:${spaceId}`,
              kind: 'space',
              title: space.name,
              subtitle: 'Switch to Space',
              spaceId,
              score,
            })
          }
        }
      }
    } else if (mode === 'new-tab' || mode === 'search-tabs') {
      // Empty query: most recently used tabs of all Spaces.
      const recent = Object.values(state.tabs)
        .filter((t) => t.url && t.url !== 'about:blank')
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        .slice(0, 6)
      for (const [i, tab] of recent.entries()) {
        results.push({
          id: `tab:${tab.id}`,
          kind: 'tab',
          title: tab.customTitle ?? tab.title,
          subtitle: 'Switch to tab',
          url: tab.url,
          favicon: tab.favicon,
          tabId: tab.id,
          spaceId: tab.spaceId,
          score: 50 - i,
        })
      }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, 12)
  })

  commands.register('search.open', async ({ result, mode, disposition }, c) => {
    const windowId = windowOf(c)
    if (windowId) {
      store.update((d) => {
        const win = d.windows[windowId]
        if (win) win.overlay = { kind: 'none' }
      })
    }
    switch (result.kind) {
      case 'tab':
        if (result.tabId) await commands.run('tabs.activate', { tabId: result.tabId }, { windowId })
        return
      case 'space':
        if (result.spaceId) await commands.run('spaces.switch', { spaceId: result.spaceId }, { windowId })
        return
      case 'action':
        if (result.actionId) await actions.run(result.actionId, { windowId })
        return
      default: {
        if (!result.url) return
        const current = windowId ? activeTabOf(store.state, windowId) : null
        if (mode === 'edit-url' && current && disposition !== 'new-tab') {
          await commands.run('tabs.navigate', { tabId: current, url: result.url })
        } else {
          await commands.run('tabs.create', { url: result.url }, { windowId })
        }
      }
    }
  })
}
