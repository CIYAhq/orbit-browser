import { createProfile, createSpace, DEFAULT_PROFILE_ID, THEME_PRESETS } from '../../shared/defaults'
import type { SpaceTheme, WindowId } from '../../shared/state'
import { tabsInItem } from '../../shared/tree'
import type { MainContext } from '../context'
import type { CallContext } from '../registry'

export function registerSpaces(ctx: MainContext): void {
  const { store, commands, actions, windows } = ctx
  const windowOf = (c: CallContext): WindowId | undefined => c.windowId ?? windows.focusedWindowId()

  const switchTo = (windowId: WindowId | undefined, spaceId: string) => {
    if (!windowId || !store.state.spaces[spaceId]) return
    ctx.perf.mark('space:switch:start')
    store.update((d) => {
      const win = d.windows[windowId]
      if (win && win.spaceId !== spaceId) win.spaceId = spaceId
    })
  }

  commands.register('spaces.create', ({ name, icon = '', theme, profileId, activate = true }, c) => {
    const state = store.state
    const n = state.spaceOrder.length
    const preset = THEME_PRESETS[n % THEME_PRESETS.length] as SpaceTheme
    const profile = profileId && state.profiles[profileId] ? profileId : DEFAULT_PROFILE_ID
    const space = createSpace(name?.trim() || `Space ${n + 1}`, profile, theme ?? preset, icon)
    store.update((d) => {
      d.spaces[space.id] = space
      d.spaceOrder.push(space.id)
    })
    if (activate) switchTo(windowOf(c), space.id)
    return space.id
  })

  commands.register('spaces.switch', ({ spaceId }, c) => switchTo(windowOf(c), spaceId))

  commands.register('spaces.update', ({ spaceId, name, icon, theme, profileId }) => {
    const reloadTabs: string[] = []
    store.update((d) => {
      const space = d.spaces[spaceId]
      if (!space) return
      if (name !== undefined && name.trim()) space.name = name.trim()
      if (icon !== undefined) space.icon = icon
      if (theme) space.theme = { ...theme }
      if (profileId && d.profiles[profileId] && profileId !== space.profileId) {
        space.profileId = profileId
        for (const id of [...space.pinned, ...space.today]) {
          for (const tabId of tabsInItem(d, id)) {
            const tab = d.tabs[tabId]
            if (tab) {
              tab.profileId = profileId
              reloadTabs.push(tabId)
            }
          }
        }
      }
    })
    // Tabs moved to another profile must be recreated in that profile's session.
    for (const tabId of reloadTabs) {
      ctx.tabs.savedHistory.delete(tabId)
      ctx.tabs.sleep(tabId)
    }
  })

  commands.register('spaces.delete', ({ spaceId }) => {
    const state = store.state
    const space = state.spaces[spaceId]
    if (!space || state.spaceOrder.length <= 1) return
    const tabIds = [...space.pinned, ...space.today].flatMap((id) => tabsInItem(state, id))
    for (const id of tabIds) ctx.tabs.destroy(id)
    store.update((d) => {
      const index = d.spaceOrder.indexOf(spaceId)
      d.spaceOrder.splice(index, 1)
      const fallback = d.spaceOrder[Math.max(0, index - 1)] as string
      for (const win of Object.values(d.windows)) {
        if (win.spaceId === spaceId) win.spaceId = fallback
        delete win.activeTab[spaceId]
      }
      const dropItem = (id: string) => {
        const folder = d.folders[id]
        if (folder) {
          folder.children.forEach(dropItem)
          delete d.folders[id]
        }
        delete d.splits[id]
      }
      for (const id of [...space.pinned, ...space.today]) dropItem(id)
      for (const tabId of tabIds) {
        const tab = d.tabs[tabId]
        if (tab?.url && tab.url !== 'about:blank') {
          d.archive.unshift({
            id: `a-${tabId}`,
            url: tab.url,
            title: tab.title,
            favicon: tab.favicon,
            spaceId,
            profileId: tab.profileId,
            archivedAt: Date.now(),
            reason: 'closed',
          })
        }
        delete d.tabs[tabId]
      }
      delete d.spaces[spaceId]
    })
  })

  commands.register('spaces.reorder', ({ spaceId, index }) => {
    store.update((d) => {
      const from = d.spaceOrder.indexOf(spaceId)
      if (from < 0) return
      d.spaceOrder.splice(from, 1)
      d.spaceOrder.splice(Math.max(0, Math.min(index, d.spaceOrder.length)), 0, spaceId)
    })
  })

  commands.register('profiles.create', ({ name }) => {
    const profile = createProfile(name.trim() || 'Profile')
    store.update((d) => {
      d.profiles[profile.id] = profile
    })
    return profile.id
  })

  commands.register('profiles.rename', ({ profileId, name }) => {
    store.update((d) => {
      const profile = d.profiles[profileId]
      if (profile && name.trim()) profile.name = name.trim()
    })
  })

  commands.register('profiles.delete', ({ profileId }) => {
    if (profileId === DEFAULT_PROFILE_ID) return
    const state = store.state
    for (const space of Object.values(state.spaces)) {
      if (space.profileId === profileId) {
        void commands.run('spaces.update', { spaceId: space.id, profileId: DEFAULT_PROFILE_ID })
      }
    }
    store.update((d) => {
      const profile = d.profiles[profileId]
      const fallback = d.profiles[DEFAULT_PROFILE_ID]
      if (!profile || !fallback) return
      fallback.favorites.push(...profile.favorites)
      for (const id of profile.favorites)
        for (const tabId of tabsInItem(d, id)) {
          const tab = d.tabs[tabId]
          if (tab) tab.profileId = DEFAULT_PROFILE_ID
        }
      delete d.profiles[profileId]
    })
  })

  // ---- Actions ----
  const step = (delta: number) => (c: CallContext) => {
    const windowId = windowOf(c)
    if (!windowId) return
    const order = store.state.spaceOrder
    const current = order.indexOf(store.state.windows[windowId]?.spaceId ?? '')
    const next = order[Math.max(0, Math.min(order.length - 1, current + delta))]
    if (next) switchTo(windowId, next)
  }
  actions.register('space.next', step(1))
  actions.register('space.previous', step(-1))
  for (let n = 1; n <= 9; n++) {
    actions.register(`space.goto.${n}`, (c) => {
      const spaceId = store.state.spaceOrder[n - 1]
      if (spaceId) switchTo(windowOf(c), spaceId)
    })
  }
  actions.register('space.new', (c) => void commands.run('spaces.create', {}, c))
}
