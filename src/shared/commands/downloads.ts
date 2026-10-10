import type { Download, ProfileId } from '../state'

/**
 * Owned by the downloads lane: the downloads flow (DL-01) and the downloads list.
 *
 * Two places hold downloads:
 * - `OrbitState.downloads`: the ones the sidebar shows now (running, paused, failed, and finished ones
 *   for a few seconds). Small; patched as bytes arrive.
 * - The downloads list: every download of every profile, newest first, in its own file
 *   (`userData/downloads.json`), read with `downloads.list`. Private-window downloads are never in it.
 *
 * Main → renderer: `downloads.changed` ({ profileId }) is broadcast when a profile's list changes.
 */
export interface DownloadCommands {
  /** The downloads list of a profile (default: the calling window's), newest first. */
  'downloads.list': { args: { profileId?: ProfileId; limit?: number }; result: Download[] }
  /** Cancels a download and deletes its partial file (DL-03 ✕). */
  'downloads.cancel': { args: { id: string }; result: void }
  /** Takes a download off the sidebar's indicator; it stays in the list. */
  'downloads.dismiss': { args: { id: string }; result: void }
  /** Downloads running or paused now (quitting asks first when there are any, DL-01). */
  'downloads.active': { args: Record<string, never>; result: number }
}
