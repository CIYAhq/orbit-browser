import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import {
  app,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  net,
  protocol,
  type Session,
  type WebContents,
  type WebFrameMain,
  webContents,
} from 'electron'
import { INTERNAL_SCHEME } from '../../shared/commands/devtools'
import type { CommandName, EventName, OrbitEvents } from '../../shared/rpc'
import type { MainContext } from '../context'
import { rendererEntry } from '../windows'
import { AwaitedPages, internalFile, isInternalUrl } from './internal-urls'

/**
 * Orbit's internal pages (DT-13): `orbit://<page>/` addresses that open as normal tabs and show
 * Orbit's own UI there, the way a browser's built-in pages do. Typing one in the command bar opens
 * it; `orbit://pages/` lists them all.
 *
 * How they work:
 * - The scheme is standard and secure (`registerInternalScheme`, called once from main's index.ts
 *   before the app is ready: Electron takes a single call, so another privileged scheme joins that
 *   list). Each page is its own origin, `orbit://<page>`.
 * - Every profile session serves `orbit://<page>/…` from the built renderer: the document is the
 *   renderer's index.html, its scripts and styles come from the same origin (`internalFile`). In
 *   development the renderer's dev server answers instead.
 * - A preload on every profile session (`src/preload/internal.ts`) gives an `orbit:` page's main
 *   frame the same `window.orbit` bridge Orbit's UI has, on channels of its own. Main answers only
 *   a tab's main frame showing an `orbit:` page, and sends state changes and broadcasts only there.
 *   A web page gets no bridge.
 * - Web content can't reach them: a page can't navigate a frame to an `orbit:` address, redirect
 *   to one or open one in a new tab, and the pages refuse to be framed. It can't load or fetch them
 *   either: the handler serves a page only to a navigation that Orbit or an internal page started
 *   (`AwaitedPages`), and scripts and styles only to internal pages; anything else gets the network
 *   error a scheme that doesn't exist gives. Pages never act on what their address says (an
 *   address the user pastes may come from anyone): they show things, and act on clicks.
 *
 * Adding a page: a module named `<name>.internal-page.tsx` anywhere under `src/renderer/src`
 * (beside the feature's other UI) that exports `page: InternalPage` (see
 * `src/renderer/src/internal/registry.ts`). It is then `orbit://<name>/`, listed on
 * `orbit://pages/`, and renders like any Orbit UI: the store (`useOrbit`), commands (`invoke`), and
 * `useWindow()`, the window its tab was in when it loaded. Its data comes through the bridge, not
 * `fetch()`; its images are inlined by the build or drawn as icons (a plain `<img>` request carries
 * no origin, so it isn't served).
 */

/** Registers the scheme's privileges. Call once, before the app is ready. */
export function registerInternalScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: INTERNAL_SCHEME,
      // No supportFetchAPI or corsEnabled: no page fetches an internal page (they talk to main).
      privileges: { standard: true, secure: true, codeCache: true },
    },
  ])
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
}

/** The page itself, not one of its scripts or styles. */
const DOCUMENT_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  // No web page may frame an internal page.
  'content-security-policy': "frame-ancestors 'none'",
  // Each showing asks again (see AwaitedPages).
  'cache-control': 'no-store',
}

/**
 * Answers `orbit:` requests with the renderer's files: the page, for a navigation that awaits it,
 * and its scripts and styles, for internal pages only (their requests carry an `orbit:` origin; a
 * web page can't send one). Anything else gets a network error, as for a scheme that doesn't exist:
 * a web page can neither read internal pages nor tell that they are there.
 */
function server(awaited: AwaitedPages): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return Response.error()
    const origin = request.headers.get('origin')
    const document = !origin
    if (document ? !awaited.take(request.url) : !isInternalUrl(origin)) return Response.error()
    const url = new URL(request.url)
    const entry = rendererEntry()
    if (entry.url) {
      // Development: the dev server has the page and its modules, at paths of its choosing.
      const response = await net.fetch(new URL(document ? '/' : `${url.pathname}${url.search}`, entry.url).href)
      return document ? new Response(response.body, { status: response.status, headers: DOCUMENT_HEADERS }) : response
    }
    const rendererDir = join(entry.file, '..')
    const file = document ? entry.file : internalFile(rendererDir, url.pathname)
    let body: Buffer
    try {
      body = await readFile(file)
    } catch {
      return Response.error()
    }
    const headers =
      file === entry.file ? DOCUMENT_HEADERS : { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }
    return new Response(new Uint8Array(body), { headers })
  }
}

function preloadPath(): string {
  return join(import.meta.dirname, '../preload/internal.cjs')
}

/** A tab's main frame showing an internal page: the only frames main answers or sends to. */
function internalFrame(frame: WebFrameMain | null | undefined): frame is WebFrameMain {
  return !!frame && !frame.parent && isInternalUrl(frame.url)
}

/** Serves internal pages in every profile session, bridges them to main, and keeps web content out. */
export function registerInternalPages(ctx: MainContext): void {
  const { commands, events, hooks, sessions, store, tabs, windows } = ctx

  const awaited = new AwaitedPages()
  const serve = server(awaited)
  sessions.onSessionCreated((ses: Session) => {
    ses.protocol.handle(INTERNAL_SCHEME, serve)
    ses.registerPreloadScript({ type: 'frame', id: 'orbit-internal-pages', filePath: preloadPath() })
  })

  // ---- The bridge ----
  /** Pages that asked for the state: they get its changes and the broadcasts, as Orbit's UI does. */
  const live = new Set<WebContents>()
  const allowed = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    internalFrame(event.senderFrame) && !!tabs.tabIdFor(event.sender)
  const forward = (channel: string, args: unknown[]) => {
    for (const contents of live) {
      const frame = contents.isDestroyed() ? undefined : contents.mainFrame
      if (!internalFrame(frame)) {
        live.delete(contents)
        continue
      }
      try {
        frame.send(channel, ...args)
      } catch {
        live.delete(contents)
      }
    }
  }

  ipcMain.on('orbit:internal:hello', (event) => {
    event.returnValue = allowed(event) ? { windowId: windows.windowIdFor(event.sender) ?? '' } : null
  })
  ipcMain.handle('orbit:internal:getState', (event) => {
    if (!allowed(event)) throw new Error('Forbidden')
    if (!live.has(event.sender)) {
      live.add(event.sender)
      event.sender.once('destroyed', () => live.delete(event.sender))
    }
    return store.snapshot()
  })
  ipcMain.handle('orbit:internal:invoke', (event, name: CommandName, args: unknown) => {
    if (!allowed(event)) throw new Error('Forbidden')
    return commands.run(name, args as never, { windowId: windows.windowIdFor(event.sender), sender: event.sender })
  })
  ipcMain.on('orbit:internal:send', (event, name: EventName, payload: OrbitEvents[EventName]) => {
    if (!allowed(event)) return
    events.emit(name, payload, { windowId: windows.windowIdFor(event.sender) })
  })
  windows.onBroadcast((channel, args) => {
    if (live.size > 0) forward(channel, args)
  })

  // ---- Keeping web content out ----
  const guard = (contents: WebContents) => {
    // Typed addresses, reloads, history and restored tabs have no initiator; links do.
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument || !isInternalUrl(details.url)) return
      if (!details.initiator || isInternalUrl(details.initiator.url)) awaited.add(details.url)
    })
    contents.on('will-frame-navigate', (details) => {
      if (!isInternalUrl(details.url)) return
      // Only an internal page may lead to another (its links); typed addresses don't come here.
      if (details.isMainFrame && isInternalUrl(details.initiator?.url ?? contents.getURL())) return
      details.preventDefault()
    })
    contents.on('will-redirect', (details) => {
      if (isInternalUrl(details.url)) details.preventDefault()
    })
  }
  for (const contents of webContents.getAllWebContents()) guard(contents)
  app.on('web-contents-created', (_event, contents) => guard(contents))
  hooks.windowOpen.unshift((openerTabId, details) => {
    if (!isInternalUrl(details.url)) return undefined
    return isInternalUrl(tabs.contents(openerTabId)?.getURL()) ? undefined : { action: 'deny' }
  })
}
