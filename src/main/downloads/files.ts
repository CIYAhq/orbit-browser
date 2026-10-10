import { ClipboardItem, clipboard, shell } from 'electron'
import { fileClipboardData } from './file-kinds'

/**
 * What Orbit asks the OS to do with a downloaded file (DL-04, DL-08): open it in its app, show it in
 * its folder, move it to the Trash. Test runs swap in a recorder, so they never start another app or
 * touch the real Trash.
 */
export interface FileActions {
  /** Opens a file with the system's app for it; resolves to an error message, '' when it worked. */
  openPath(path: string): Promise<string>
  showItemInFolder(path: string): void
  /** Moves a file to the Trash (Recycle Bin); rejects when it can't. */
  trashItem(path: string): Promise<void>
}

export const systemFiles: FileActions = {
  openPath: (path) => shell.openPath(path),
  showItemInFolder: (path) => shell.showItemInFolder(path),
  trashItem: (path) => shell.trashItem(path),
}

/** Puts a file on the clipboard, to paste in a folder, another app or a page's upload field. */
export function copyFileToClipboard(path: string): Promise<void> {
  return clipboard.write([new ClipboardItem(fileClipboardData(path))])
}
