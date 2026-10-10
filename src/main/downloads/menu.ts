import type { MenuItemConstructorOptions } from 'electron'
import type { DownloadEntry } from '../../shared/commands/downloads'

/** What a download's menu can do. */
export interface DownloadMenuActions {
  open: () => void
  showInFolder: () => void
  copyFile: () => void
  copyLink: () => void
  pause: () => void
  resume: () => void
  retry: () => void
  cancel: () => void
  remove: () => void
  delete: () => void
}

/**
 * The menu of a download (right-click on its row, DL-04, DL-08, DL-15), for its state:
 * - running: Pause or Resume, Cancel;
 * - failed: Resume when it can continue, else Retry;
 * - finished: Open, Show in Finder (Show in Folder), Copy File, Delete File (to the Trash);
 *   a file moved or deleted since shows "File Missing" and Download Again.
 * Every one copies its download link; a stopped one can be removed from the list.
 */
export function downloadMenu(
  d: DownloadEntry,
  a: DownloadMenuActions,
  platform: string = process.platform,
): MenuItemConstructorOptions[] {
  const separator: MenuItemConstructorOptions = { type: 'separator' }
  const copyLink: MenuItemConstructorOptions = { label: 'Copy Download Link', click: a.copyLink }
  const remove: MenuItemConstructorOptions = { label: 'Remove from List', click: a.remove }
  switch (d.state) {
    case 'progressing':
    case 'paused':
      return [
        d.state === 'paused' ? { label: 'Resume', click: a.resume } : { label: 'Pause', click: a.pause },
        { label: 'Cancel', click: a.cancel },
        separator,
        copyLink,
      ]
    case 'interrupted':
      return [
        d.canResume ? { label: 'Resume', click: a.resume } : { label: 'Retry', click: a.retry },
        separator,
        copyLink,
        separator,
        remove,
      ]
    case 'cancelled':
      return [{ label: 'Retry', click: a.retry }, separator, copyLink, separator, remove]
    case 'completed':
      if (d.missing) {
        return [
          { label: 'File Missing', enabled: false },
          { label: 'Download Again', click: a.retry },
          separator,
          copyLink,
          separator,
          remove,
        ]
      }
      return [
        { label: 'Open', click: a.open },
        { label: platform === 'darwin' ? 'Show in Finder' : 'Show in Folder', click: a.showInFolder },
        separator,
        { label: 'Copy File', click: a.copyFile },
        copyLink,
        separator,
        remove,
        { label: 'Delete File', click: a.delete },
      ]
  }
}
