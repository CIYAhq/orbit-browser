/**
 * Helpers for the pages lane's e2e specs (pages*.spec.ts): fixture pages that ask things of the
 * user, and handles on Orbit's page dialogs (NV-24). Builds on helpers.ts.
 */
import { createServer, type Server } from 'node:http'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import type { PageDialogInfo } from '../../src/main/pages/dialogs'
import type { LeaveInfo } from '../../src/main/pages/leave'
import { listenInRange } from './helpers'

export interface PagesFixtures {
  port: number
  url: (path: string) => string
  /** Requests the server saw, newest last (method and path). */
  seen: () => string[]
  close: () => Promise<void>
}

/** The sign-in fixture's account. */
export const AUTH_USER = 'orbit'
export const AUTH_PASSWORD = 'secret word'

const html = (title: string, body: string, head = '') => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>${head}
<style>body{font:16px system-ui;margin:0;padding:24px;background:#f6f3ee}button,a{font:inherit}
#area{height:600px;background:#e8e2d8}</style></head><body>${body}</body></html>`

/**
 * - `/ask?kind=alert|confirm|prompt&msg=…&value=…&on=click|load`: asks once (on a click of `#ask`, or
 *   as soon as it loads) and writes what the call returned to `#result` (JSON) and the title.
 * - `/warn`: warns before it goes (`beforeunload`), with a link (`#away`), a form (`#form`) and an
 *   area to click for a user gesture (`#area`).
 * - `/auth`: HTTP Basic sign-in (AUTH_USER, AUTH_PASSWORD).
 * - `/page/<name>`: a plain page.
 * - `/opener?to=…`: opens `to` in a pop-up window on a click of `#open`.
 */
export async function startPagesFixtures(base = 3340): Promise<PagesFixtures> {
  const seen: string[] = []
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost')
    seen.push(`${req.method} ${u.pathname}${u.search}`)
    const send = (body: string, status = 200, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers })
      res.end(body)
    }
    if (u.pathname === '/ask') {
      const kind = u.searchParams.get('kind') ?? 'confirm'
      const msg = u.searchParams.get('msg') ?? 'Are you sure?'
      const value = u.searchParams.get('value') ?? ''
      const on = u.searchParams.get('on') ?? 'click'
      const call =
        kind === 'alert'
          ? `alert(${JSON.stringify(msg)})`
          : kind === 'prompt'
            ? `prompt(${JSON.stringify(msg)}, ${JSON.stringify(value)})`
            : `confirm(${JSON.stringify(msg)})`
      send(
        html(
          'Ask',
          `<button id="ask">Ask</button><output id="result">none</output><div id="area"></div>
<script>
function ask() {
  const r = ${call}
  const text = r === undefined ? 'undefined' : JSON.stringify(r)
  document.getElementById('result').textContent = text
  document.title = 'Answered ' + text
}
document.getElementById('ask').addEventListener('click', ask)
${on === 'load' ? "addEventListener('load', () => setTimeout(ask, 0))" : ''}
</script>`,
        ),
      )
      return
    }
    if (u.pathname === '/warn') {
      send(
        html(
          'Warns',
          `<p><a id="away" href="/page/Away">Away</a></p>
<form id="form" method="post" action="/posted"><input name="note" value="draft"><button id="send">Send</button></form>
<div id="area"></div>
<script>addEventListener('beforeunload', (e) => { e.preventDefault() })</script>`,
        ),
      )
      return
    }
    if (u.pathname === '/posted') {
      send(html('Posted', '<h1>Posted</h1>'))
      return
    }
    if (u.pathname === '/auth') {
      const expected = `Basic ${Buffer.from(`${AUTH_USER}:${AUTH_PASSWORD}`).toString('base64')}`
      if (req.headers.authorization === expected) send(html('Signed in', `<h1 id="who">Signed in as ${AUTH_USER}</h1>`))
      else send(html('No entry', '<h1 id="who">No entry</h1>'), 401, { 'www-authenticate': 'Basic realm="Orbit test"' })
      return
    }
    if (u.pathname === '/opener') {
      const to = u.searchParams.get('to') ?? '/page/Popup'
      send(
        html(
          'Opener',
          `<button id="open">Open</button><div id="area"></div>
<script>document.getElementById('open').addEventListener('click', () => {
  window.open(${JSON.stringify(to)}, 'popup', 'popup,width=520,height=420')
})</script>`,
        ),
      )
      return
    }
    if (u.pathname.startsWith('/page/')) {
      const name = decodeURIComponent(u.pathname.slice('/page/'.length))
      send(html(name, `<h1 id="title">${name}</h1><div id="area"></div>`))
      return
    }
    send('not found', 404)
  })
  const port = await listenInRange(server, base)
  return {
    port,
    url: (path) => `http://localhost:${port}${path}`,
    seen: () => [...seen],
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

type PagesGlobal = {
  __orbitPages: {
    dialogs: () => PageDialogInfo[]
    leave: (tabId: string) => LeaveInfo | null
    mayDiscard: (tabId: string) => boolean
  }
}

/** Every page's dialog on show or waiting (the first of each page's). */
export function pageDialogs(app: ElectronApplication): Promise<PageDialogInfo[]> {
  return app.evaluate(() => (globalThis as unknown as PagesGlobal).__orbitPages.dialogs())
}

/** Waits for a dialog that matches, and returns it. */
export async function waitDialog(
  app: ElectronApplication,
  match: (d: PageDialogInfo) => boolean,
  timeout = 15_000,
): Promise<PageDialogInfo> {
  let found: PageDialogInfo | undefined
  await expect
    .poll(
      async () => {
        found = (await pageDialogs(app)).find(match)
        return !!found
      },
      { timeout },
    )
    .toBe(true)
  return found as PageDialogInfo
}

export function leaveInfo(app: ElectronApplication, tabId: string): Promise<LeaveInfo | null> {
  return app.evaluate((_e, id) => (globalThis as unknown as PagesGlobal).__orbitPages.leave(id), tabId)
}

export function mayDiscard(app: ElectronApplication, tabId: string): Promise<boolean> {
  return app.evaluate((_e, id) => (globalThis as unknown as PagesGlobal).__orbitPages.mayDiscard(id), tabId)
}

/** The dialog view (a Playwright page) showing the dialog with this id. */
export async function dialogPage(app: ElectronApplication, id: number): Promise<Page> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      if (!page.url().includes('view=dialog')) continue
      const shows = await page
        .locator(`[data-dialog-id="${id}"]`)
        .count()
        .catch(() => 0)
      if (shows > 0) return page
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`no dialog view shows dialog ${id}`)
}

/** What a `/ask` page's call returned (JSON text), once the page is free to answer. */
export async function askResult(page: Page): Promise<string> {
  return (await page.locator('#result').textContent()) ?? ''
}
