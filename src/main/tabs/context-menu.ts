import { type ContextMenuParams, clipboard, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron'
import type { TabId } from '../../shared/state'
import type { MainContext } from '../context'
import {
  dictionaryItems,
  keepPageMenu,
  linkWindowItems,
  lookUpItems,
  menuReferrer,
  openLinkInTab,
  pageItems,
  saveLinkItem,
  searchLabel,
  writingDirectionItem,
} from '../nav/page-menu'
import { linkPeekMenuItems } from '../peek/menu'
import { linkSplitMenuItem } from '../split/menu'

/** Native right-click menu for web pages. */
export function showPageContextMenu(ctx: MainContext, tabId: TabId, contents: WebContents, params: ContextMenuParams) {
  // Items other features add (media: Picture in Picture on a video).
  const items: MenuItemConstructorOptions[] = (ctx.hooks.pageContextMenu ?? []).flatMap((hook) =>
    hook(tabId, contents, params),
  )
  const openInNewTab = (url: string, activate: boolean) => {
    const tab = ctx.store.state.tabs[tabId]
    void ctx.commands.run('tabs.create', { url, spaceId: tab?.spaceId, activate }, {})
  }
  // A link or image from the page: a background tab, with the page as referrer (review B-F1).
  const referrer = menuReferrer(params)
  const openFromPage = (url: string) => {
    if (!openLinkInTab(ctx, tabId, url, referrer)) openInNewTab(url, false)
  }

  if (params.linkURL) {
    items.push(
      { label: 'Open Link in New Tab', click: () => openFromPage(params.linkURL) },
      // A new pane beside the page's pane (SV-08).
      linkSplitMenuItem(ctx, tabId, params.linkURL),
      // Then Peek and Mini Window, new and private windows: the order NV-12 lists.
      ...linkPeekMenuItems(ctx, tabId, params.linkURL),
      ...linkWindowItems(ctx, tabId, params.linkURL, referrer),
      { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
      saveLinkItem(contents, params.linkURL),
      { type: 'separator' },
    )
  }
  if (params.mediaType === 'image' && params.srcURL) {
    items.push(
      { label: 'Open Image in New Tab', click: () => openFromPage(params.srcURL) },
      { label: 'Save Image As…', click: () => contents.downloadURL(params.srcURL) },
      { label: 'Copy Image', click: () => contents.copyImageAt(params.x, params.y) },
      { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) },
      { type: 'separator' },
    )
  }
  if (params.isEditable) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 4)) {
      items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) })
    }
    const dictionary = dictionaryItems(contents, params)
    items.push(...dictionary)
    if (params.dictionarySuggestions.length || dictionary.length) items.push({ type: 'separator' })
    items.push(
      { role: 'undo', enabled: params.editFlags.canUndo },
      { role: 'redo', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { role: 'pasteAndMatchStyle', enabled: params.editFlags.canPaste },
      { role: 'selectAll' },
      writingDirectionItem(contents),
      { type: 'separator' },
    )
  } else if (params.selectionText) {
    items.push(
      { role: 'copy' },
      {
        label: searchLabel(ctx, params.selectionText),
        click: () => {
          const engine = ctx.store.state.settings.searchEngine
          void import('../../shared/url').then(({ searchUrl }) =>
            openInNewTab(searchUrl(engine, params.selectionText.trim()), true),
          )
        },
      },
      ...lookUpItems(contents, params.selectionText),
      { type: 'separator' },
    )
  }
  if (!params.linkURL && !params.isEditable && !params.selectionText && params.mediaType === 'none') {
    items.push(
      {
        label: 'Back',
        enabled: contents.navigationHistory.canGoBack(),
        click: () => contents.navigationHistory.goBack(),
      },
      {
        label: 'Forward',
        enabled: contents.navigationHistory.canGoForward(),
        click: () => contents.navigationHistory.goForward(),
      },
      { label: 'Reload', click: () => contents.reload() },
      { type: 'separator' },
      ...pageItems(ctx, tabId, contents),
      { type: 'separator' },
      { label: 'Copy Page URL', click: () => clipboard.writeText(contents.getURL()) },
      { type: 'separator' },
    )
  }
  items.push({ label: 'Inspect', click: () => contents.inspectElement(params.x, params.y) })
  if (keepPageMenu(ctx, tabId, items)) return
  Menu.buildFromTemplate(items).popup()
}
