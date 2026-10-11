import { type ContextMenuParams, clipboard, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { pageMayOpen } from '../../shared/link-routing'
import type { TabId } from '../../shared/state'
import { engineFor, searchUrl } from '../../shared/url'
import type { MainContext } from '../context'
import { PAGE_MENU_KEYS, withKeyHints } from '../keys/menu-hints'
import {
  dictionaryItems,
  keepPageMenu,
  linkWindowItems,
  lookUpItems,
  mediaItems,
  menuReferrer,
  openLinkInTab,
  pageItems,
  saveLinkItem,
  searchLabel,
  writingDirectionItem,
} from '../nav/page-menu'
import { linkPeekMenuItems } from '../peek/menu'
import { linkSplitMenuItems } from '../split/menu'

/** Native right-click menu for web pages. */
export function showPageContextMenu(ctx: MainContext, tabId: TabId, contents: WebContents, params: ContextMenuParams) {
  // Video and audio first: Loop and Show Controls, then what other features add (media: Picture in
  // Picture on a video) (NV-12). The group ends with a separator, whoever added its last item.
  const items: MenuItemConstructorOptions[] = [
    ...mediaItems(contents, params),
    ...(ctx.hooks.pageContextMenu ?? []).flatMap((hook) => hook(tabId, contents, params)),
  ]
  if (items.length > 0 && items.at(-1)?.type !== 'separator') items.push({ type: 'separator' })
  const openInNewTab = (url: string, activate: boolean) => {
    const tab = ctx.store.state.tabs[tabId]
    void ctx.commands.run('tabs.create', { url, spaceId: tab?.spaceId, activate }, {})
  }
  // A link or image from the page: a background tab, with the page as referrer (review B-F1).
  const referrer = menuReferrer(params)
  const openFromPage = (url: string) => {
    if (!openLinkInTab(ctx, tabId, url, referrer)) openInNewTab(url, false)
  }

  // A local file's link or picture on a page that isn't a local file, or an internal page's on a page
  // that isn't one, keeps only its copy items: Orbit opens or saves it for no web page (D49, D53).
  const mayOpen = (url: string) => pageMayOpen(referrer.url, url)
  // A script, a page's source or data is no page to open: the engine names the first two
  // about:blank#blocked here, and would show data as a page of its own (round 2 fix check F6).
  // Copying and saving stay.
  const opensAsPage = (url: string) => !/^\s*(javascript|view-source|data|about):/i.test(url)

  if (params.linkURL) {
    const link = params.linkURL
    const open: MenuItemConstructorOptions[] =
      mayOpen(link) && opensAsPage(link)
        ? [
            { label: 'Open Link in New Tab', click: () => openFromPage(link) },
            // A new pane beside the page's pane (SV-08).
            ...linkSplitMenuItems(ctx, tabId, link, referrer.url),
            // Then Peek and Mini Window, new and private windows: the order NV-12 lists.
            ...linkPeekMenuItems(ctx, tabId, link),
            ...linkWindowItems(ctx, tabId, link, referrer),
          ]
        : []
    items.push(
      ...open,
      { label: 'Copy Link Address', click: () => clipboard.writeText(link) },
      ...(mayOpen(link) ? [saveLinkItem(contents, link)] : []),
      { type: 'separator' },
    )
  }
  if (params.mediaType === 'image' && params.srcURL) {
    const image = params.srcURL
    if (mayOpen(image)) {
      items.push(
        { label: 'Open Image in New Tab', click: () => openFromPage(image) },
        { label: 'Save Image As…', click: () => contents.downloadURL(image) },
      )
    }
    items.push(
      { label: 'Copy Image', click: () => contents.copyImageAt(params.x, params.y) },
      { label: 'Copy Image Address', click: () => clipboard.writeText(image) },
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
    // The engine of the tab's profile, as for a search typed in its Space (ST-06); the item names it.
    const state = ctx.store.state
    const engine = engineFor(state, state.tabs[tabId]?.profileId)
    items.push(
      { role: 'copy' },
      {
        label: searchLabel(engine, params.selectionText),
        click: () => openInNewTab(searchUrl(engine, params.selectionText.trim()), true),
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
      ...pageItems(contents),
      { type: 'separator' },
      { label: 'Copy Page URL', click: () => clipboard.writeText(contents.getURL()) },
      { type: 'separator' },
    )
  }
  items.push({ label: 'Inspect', click: () => contents.inspectElement(params.x, params.y) })
  // Keys lane: shortcut hints (KS-18).
  const hinted = withKeyHints(items, PAGE_MENU_KEYS)
  if (keepPageMenu(ctx, tabId, hinted)) return
  Menu.buildFromTemplate(hinted).popup()
}
