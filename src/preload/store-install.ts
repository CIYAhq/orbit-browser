import { contextBridge, ipcRenderer } from 'electron'
import { type StoreResult, storePageOrigin } from '../shared/extension-store'
import { EXTENSION_ID } from '../shared/extensions'
import { PAGE_CHANNEL } from '../shared/site'

/**
 * The extension store's install button (EX-01; D40 (3)). On main frames of exactly the store's
 * origin, and nowhere else, the page's `chrome.webstorePrivate` gets the two calls its button makes,
 * and nothing more:
 * - `beginInstallWithManifest3(details)`: only `details.id` goes to main, and only after a click on
 *   the page (a user activation, as the engine asks). Main checks the calling frame's origin again,
 *   downloads the extension's file itself, checks its signature and ID, asks the user in Orbit's own
 *   dialog (EX-02) and adds it to the tab's profile. The page gets '' once it's added, else why not
 *   (`StoreResult`). The rest of `details`, the store's copy of the manifest included, is never read.
 * - `completeInstall(id)`: succeeds for an extension the call above added for this document, which
 *   has nothing left to do; main isn't asked.
 * Both take a callback or give a promise, as the engine's do. Main's side: src/main/extensions/store.ts.
 */
export function exposeStoreInstall(): void {
  if (window.top !== window) return
  const origin = storePageOrigin(process.env)
  if (!origin || location.origin !== origin) return
  /** What this document's begin calls added. */
  const added = new Set<string>()
  const begin = (id: unknown): Promise<StoreResult> => {
    if (typeof id !== 'string' || !EXTENSION_ID.test(id)) return Promise.resolve('invalid_id')
    // A click on the store's button: a page's script can't make one up.
    if (!navigator.userActivation?.isActive) return Promise.resolve('user_gesture_required')
    return ipcRenderer.invoke(PAGE_CHANNEL.storeInstall, id).then(
      (value: unknown) => {
        const result = typeof value === 'string' ? (value as StoreResult) : 'unknown_error'
        if (result === '') added.add(id)
        return result
      },
      () => 'unknown_error' as const,
    )
  }
  const complete = (id: unknown): boolean => typeof id === 'string' && added.has(id)
  try {
    contextBridge.executeInMainWorld({ func: defineStoreApi, args: [begin, complete] })
  } catch {
    // A page without a world of its own gets nothing.
  }
}

/**
 * Runs in the store page's own world before its scripts (serialized: it may use only its arguments
 * and the page's globals), with the built-ins it calls taken up front (D40 (1)).
 */
function defineStoreApi(begin: (id: unknown) => Promise<string>, complete: (id: unknown) => boolean) {
  const apply = Reflect.apply
  const define = Object.defineProperty
  const freeze = Object.freeze
  const then = Promise.prototype.then
  const resolve = Promise.resolve
  const reject = Promise.reject
  const PromiseCtor = Promise
  const ErrorCtor = Error
  const root = globalThis as unknown as { chrome?: unknown }
  let chrome = root.chrome
  if (!chrome || typeof chrome !== 'object') {
    chrome = {}
    define(root, 'chrome', { value: chrome, writable: true, configurable: true, enumerable: true })
  }
  const idOf = (details: unknown): unknown => {
    try {
      return details && typeof details === 'object' ? (details as { id?: unknown }).id : undefined
    } catch {
      return undefined
    }
  }
  const api = {
    beginInstallWithManifest3(details: unknown, callback?: unknown) {
      const result = begin(idOf(details))
      if (typeof callback !== 'function') return result
      apply(then, result, [(value: string) => apply(callback, undefined, [value])])
      return undefined
    },
    completeInstall(id: unknown, callback?: unknown) {
      const done = (
        complete(id)
          ? apply(resolve, PromiseCtor, [undefined])
          : apply(reject, PromiseCtor, [new ErrorCtor('This extension wasn’t added here.')])
      ) as Promise<void>
      if (typeof callback !== 'function') return done
      const call = () => apply(callback, undefined, [])
      apply(then, done, [call, call])
      return undefined
    },
  }
  define(chrome, 'webstorePrivate', { value: freeze(api), enumerable: true, configurable: true, writable: false })
}
