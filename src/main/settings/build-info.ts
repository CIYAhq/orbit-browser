import type { BuildInfo } from '../../shared/commands/settings'
import { ISSUES_URL } from '../../shared/project'

// Set by electron.vite.config.ts; unit tests have neither.
declare const __ORBIT_VERSION__: string | undefined
declare const __ORBIT_BUILD_DATE__: string | undefined

/**
 * Orbit's version from package.json, fixed at build time (UP-03, UP-07). A packaged build's
 * app.getVersion() says the same, but a dev or test run's depends on how Electron was started.
 */
export const BUILT_VERSION = typeof __ORBIT_VERSION__ === 'string' ? __ORBIT_VERSION__ : undefined
/** The day of the build, "2026-10-10" (UP-07). */
export const BUILD_DATE = typeof __ORBIT_BUILD_DATE__ === 'string' ? __ORBIT_BUILD_DATE__ : undefined

/** The text "Copy build info" puts on the clipboard (ST-17, UP-07). */
export function buildInfoText(info: BuildInfo): string {
  return [
    `Orbit ${info.version}${info.built ? ` (built ${info.built})` : ''}`,
    `Chromium ${info.chrome} (Electron ${info.electron}, Node ${info.node}, V8 ${info.v8})`,
    `${info.os} (${info.arch})`,
  ].join('\n')
}

/**
 * A new issue on the project's public tracker with the build info filled in (OB-13). Orbit has no
 * support server: the report is written and sent by the person, on the tracker's own page.
 */
export function bugReportUrl(info: BuildInfo): string {
  const body = [
    '**What happened**',
    '',
    '',
    '**What you expected**',
    '',
    '',
    '**Steps to make it happen again**',
    '1. ',
    '',
    '**Build**',
    '```',
    buildInfoText(info),
    '```',
  ].join('\n')
  return `${ISSUES_URL}/new?body=${encodeURIComponent(body)}`
}
