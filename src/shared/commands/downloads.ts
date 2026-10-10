import type { Download, ProfileId } from '../state'

/**
 * Owned by the downloads lane: the downloads flow (DL-01), the sidebar's downloads row (DL-02,
 * DL-03), what can be done with a download (DL-04, DL-06, DL-08, DL-12, DL-15), the downloads list
 * and the Library's Downloads and Media sections (DL-10, DL-11), the Library button's recent files
 * (DL-05) and the downloads flyout (DL-14).
 *
 * Two places hold downloads:
 * - `OrbitState.downloads`: the ones the sidebar shows now (running, paused, failed, held, and
 *   finished ones for a few seconds). Small; patched as bytes arrive.
 * - The downloads list: every download of every profile, newest first, in its own file
 *   (`userData/downloads.json`), read with `downloads.list`. Private-window downloads are never in it.
 *
 * Ids: a download's id (`d-…`); the Media section and the recent files also list OS screenshots,
 * whose ids start with `shot-`. `downloads.open`, `preview`, `showInFolder`, `copyFile` and `drag`
 * take either.
 *
 * Main → renderer:
 * - `downloads.changed` ({ profileId }) is broadcast when a profile's list changes.
 * - `downloads.started` (DownloadStarted) goes to the window a download started from, for the
 *   sidebar's start animation (DL-02).
 */
export interface DownloadCommands {
  /** The downloads list of a profile (default: the calling window's), newest first. */
  'downloads.list': { args: { profileId?: ProfileId; limit?: number }; result: DownloadEntry[] }
  /** Cancels a download and deletes its partial file (DL-03 ✕). */
  'downloads.cancel': { args: { id: string }; result: void }
  /** Takes a download off the sidebar's row; it stays in the list. */
  'downloads.dismiss': { args: { id: string }; result: void }
  /** Downloads running or paused now (quitting asks first when there are any, DL-01). */
  'downloads.active': { args: Record<string, never>; result: number }
  /**
   * Opens a finished download (DL-04): in a new tab when Orbit can show it (PDF, image, text, audio,
   * video), else with the system's app for it. False when its file is gone.
   */
  'downloads.open': { args: { id: string }; result: boolean }
  /**
   * Opens a finished download from the Library (DL-09, DL-10): a file Orbit can show previews in a
   * Peek over the Library (`tab`: in a new tab instead); any other opens in its app. False when its
   * file is gone.
   */
  'downloads.preview': { args: { id: string; tab?: boolean }; result: boolean }
  /** Shows the file in Finder / the file manager (DL-04). False when its file is gone. */
  'downloads.showInFolder': { args: { id: string }; result: boolean }
  /** Puts the file on the clipboard, to paste in a folder or another app (DL-04). False when it is gone. */
  'downloads.copyFile': { args: { id: string }; result: boolean }
  /** Copies the address the file was downloaded from (DL-04). */
  'downloads.copyLink': { args: { id: string }; result: void }
  /**
   * Drags the file out of Orbit, as the file itself (DL-06): call it from a `dragstart` (after
   * `preventDefault()`); the drag continues as the OS's. False when there is no file to drag.
   */
  'downloads.drag': { args: { id: string }; result: boolean }
  /** Takes a download off the list; the file stays (DL-08). A failed one's partial file goes. */
  'downloads.remove': { args: { id: string }; result: void }
  /** Moves the file to the Trash (never a permanent delete) and takes it off the list (DL-08). */
  'downloads.delete': { args: { id: string }; result: boolean }
  /**
   * Clears a profile's list (default: the calling window's) of its finished downloads: "Clear all"
   * (DL-08), and clearing browsing data with "Download history". Running, paused, held and resumable
   * ones stay; files stay. Returns how many went.
   */
  'downloads.clear': { args: { profileId?: ProfileId }; result: number }
  /** Pauses a running download (DL-15). */
  'downloads.pause': { args: { id: string }; result: void }
  /**
   * Continues a paused or interrupted download where it stopped, also one cut off by quitting
   * (DL-15). False when it can't continue: retry it.
   */
  'downloads.resume': { args: { id: string }; result: boolean }
  /** Downloads the file again from its address, as a new download (DL-15 Retry, DL-04 missing file). */
  'downloads.retry': { args: { id: string }; result: void }
  /** Keeps a download held back as possibly harmful (DL-12): the file goes into place. */
  'downloads.keep': { args: { id: string }; result: boolean }
  /** Discards a held download (DL-12): its file is deleted and it leaves the list. */
  'downloads.discard': { args: { id: string }; result: void }
  /** Shows the download's (or screenshot's) menu at the pointer (DL-04, DL-08, DL-12, DL-15). */
  'downloads.menu': { args: { id: string }; result: void }
  /**
   * The Library's Media section (DL-11): images and videos downloaded in a profile (default: the
   * calling window's), and the OS screenshots when they are shown there, newest first.
   */
  'downloads.media': { args: { profileId?: ProfileId; limit?: number }; result: LibraryFile[] }
  /**
   * The Library button's popover (DL-05): the newest finished downloads still on disk, and
   * screenshots, as the button's right-click menu chose, newest first.
   */
  'downloads.recent': { args: { limit?: number }; result: LibraryFile[] }
  /** The Library button's right-click menu: what the popover and the Media section show (DL-05, DL-11). */
  'downloads.libraryMenu': { args: Record<string, never>; result: void }
  /**
   * The downloads flyout (DL-14, Windows and Linux): opens it over the window's top left, or closes
   * it when it is open. ⌘⇧J / ⌥⌘L on macOS open the Library's Downloads section instead.
   */
  'downloads.flyout': { args: Record<string, never>; result: void }
}

/** An entry of the downloads list. */
export interface DownloadEntry extends Download {
  /** A finished download whose file was moved or deleted (DL-04 "File missing"). */
  missing?: boolean
  /** The finished file's `file://` URL (thumbnails, previews). */
  fileUrl?: string
}

/** A download just started from a window (DL-02). */
export interface DownloadStarted {
  id: string
  filename: string
}

/** A file the Library button's popover (DL-05) or the Media section (DL-11) shows. */
export interface LibraryFile {
  /** A download's id, or a screenshot's (`shot-…`). */
  id: string
  name: string
  kind: FileKind
  /** The file's `file://` URL. */
  url: string
  /** When it was downloaded or taken (ms). */
  at: number
  size: number
  source: 'download' | 'screenshot'
}

/** The overlay panel of the downloads flyout (DL-14). */
export const DOWNLOADS_FLYOUT_PANEL = 'downloads-flyout'

// ---- File kinds (DL-04, DL-10, DL-11, DL-13) ----

/** What a file is, from its extension: its icon, and what Orbit does with it. */
export type FileKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'text'
  | 'archive'
  | 'installer'
  | 'document'
  | 'code'
  | 'other'

const KINDS: Record<string, FileKind> = {}
const kinds = (kind: FileKind, list: string) => {
  for (const ext of list.split(' ')) KINDS[ext] = kind
}
kinds('image', 'png jpg jpeg gif webp avif bmp ico svg heic heif tif tiff')
kinds('video', 'mp4 m4v webm ogv mov mkv avi')
kinds('audio', 'mp3 m4a ogg oga opus wav flac aac')
kinds('pdf', 'pdf')
kinds('text', 'txt text log md')
kinds('archive', 'zip tar gz tgz bz2 xz 7z rar zst')
kinds('installer', 'exe msi msix appx dmg pkg mpkg deb rpm apk appimage run')
kinds('document', 'doc docx xls xlsx ppt pptx odt ods odp rtf csv pages numbers key epub')
kinds('code', 'json xml yaml yml js ts css html htm py sh')

/**
 * Files Orbit shows in a tab itself instead of handing them to another app (DL-04, DL-13): PDFs
 * (the engine's viewer), images, plain text, audio and video.
 */
const INLINE = new Set(
  'pdf png jpg jpeg gif webp avif bmp ico svg txt text log md json mp4 m4v webm ogv mp3 m4a ogg oga opus wav flac'.split(
    ' ',
  ),
)

/** A file name's extension, lowercased, without the dot ('' when it has none). */
export function extensionOf(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

export function fileKind(name: string): FileKind {
  return KINDS[extensionOf(name)] ?? 'other'
}

/** Whether Orbit opens this file in a tab (by its extension). */
export function showsInline(name: string): boolean {
  return INLINE.has(extensionOf(name))
}

/** An image or a video Orbit can show: a tile of the Media section (DL-11). */
export function isMedia(name: string): boolean {
  const kind = fileKind(name)
  return (kind === 'image' || kind === 'video') && showsInline(name)
}
