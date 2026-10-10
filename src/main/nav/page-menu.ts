import { join } from 'node:path'
import { app, type ContextMenuParams, dialog, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { type PageReferrer, referrerPolicyName } from '../../shared/nav'
import { isPrivateTab } from '../../shared/private'
import type { TabId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import type { TabPage } from '../tabs/ops'
import { NAV_WORLD } from './focus'

/**
 * The page context menu's items from the chrome lane (NV-12), added to the tabs lane's menu
 * (`tabs/context-menu.ts`): opening links in new and private windows, saving links and pages,
 * printing, page source, spelling and Look Up. In tests the menu is kept instead of shown.
 */

type From = { tabId?: TabId; windowId?: WindowId }

interface LinkOpeners {
  /** A link in a new background tab, loaded with `referrer` (review B-F1). */
  tab: (url: string, from: From, referrer: PageReferrer) => void
  /** A link in a new window (a private one from a private window). */
  window: (url: string, from: From, page?: TabPage) => void
  /** A link in a new private window. */
  private: (url: string, from: From) => void
}

let openers: LinkOpeners | undefined
let shown: { items: MenuItemConstructorOptions[]; tabId: TabId } | null = null

/** Set once by the nav module (it owns the windows these open). */
export function setLinkOpeners(next: LinkOpeners): void {
  openers = next
}

/**
 * The referrer for what the page menu opens: the frame the menu is over, trimmed by that frame's
 * policy, as a click there would send it (review B-F1).
 */
export function menuReferrer(params: ContextMenuParams): PageReferrer {
  // Typed as a Referrer, but Electron passes the policy's name.
  const raw = params.referrerPolicy as unknown
  const policy = typeof raw === 'string' ? raw : (raw as { policy?: string } | undefined)?.policy
  return { url: params.frameURL || params.pageURL, policy: referrerPolicyName(policy) }
}

/**
 * Open Link (or Image) in New Tab: a background tab, loaded with the page as referrer (review
 * B-F1). False when the nav module isn't there to open it.
 */
export function openLinkInTab(ctx: MainContext, tabId: TabId, url: string, referrer: PageReferrer): boolean {
  if (!openers) return false
  openers.tab(url, { tabId, windowId: ctx.windows.windowOfTab(tabId) }, referrer)
  return true
}

/**
 * Open Link in New Window / in Private Window. A private window opens both as private windows,
 * so it shows only the first (NV-11). A new window gets `referrer`; a private one from a normal
 * window gets none, so it doesn't tell the site where the link was.
 */
export function linkWindowItems(
  ctx: MainContext,
  tabId: TabId,
  url: string,
  referrer?: PageReferrer,
): MenuItemConstructorOptions[] {
  if (!openers) return []
  const from = (): From => ({ tabId, windowId: ctx.windows.windowOfTab(tabId) })
  const page: TabPage = referrer ? { load: { httpReferrer: referrer } } : {}
  const items: MenuItemConstructorOptions[] = [
    { label: 'Open Link in New Window', click: () => openers?.window(url, from(), page) },
  ]
  if (!isPrivateTab(ctx.store.state, tabId)) {
    items.push({ label: 'Open Link in Private Window', click: () => openers?.private(url, from()) })
  }
  return items
}

/** Save Link As…: the link as a download, which asks where to save it. */
export function saveLinkItem(contents: WebContents, url: string): MenuItemConstructorOptions {
  return { label: 'Save Link As…', click: () => contents.downloadURL(url) }
}

/** Search [engine] for “…”, naming the engine the item searches with (NV-12). */
export function searchLabel(engine: { name: string }, selection: string): string {
  const text = selection.trim()
  return `Search ${engine.name} for “${text.slice(0, 40)}${text.length > 40 ? '…' : ''}”`
}

/** Look Up “…” (macOS: the system dictionary panel for the selection). */
export function lookUpItems(contents: WebContents, selection: string): MenuItemConstructorOptions[] {
  if (process.platform !== 'darwin') return []
  const text = selection.trim()
  return [
    {
      label: `Look Up “${text.slice(0, 24)}${text.length > 24 ? '…' : ''}”`,
      click: () => contents.showDefinitionForSelection(),
    },
  ]
}

/** Add to Dictionary for a misspelled word (not in private windows: their dictionary isn't kept). */
export function dictionaryItems(contents: WebContents, params: ContextMenuParams): MenuItemConstructorOptions[] {
  const word = params.misspelledWord
  if (!word || !contents.session.isPersistent()) return []
  return [{ label: 'Add to Dictionary', click: () => contents.session.addWordToSpellCheckerDictionary(word) }]
}

/**
 * Writing Direction for a text field (NV-12): Default, Left to Right or Right to Left, set on the
 * field itself (its `dir`), so the page's own text and layout don't change.
 */
export function writingDirectionItem(contents: WebContents): MenuItemConstructorOptions {
  const set = (dir: '' | 'ltr' | 'rtl') => () => {
    if (contents.isDestroyed()) return
    const code = `(() => {
      let el = document.activeElement
      while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement
      if (!el || !(el.isContentEditable || el.localName === 'input' || el.localName === 'textarea')) return
      if (${JSON.stringify(dir)}) el.setAttribute('dir', ${JSON.stringify(dir)})
      else el.removeAttribute('dir')
    })()`
    contents.executeJavaScriptInIsolatedWorld(NAV_WORLD, [{ code }]).catch(() => {})
  }
  return {
    label: 'Writing Direction',
    submenu: [
      { label: 'Default', click: set('') },
      { label: 'Left to Right', click: set('ltr') },
      { label: 'Right to Left', click: set('rtl') },
    ],
  }
}

/** A file name from a page title, without characters file systems refuse. */
function fileName(title: string): string {
  const printable = Array.from(title, (c) => (c.charCodeAt(0) < 32 ? ' ' : c)).join('')
  const clean = printable
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return clean || 'Page'
}

/** Save Page As… (the page with its resources), Print… and View Page Source. */
export function pageItems(ctx: MainContext, tabId: TabId, contents: WebContents): MenuItemConstructorOptions[] {
  return [
    {
      label: 'Save Page As…',
      click: () => {
        const win = ctx.windows.get(ctx.windows.windowOfTab(tabId) ?? '')
        const defaultPath = join(app.getPath('downloads'), `${fileName(contents.getTitle())}.html`)
        const options = { defaultPath, filters: [{ name: 'Web Page, Complete', extensions: ['html', 'htm'] }] }
        void (win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)).then(
          ({ canceled, filePath }) => {
            if (canceled || !filePath || contents.isDestroyed()) return
            contents.savePage(filePath, 'HTMLComplete').catch((err) => console.error('[nav] save page', err))
          },
        )
      },
    },
    { label: 'Print…', click: () => contents.print() },
    { type: 'separator' },
    {
      label: 'View Page Source',
      click: () => {
        const url = contents.getURL()
        if (!url || url.startsWith('view-source:')) return
        const tab = ctx.store.state.tabs[tabId]
        const windowId = ctx.windows.windowOfTab(tabId)
        void ctx.commands
          .run('tabs.create', { url: `view-source:${url}`, spaceId: tab?.spaceId, activate: true }, { windowId })
          .catch(() => {})
      },
    },
  ]
}

/**
 * Loop and Show Controls for the video or audio right-clicked (NV-12), ticked as the element is;
 * media adds Picture in Picture after them. Each is greyed where the engine says it can't be done:
 * a live stream doesn't loop, and an audio player's controls stay, as without them it would be gone
 * with no way back.
 */
export function mediaItems(contents: WebContents, params: ContextMenuParams): MenuItemConstructorOptions[] {
  if (params.mediaType !== 'video' && params.mediaType !== 'audio') return []
  const flags = params.mediaFlags
  const set = (property: 'loop' | 'controls', on: boolean) => () => void setMedia(contents, params, property, on)
  return [
    {
      label: 'Loop',
      type: 'checkbox',
      checked: flags.isLooping,
      enabled: flags.canLoop,
      click: set('loop', !flags.isLooping),
    },
    {
      label: 'Show Controls',
      type: 'checkbox',
      checked: flags.isControlsVisible,
      enabled: flags.canToggleControls,
      click: set('controls', !flags.isControlsVisible),
    },
  ]
}

/**
 * Sets `loop` or `controls` on the media element the menu was opened over: the one under the
 * pointer, or in a frame inside the page (where the pointer's place is the page's, not the
 * frame's) the frame's element playing the same source.
 */
async function setMedia(
  contents: WebContents,
  params: ContextMenuParams,
  property: 'loop' | 'controls',
  on: boolean,
): Promise<void> {
  const bySource = `[...document.querySelectorAll('video, audio')].find((m) => m.currentSrc === ${JSON.stringify(params.srcURL)})`
  try {
    if (params.frame?.parent) {
      await params.frame.executeJavaScript(`(() => { const m = ${bySource}; if (m) m.${property} = ${on} })()`)
      return
    }
    const zoom = contents.getZoomFactor() || 1
    const x = Math.round(params.x / zoom)
    const y = Math.round(params.y / zoom)
    const code = `(() => { const at = document.elementFromPoint(${x}, ${y}); const m = (at && at.closest('video, audio')) || ${bySource}; if (m) m.${property} = ${on} })()`
    await contents.executeJavaScriptInIsolatedWorld(NAV_WORLD, [{ code }])
  } catch {
    // The page or its frame went away meanwhile.
  }
}

/** In tests, keeps the menu for the test hooks instead of showing it. True when kept. */
export function keepPageMenu(ctx: MainContext, tabId: TabId, items: MenuItemConstructorOptions[]): boolean {
  if (!ctx.e2e) return false
  shown = { items, tabId }
  return true
}

const labelOf = (item: MenuItemConstructorOptions) => item.label ?? (item.role ? `role:${item.role}` : '')

export interface PageMenuTestHooks {
  /**
   * The page menu last opened: its items' labels (`role:copy` for built-in ones; `-` for separators),
   * which are enabled, and whether each tickable one is ticked; or null.
   */
  pageMenu: () => {
    tabId: TabId
    labels: string[]
    enabled: Record<string, boolean>
    checked: Record<string, boolean>
  } | null
  /** Chooses an item of the page menu by label (`Menu > Item` for one in a submenu). */
  choosePageMenu: (label: string) => boolean
}

export const pageMenuTestHooks: PageMenuTestHooks = {
  pageMenu: () => {
    if (!shown) return null
    const enabled: Record<string, boolean> = {}
    const checked: Record<string, boolean> = {}
    for (const item of shown.items) {
      if (item.type !== 'separator') enabled[labelOf(item)] = item.enabled !== false
      if (item.type === 'checkbox' || item.type === 'radio') checked[labelOf(item)] = !!item.checked
    }
    return {
      tabId: shown.tabId,
      labels: shown.items.map((i) => (i.type === 'separator' ? '-' : labelOf(i))),
      enabled,
      checked,
    }
  },
  choosePageMenu: (label) => {
    let items = shown?.items ?? []
    const path = label.split(' > ')
    let item: MenuItemConstructorOptions | undefined
    for (const part of path) {
      item = items.find((i) => i.type !== 'separator' && labelOf(i) === part)
      items = Array.isArray(item?.submenu) ? item.submenu : []
    }
    if (!item?.click) return false
    shown = null
    ;(item.click as () => void)()
    return true
  },
}
