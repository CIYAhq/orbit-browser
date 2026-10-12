import { EXTENSION_ID } from './extensions'

/**
 * Adding extensions from the extension store (EX-01). The store's origin and the address Orbit
 * downloads an extension's file from are settings, read once at launch:
 * - a packaged build uses the store's own;
 * - in e2e (`ORBIT_E2E=1`) and development builds, Orbit makes no store request at all, unless a
 *   test names a store on this machine (a fixture server): `ORBIT_STORE_ORIGIN` and
 *   `ORBIT_STORE_DOWNLOAD_URL`, both loopback addresses.
 *
 * Only the store page's main frame gets the install API its button calls (D40 (3),
 * src/preload/store-install.ts), and only an extension ID crosses to main, which checks the
 * calling frame's origin on every call, downloads the file itself, checks its signature and ID,
 * and asks the user in Orbit's own dialog (EX-02).
 */

/** The store's origin: its pages, and so its install button, are here. */
export const STORE_ORIGIN = 'https://chromewebstore.google.com'

/**
 * Where an extension's file comes from: `{id}` is the extension's ID and `{version}` the engine's
 * version. The server answers with a redirect to the CRX file.
 */
export const STORE_DOWNLOAD_URL =
  'https://clients2.google.com/service/update2/crx?response=redirect&prodversion={version}&acceptformat=crx3&x=id%3D{id}%26installsource%3Dondemand%26uc'

export interface StoreConfig {
  /** The store pages' origin (scheme, host and port). */
  origin: string
  /** The download address, with `{id}` and `{version}` in it. */
  downloadUrl: string
}

type Env = Readonly<Record<string, string | undefined>>

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The origin of an http(s) address on this machine, else null. */
export function loopbackOrigin(url: string | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    if ((u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK.has(u.hostname)) return u.origin
  } catch {
    // Not an address.
  }
  return null
}

/** The store a test names: a fixture server on this machine, else null. */
function testStore(env: Env): StoreConfig | null {
  const origin = loopbackOrigin(env.ORBIT_STORE_ORIGIN)
  const downloadUrl = env.ORBIT_STORE_DOWNLOAD_URL
  if (!origin || !downloadUrl || !loopbackOrigin(downloadUrl)) return null
  return { origin, downloadUrl }
}

/** Main's store: the real one in a packaged build, a test's in e2e and dev, else null (no store request). */
export function storeConfig(env: Env, packaged: boolean): StoreConfig | null {
  if (packaged && env.ORBIT_E2E !== '1') return { origin: STORE_ORIGIN, downloadUrl: STORE_DOWNLOAD_URL }
  return testStore(env)
}

/**
 * Whose main frames the page preload gives the install API (it can't tell a packaged build from
 * a development one): a test's store if one is named, none in e2e otherwise, else the real store's.
 * Main checks every call against its own `storeConfig`, so a store page in a development build gets
 * the API but no install.
 */
export function storePageOrigin(env: Env): string | null {
  const test = testStore(env)
  if (test) return test.origin
  return env.ORBIT_E2E === '1' ? null : STORE_ORIGIN
}

/** Whether a frame may call the install API: a main frame showing a page of exactly the store's origin. */
export function isStoreFrame(url: string | undefined, isMainFrame: boolean, origin: string | undefined): boolean {
  if (!isMainFrame || !url || !origin) return false
  try {
    const u = new URL(url)
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === origin
  } catch {
    return false
  }
}

/** The extension a store listing is for (`/detail/<name>/<id>` or `/detail/<id>`, then its subpages), else null. */
export function storeListingId(url: string | undefined, origin: string | undefined): string | null {
  if (!url || !origin || !isStoreFrame(url, true, origin)) return null
  const match = /^\/detail\/(?:[^/]+\/)?([a-p]{32})(?:\/[^/]*)?$/.exec(new URL(url).pathname)
  return match?.[1] ?? null
}

/** The address of an extension's file. */
export function storeDownloadUrl(template: string, id: string, version: string): string {
  if (!EXTENSION_ID.test(id)) throw new Error('Not an extension ID.')
  return template.replaceAll('{id}', encodeURIComponent(id)).replaceAll('{version}', encodeURIComponent(version))
}

/**
 * What the store page's `beginInstallWithManifest3` gives back, as the engine's API names it:
 * '' once the extension is added.
 */
export type StoreResult =
  | ''
  | 'user_cancelled'
  | 'invalid_id'
  | 'already_installed'
  | 'user_gesture_required'
  | 'blocked_by_policy'
  | 'unknown_error'
