import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Global setup for both test runners: on Linux, one temp folder per run, removed when the run
 * ends. Workers, and the apps they launch, inherit `TMPDIR`, so every folder a test makes with
 * `tmpdir()` (an app's user data, a download folder, a saved page) and the apps' own temp files
 * go under it. Before, each e2e test left its user data in /tmp: about 3 MB a test, over 1 GB a
 * full run. A run that is killed leaves its one folder behind.
 *
 * Linux only: macOS's temp path is long, and Chromium's single-instance socket under it could pass
 * the platform's socket path limit. Nothing runs the suite on macOS or Windows now (D42).
 */
export default function runTmp(): () => void {
  if (process.platform !== 'linux') return () => {}
  const dir = mkdtempSync(join(tmpdir(), 'orbit-run-'))
  process.env.TMPDIR = dir
  return () => rmSync(dir, { recursive: true, force: true })
}
