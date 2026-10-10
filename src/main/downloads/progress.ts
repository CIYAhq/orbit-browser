import type { Download } from '../../shared/state'

/** What the Dock icon / taskbar button shows for the downloads running now (DL-17). */
export interface DockProgress {
  /** 0–1; above 1 means "can't tell" (Electron's indeterminate bar). */
  value: number
  /** Windows' bar colour: normal, indeterminate, or paused (yellow) when every download is paused. */
  mode: 'normal' | 'indeterminate' | 'paused'
}

/**
 * Overall progress of the downloads running or paused (DL-17): bytes received of the bytes expected,
 * over those whose size is known; undefined when none runs (the bar goes).
 */
export function dockProgress(downloads: Iterable<Download>): DockProgress | undefined {
  let running = 0
  let paused = 0
  let received = 0
  let total = 0
  for (const d of downloads) {
    if (d.state !== 'progressing' && d.state !== 'paused') continue
    running++
    if (d.state === 'paused') paused++
    if (d.totalBytes > 0) {
      total += d.totalBytes
      received += Math.min(d.receivedBytes, d.totalBytes)
    }
  }
  if (running === 0) return undefined
  if (total === 0) return { value: 2, mode: 'indeterminate' }
  return { value: Math.min(1, received / total), mode: paused === running ? 'paused' : 'normal' }
}

/** Whether two readings look the same on screen (the bar moves in whole percents). */
export function sameProgress(a: DockProgress | undefined, b: DockProgress | undefined): boolean {
  if (!a || !b) return a === b
  return a.mode === b.mode && Math.round(a.value * 100) === Math.round(b.value * 100)
}
