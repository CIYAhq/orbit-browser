import { join } from 'node:path'
import { app, type ContextMenuParams, dialog, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { isPrivateTab } from '../../shared/private'
import type { TabId, WindowId } from '../../shared/state'
import { SEARCH_ENGINES } from '../../shared/url'
import type { MainContext } from '../context'
import { NAV_WORLD } from './focus'

/**
 * The page context menu's items from the chrome lane (NV-12), added to the tabs lane's menu
 * (`tabs/context-menu.ts`): opening links in new and private windows, saving links and pages,
 * printing, page source, spelling and Look Up. In tests the menu is kept instead of shown.
 */

type From = { tabId?: TabId; windowId?: WindowId }

interface LinkOpeners {
  /** A link in a new window (a private one from a private window). */
  window: (url: string, from: From) => void
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
 * Open Link in New Window / in Private Window. A private window opens both as private windows,
 * so it shows only the first (NV-11).
 */
export function linkWindowItems(ctx: MainContext, tabId: TabId, url: string): MenuItemConstructorOptions[] {
  if (!openers) return []
  const from = (): From => ({ tabId, windowId: ctx.windows.windowOfTab(tabId) })
  const items: MenuItemConstructorOptions[] = [
    { label: 'Open Link in New Window', click: () => openers?.window(url, from()) },
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

/** Search [engine] for “…” (the search engine named, NV-12). */
export function searchLabel(ctx: MainContext, selection: string): string {
  const engine = SEARCH_ENGINES[ctx.store.state.settings.searchEngine] ?? SEARCH_ENGINES.google
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

/** In tests, keeps the menu for the test hooks instead of showing it. True when kept. */
export function keepPageMenu(ctx: MainContext, tabId: TabId, items: MenuItemConstructorOptions[]): boolean {
  if (!ctx.e2e) return false
  shown = { items, tabId }
  return true
}

const labelOf = (item: MenuItemConstructorOptions) => item.label ?? (item.role ? `role:${item.role}` : '')

export interface PageMenuTestHooks {
  /** The page menu last opened: its items' labels (`role:copy` for built-in ones; `-` for separators), or null. */
  pageMenu: () => { tabId: TabId; labels: string[]; enabled: Record<string, boolean> } | null
  /** Chooses an item of the page menu by label (`Menu > Item` for one in a submenu). */
  choosePageMenu: (label: string) => boolean
}

export const pageMenuTestHooks: PageMenuTestHooks = {
  pageMenu: () => {
    if (!shown) return null
    const enabled: Record<string, boolean> = {}
    for (const item of shown.items) if (item.type !== 'separator') enabled[labelOf(item)] = item.enabled !== false
    return {
      tabId: shown.tabId,
      labels: shown.items.map((i) => (i.type === 'separator' ? '-' : labelOf(i))),
      enabled,
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
