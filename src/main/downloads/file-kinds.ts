/**
 * Files on the clipboard (DL-04); what kind of file a download is lives in the shared
 * `commands/downloads.ts` (`fileKind`, `showsInline`). Pure Node, unit-tested.
 */
import { pathToFileURL } from 'node:url'

export { showsInline } from '../../shared/commands/downloads'

/** A raw clipboard format of the OS, by name (Electron's clipboard). */
const raw = (format: string) => `electron application/osclipboard;format="${format}"`

/**
 * What the clipboard holds for a copied file: its path as text, and its file URL in the formats file
 * managers paste as the file itself (`text/uri-list`; GNOME's copied-files list on Linux, a file URL
 * on macOS).
 */
export function fileClipboardData(path: string, platform: string = process.platform): Record<string, string> {
  const url = pathToFileURL(path).href
  const data: Record<string, string> = { 'text/plain': path, 'text/uri-list': url }
  if (platform === 'linux') data[raw('x-special/gnome-copied-files')] = `copy\n${url}`
  if (platform === 'darwin') data[raw('public.file-url')] = url
  return data
}
