import { join } from 'node:path'
import { app, dialog, type WebContents } from 'electron'
import type { MainContext } from '../context'
import { withDialog } from '../media/dialog-watch'
import { saveFormat, savesComplete } from '../nav/page-menu'
import { setPageEntries } from './entry'

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

/**
 * Save Page As… (NV-21): ⇧⌘S (Ctrl+Shift+S; ⌘S is the sidebar's), File → Save As… (macOS), the
 * command bar and the page menu. The OS save dialog asks where, from the Downloads folder, named after
 * the page. A local page whose frames are all local files saves complete, its resources copied beside
 * it; any other page as a single file (MHTML) or as its HTML alone, so a web page never has Orbit copy
 * a local file (D49, `savesComplete` in src/main/nav/page-menu.ts). A Peek's or a Mini Window's page
 * saves itself. Tests answer the dialog by replacing `dialog.showSaveDialog`, as for any save.
 */
export function registerSavePage(ctx: MainContext): void {
  const save = (page: WebContents) => {
    if (page.isDestroyed()) return
    const windowId = ctx.windows.windowIdFor(page)
    const win = windowId ? ctx.windows.get(windowId) : undefined
    const complete = savesComplete(page)
    const name = join(app.getPath('downloads'), fileName(page.getTitle()))
    const single = { name: 'Web Page, Single File', extensions: ['mhtml'] }
    const html = { name: complete ? 'Web Page, Complete' : 'Web Page, HTML Only', extensions: ['html', 'htm'] }
    const options = complete
      ? { defaultPath: `${name}.html`, filters: [html, single] }
      : { defaultPath: `${name}.mhtml`, filters: [single, html] }
    // The picture-in-picture player keeps clear of it (MD-06).
    const asked =
      win && !win.isDestroyed() ? withDialog(win, dialog.showSaveDialog(win, options)) : dialog.showSaveDialog(options)
    void asked.then(({ canceled, filePath }) => {
      if (canceled || !filePath || page.isDestroyed()) return
      // Asked again: the page may have changed while the dialog was open.
      const format = saveFormat(complete && savesComplete(page), filePath)
      page.savePage(filePath, format).catch((err: unknown) => console.error('[pages] save page', err))
    })
  }
  setPageEntries({ savePage: save })
}
