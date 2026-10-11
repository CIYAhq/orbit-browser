import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { BrowserKind } from '../../shared/commands/import'

/** A folder where a browser keeps its profiles. */
export interface Place {
  browser: BrowserKind
  dir: string
}

/** Fixture places for tests: JSON `[{ "browser": "chrome", "dir": "…" }]`. */
export const PLACES_ENV = 'ORBIT_IMPORT_PLACES'

const KINDS = new Set<BrowserKind>([
  'chrome',
  'chromium',
  'brave',
  'edge',
  'vivaldi',
  'opera',
  'opera-gx',
  'firefox',
  'safari',
])

/** Where each browser keeps its profiles on this OS (paths only: nothing is read here). */
export function standardPlaces(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): Place[] {
  if (platform === 'darwin') {
    const lib = join(home, 'Library', 'Application Support')
    return [
      { browser: 'chrome', dir: join(lib, 'Google', 'Chrome') },
      { browser: 'chromium', dir: join(lib, 'Chromium') },
      { browser: 'brave', dir: join(lib, 'BraveSoftware', 'Brave-Browser') },
      { browser: 'edge', dir: join(lib, 'Microsoft Edge') },
      { browser: 'vivaldi', dir: join(lib, 'Vivaldi') },
      { browser: 'opera', dir: join(lib, 'com.operasoftware.Opera') },
      { browser: 'opera-gx', dir: join(lib, 'com.operasoftware.OperaGX') },
      { browser: 'firefox', dir: join(lib, 'Firefox') },
      { browser: 'safari', dir: join(home, 'Library', 'Safari') },
    ]
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    const roaming = env.APPDATA || join(home, 'AppData', 'Roaming')
    return [
      { browser: 'chrome', dir: join(local, 'Google', 'Chrome', 'User Data') },
      { browser: 'chromium', dir: join(local, 'Chromium', 'User Data') },
      { browser: 'brave', dir: join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') },
      { browser: 'edge', dir: join(local, 'Microsoft', 'Edge', 'User Data') },
      { browser: 'vivaldi', dir: join(local, 'Vivaldi', 'User Data') },
      { browser: 'opera', dir: join(roaming, 'Opera Software', 'Opera Stable') },
      { browser: 'opera-gx', dir: join(roaming, 'Opera Software', 'Opera GX Stable') },
      { browser: 'firefox', dir: join(roaming, 'Mozilla', 'Firefox') },
    ]
  }
  const config = env.XDG_CONFIG_HOME || join(home, '.config')
  return [
    { browser: 'chrome', dir: join(config, 'google-chrome') },
    { browser: 'chromium', dir: join(config, 'chromium') },
    { browser: 'brave', dir: join(config, 'BraveSoftware', 'Brave-Browser') },
    { browser: 'edge', dir: join(config, 'microsoft-edge') },
    { browser: 'vivaldi', dir: join(config, 'vivaldi') },
    { browser: 'opera', dir: join(config, 'opera') },
    { browser: 'firefox', dir: join(home, '.mozilla', 'firefox') },
    // Firefox installed as a Snap keeps its profiles in the Snap's home.
    { browser: 'firefox', dir: join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox') },
  ]
}

/** Reads fixture places (relative folders resolve against the working directory). */
export function parsePlaces(json: string): Place[] {
  let list: unknown
  try {
    list = JSON.parse(json)
  } catch {
    throw new Error(`${PLACES_ENV} is not JSON`)
  }
  if (!Array.isArray(list)) throw new Error(`${PLACES_ENV} must be a list`)
  return list.flatMap((p) => {
    const browser = (p as Place)?.browser
    const dir = (p as Place)?.dir
    if (!KINDS.has(browser) || typeof dir !== 'string' || !dir) return []
    return [{ browser, dir: isAbsolute(dir) ? dir : resolve(dir) }]
  })
}

/**
 * The one place Orbit learns where to look for browsers (IM-02). Tests set fixture places. In a
 * test run without them Orbit looks nowhere and reports the mistake as an uncaught error, so the
 * test fails (the quit check, D28) instead of ever reading someone's real profiles.
 */
export function importPlaces(
  e2e: boolean,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  refuse: (message: string) => void = (message) =>
    setImmediate(() => {
      throw new Error(message)
    }),
): Place[] {
  const fixture = env[PLACES_ENV]
  if (fixture !== undefined) return parsePlaces(fixture)
  if (e2e) {
    refuse(`[import] ${PLACES_ENV} is not set in a test run, so no browser was searched`)
    return []
  }
  return standardPlaces(platform, home, env)
}
