import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import type { TabId } from '../../shared/state'
import type { MainContext } from '../context'
import { activeTabOf } from '../windows'
import { MEDIA_WORLD } from './agent'
import { MediaManager } from './manager'

/**
 * Hardware media keys (play/pause, next, previous) control the playing media and the PiP video, as
 * in other browsers (MD-05, KS-11). Electron leaves Chromium's handling off; it has to be switched
 * on before the app is ready, so this runs when the module loads. Merged into any features other
 * modules enabled.
 */
function enableFeatures(...names: string[]): void {
  const current = app.commandLine.getSwitchValue('enable-features')
  const list = current ? current.split(',').filter(Boolean) : []
  for (const name of names) if (!list.includes(name)) list.push(name)
  app.commandLine.appendSwitch('enable-features', list.join(','))
}
enableFeatures('HardwareMediaKeyHandling')

/** Test-only handle (ORBIT_E2E=1): globalThis.__orbitMedia. */
export interface MediaTestHooks {
  manager: MediaManager
  lastMenu: () => string[]
  clickMenu: (path: string) => boolean
  /** The floating player's last "…" menu. */
  playerMenu: () => string[]
  clickPlayerMenu: (path: string) => boolean
}

/** Picture-in-picture, sidebar media controls and call controls (media lane; spec media.md). */
export function registerMedia(ctx: MainContext): MediaManager {
  const media = new MediaManager(ctx)
  media.start()
  const { commands, actions, store, windows } = ctx
  const windowOf = (windowId: string | undefined) => windowId ?? windows.focusedWindowId()

  commands.register('media.control', ({ tabId, action, seconds }) => media.control(tabId, action, seconds))
  commands.register('media.pip', async ({ tabId, on = true, from }, c) => {
    const windowId = windowOf(c.windowId)
    const id = tabId ?? (windowId ? activeTabOf(store.state, windowId) : null)
    return id ? media.setPip(id, on, from && windowId ? { windowId, rect: from } : undefined) : false
  })
  commands.register('media.dismiss', ({ tabId }) => media.dismiss(tabId))
  commands.register('media.focus', ({ tabId }, c) => {
    const windowId = windowOf(c.windowId)
    if (windowId) media.focusTab(tabId, windowId)
  })
  commands.register('media.menu', ({ tabId }, c) => {
    const windowId = windowOf(c.windowId)
    const items = media.menu(tabId, windowId)
    if (items.length === 0) return
    media.lastMenu = items
    if (ctx.e2e) return
    const win = windowId ? windows.get(windowId) : undefined
    Menu.buildFromTemplate(items).popup(win ? { window: win } : undefined)
  })
  commands.register('media.sitePip', ({ url }) => media.sitePip(url))
  commands.register('media.setSitePip', ({ url, mode }) => media.setSitePip(url, mode))
  commands.register('media.call', ({ tabId, action }) => media.callControl(tabId, action))

  // The floating player's own controls (MD-04 to MD-07).
  const player = media.player
  commands.register('media.pipBack', () => player.back())
  commands.register('media.pipClose', () => player.close('close'))
  commands.register('media.pipMenu', ({ x, y }) => player.menu(x, y))
  commands.register('media.pipZoom', ({ factor, x, y }) => player.zoom(factor, x, y))
  ctx.events.on('media.pipGesture', (e) => player.onGesture(e))

  // Picture in Picture for the selected tab's video (MD-02), and the global switch (MD-08, ST-10).
  actions.register('media.togglePip', ({ windowId }) => {
    const id = windowId ? activeTabOf(store.state, windowId) : null
    if (!id) return
    void media.setPip(id, !store.state.tabs[id]?.media?.pip)
  })
  actions.register('media.toggleAutoPip', ({ windowId }) => {
    const on = !store.state.settings.autoPip
    store.update((d) => {
      d.settings.autoPip = on
    })
    ctx.toast(windowId, on ? 'Automatic Picture in Picture is on' : 'Automatic Picture in Picture is off')
  })

  // The page's right-click menu on a video offers Picture in Picture (MD-02).
  ctx.hooks.pageContextMenu ??= []
  ctx.hooks.pageContextMenu.push((tabId, contents, params): MenuItemConstructorOptions[] => {
    if (params.mediaType !== 'video' || !params.mediaFlags?.canShowPictureInPicture) return []
    const showing = params.mediaFlags.isShowingPictureInPicture
    const zoom = contents.getZoomFactor() || 1
    const x = Math.round(params.x / zoom)
    const y = Math.round(params.y / zoom)
    // The video under the pointer, not the page's main one.
    const code = showing
      ? 'document.exitPictureInPicture().then(() => true, () => false)'
      : `(() => { const el = document.elementFromPoint(${x}, ${y}); const v = el && (el.tagName === 'VIDEO' ? el : el.closest('video')); return v ? v.requestPictureInPicture().then(() => true, () => false) : false })()`
    return [
      {
        label: 'Picture in Picture',
        type: 'checkbox',
        checked: showing,
        click: () => {
          void contents
            .executeJavaScriptInIsolatedWorld(MEDIA_WORLD, [{ code }], true)
            .catch(() => false)
            // The page script follows picture-in-picture from now on (tray, return to the tab).
            .then(() => media.watchTab(tabId as TabId))
        },
      },
      { type: 'separator' },
    ]
  })

  if (ctx.e2e) {
    const hooks: MediaTestHooks = {
      manager: media,
      lastMenu: () => flatLabels(media.lastMenu),
      clickMenu: (path) => clickMenuPath(media.lastMenu, path),
      playerMenu: () => flatLabels(player.lastMenu),
      clickPlayerMenu: (path) => clickMenuPath(player.lastMenu, path),
    }
    ;(globalThis as unknown as { __orbitMedia: MediaTestHooks }).__orbitMedia = hooks
  }
  return media
}

function flatLabels(items: MenuItemConstructorOptions[], prefix = ''): string[] {
  const out: string[] = []
  for (const item of items) {
    if (!item.label) continue
    out.push(`${prefix}${item.label}`)
    if (Array.isArray(item.submenu)) out.push(...flatLabels(item.submenu, `${prefix}${item.label} > `))
  }
  return out
}

function clickMenuPath(items: MenuItemConstructorOptions[], path: string): boolean {
  const [head, ...rest] = path.split(' > ')
  const item = items.find((i) => i.label === head)
  if (!item) return false
  if (rest.length > 0) return Array.isArray(item.submenu) ? clickMenuPath(item.submenu, rest.join(' > ')) : false
  ;(item.click as (() => void) | undefined)?.()
  return !!item.click
}
