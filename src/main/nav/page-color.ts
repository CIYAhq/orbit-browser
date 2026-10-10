import { nativeTheme, type WebContents } from 'electron'
import type { TabId } from '../../shared/state'
import type { MainContext } from '../context'
import { NAV_WORLD } from './focus'

/**
 * The page's own background as an opaque #rrggbb: the root's background, else the body's (which
 * then paints the canvas), over the default canvas (white, or Chromium's dark canvas for a page in
 * a dark colour scheme). Any CSS colour format works: a 1-pixel canvas does the conversion.
 */
const PAGE_COLOR = `(() => {
  const root = document.documentElement
  if (!root) return null
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const g = canvas.getContext('2d', { willReadFrequently: true })
  if (!g) return null
  const paint = (color) => {
    g.fillStyle = 'rgba(0, 0, 0, 0)'
    g.fillStyle = color
    g.fillRect(0, 0, 1, 1)
  }
  const style = getComputedStyle(root)
  let color = style.backgroundColor
  g.clearRect(0, 0, 1, 1)
  paint(color)
  if (g.getImageData(0, 0, 1, 1).data[3] === 0 && document.body) color = getComputedStyle(document.body).backgroundColor
  const scheme = style.colorScheme || ''
  const dark = /\\bdark\\b/.test(scheme) && (!/\\blight\\b/.test(scheme) || matchMedia('(prefers-color-scheme: dark)').matches)
  g.clearRect(0, 0, 1, 1)
  g.fillStyle = dark ? '#121212' : '#ffffff'
  g.fillRect(0, 0, 1, 1)
  paint(color)
  const [r, gr, b] = g.getImageData(0, 0, 1, 1).data
  return '#' + [r, gr, b].map((n) => n.toString(16).padStart(2, '0')).join('')
})()`

const HEX = /^#[0-9a-f]{6}$/

/**
 * Each page's background colour (SB-19), kept on its tab (`pageColor`). The page's view is filled
 * with it, so the part of the card a window resize uncovers before the page redraws matches the
 * page instead of flashing white, and the shell's card under the page (seen while the view catches
 * up, and for a sleeping tab) takes it too. A tab that wakes starts from the colour it last had.
 */
export function registerPageColor(ctx: MainContext): void {
  const { store, tabs } = ctx
  const timers = new Map<TabId, NodeJS.Timeout>()

  const apply = (tabId: TabId, contents: WebContents, color: string) => {
    const view = tabs.get(tabId)
    if (view?.webContents === contents) view.setBackgroundColor(color)
    if (!store.state.tabs[tabId] || store.state.tabs[tabId]?.pageColor === color) return
    store.update((d) => {
      const tab = d.tabs[tabId]
      if (tab) tab.pageColor = color
    })
  }

  const probe = async (tabId: TabId, contents: WebContents) => {
    if (contents.isDestroyed()) return
    try {
      const color: unknown = await contents.executeJavaScriptInIsolatedWorld(NAV_WORLD, [{ code: PAGE_COLOR }])
      if (typeof color === 'string' && HEX.test(color) && !contents.isDestroyed()) apply(tabId, contents, color)
    } catch {
      // The page went away or can't be scripted (an error page, a PDF): keep the last colour.
    }
  }

  /** Pages often set their background from script just after loading: look once things settle. */
  const soon = (tabId: TabId, contents: WebContents, ms: number) => {
    clearTimeout(timers.get(tabId))
    timers.set(
      tabId,
      setTimeout(() => {
        timers.delete(tabId)
        void probe(tabId, contents)
      }, ms),
    )
  }

  ctx.hooks.tabCreated.push((tabId, contents) => {
    const known = store.state.tabs[tabId]?.pageColor
    const view = tabs.get(tabId)
    if (known && view?.webContents === contents) view.setBackgroundColor(known)
    contents.on('did-finish-load', () => soon(tabId, contents, 150))
    contents.on('did-navigate-in-page', () => soon(tabId, contents, 300))
    contents.once('destroyed', () => {
      clearTimeout(timers.get(tabId))
      timers.delete(tabId)
    })
  })

  // Pages that follow the system's light/dark setting change colour with it.
  nativeTheme.on('updated', () => {
    for (const tabId of tabs.liveTabIds()) {
      const contents = tabs.get(tabId)?.webContents
      if (contents && !contents.isDestroyed()) soon(tabId, contents, 200)
    }
  })
}
