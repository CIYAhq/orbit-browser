import type { Download, ProfileId } from '../state'

/**
 * Owned by the downloads lane: the downloads flow (DL-01), the sidebar's downloads row (DL-02,
 * DL-03), what can be done with a download (DL-04, DL-08, DL-15) and the downloads list.
 *
 * Two places hold downloads:
 * - `OrbitState.downloads`: the ones the sidebar shows now (running, paused, failed, and finished ones
 *   for a few seconds). Small; patched as bytes arrive.
 * - The downloads list: every download of every profile, newest first, in its own file
 *   (`userData/downloads.json`), read with `downloads.list`. Private-window downloads are never in it.
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
  /** Shows the file in Finder / the file manager (DL-04). False when its file is gone. */
  'downloads.showInFolder': { args: { id: string }; result: boolean }
  /** Puts the file on the clipboard, to paste in a folder or another app (DL-04). False when it is gone. */
  'downloads.copyFile': { args: { id: string }; result: boolean }
  /** Copies the address the file was downloaded from (DL-04). */
  'downloads.copyLink': { args: { id: string }; result: void }
  /** Takes a download off the list; the file stays (DL-08). A failed one's partial file goes. */
  'downloads.remove': { args: { id: string }; result: void }
  /** Moves the file to the Trash (never a permanent delete) and takes it off the list (DL-08). */
  'downloads.delete': { args: { id: string }; result: boolean }
  /**
   * Clears a profile's list (default: the calling window's) of everything not running: "Clear all"
   * (DL-08), and clearing browsing data with "Download history". Files stay. Returns how many went.
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
  /** Shows the download's menu at the pointer (DL-04, DL-08, DL-15). */
  'downloads.menu': { args: { id: string }; result: void }
}

/** An entry of the downloads list. */
export interface DownloadEntry extends Download {
  /** A finished download whose file was moved or deleted (DL-04 "File missing"). */
  missing?: boolean
}

/** A download just started from a window (DL-02). */
export interface DownloadStarted {
  id: string
  filename: string
}
