/**
 * What kind of file a download is, for what Orbit does with it (DL-04, DL-13). Pure Node, unit-tested.
 */
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Files Orbit shows in a tab itself instead of handing them to another app. */
const INLINE = new Set([
  // PDF (the engine's viewer)
  '.pdf',
  // images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.bmp',
  '.ico',
  '.svg',
  // plain text
  '.txt',
  '.text',
  '.log',
  '.md',
  '.json',
  // audio and video
  '.mp4',
  '.m4v',
  '.webm',
  '.ogv',
  '.mp3',
  '.m4a',
  '.ogg',
  '.oga',
  '.opus',
  '.wav',
  '.flac',
])

/** Whether Orbit opens this file in a tab (by its extension). */
export function showsInline(path: string): boolean {
  return INLINE.has(extname(path).toLowerCase())
}

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
