import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page } from '@playwright/test'
import type { MainContext } from '../../src/main/context'
import { checkQuit, evaluateBetweenTasks, run } from './helpers'

/** The main process's test handle (src/main/test-hooks.ts), for app.evaluate() bodies. */
export type OrbitGlobal = { __orbit: { ctx: MainContext; windowIds: () => string[] } }

/** Finds the page of an Orbit window by its ?view= query (settings, onboarding…). */
export async function pageOfView(app: ElectronApplication, view: string, timeout = 20_000): Promise<Page> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const found = app.windows().find((p) => p.url().includes(`view=${view}`) && !p.isClosed())
    if (found) return found
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`No ${view} page`)
}

/** Opens Settings (as ⌘, would from the first browser window) and returns its page, drawn. */
export async function openSettings(
  app: ElectronApplication,
  target: { section?: string; item?: string; profileId?: string } = {},
): Promise<Page> {
  await run(app, 'settings.open', target)
  const page = await pageOfView(app, 'settings')
  await expect(page.getByTestId('settings')).toBeVisible()
  // Playwright pins pages to a light colour scheme unless told not to: follow Orbit's mode.
  await page.emulateMedia({ colorScheme: null })
  return page
}

export interface OsWindow {
  focused: boolean
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number }
  throttled: boolean
  background: string
}

/** The OS windows showing an Orbit view (`settings`, `shell`…). */
export function osWindows(app: ElectronApplication, view: string): Promise<OsWindow[]> {
  return app.evaluate(({ BrowserWindow }, v) => {
    return BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed() && w.webContents.getURL().includes(`view=${v}`))
      .map((w) => ({
        focused: w.isFocused(),
        visible: w.isVisible(),
        bounds: w.getBounds(),
        throttled: w.webContents.getBackgroundThrottling(),
        background: w.getBackgroundColor().toLowerCase(),
      }))
  }, view)
}

/** Focuses the first browser window (as clicking it would). */
export async function focusBrowserWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const hooks = (globalThis as unknown as OrbitGlobal).__orbit
    hooks.ctx.windows.get(hooks.windowIds()[0] as string)?.focus()
  })
}

/** Whether the first browser window has focus. */
export function browserFocused(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(() => {
    const hooks = (globalThis as unknown as OrbitGlobal).__orbit
    return hooks.ctx.windows.get(hooks.windowIds()[0] as string)?.isFocused() ?? false
  })
}

/** The main store's patch sequence: a renderer whose mirror reached it has every change. */
export function mainSeq(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => (globalThis as unknown as OrbitGlobal).__orbit.ctx.store.snapshot().seq)
}

/** A renderer's mirror sequence (store.ts diagnostics). */
export function viewSeq(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as unknown as { __orbitMirror: { seq: () => number } }).__orbitMirror.seq())
}

/** A launch that doesn't wait for a browser window: on a first run, onboarding shows first (OB-01). */
export interface FirstRun {
  app: ElectronApplication
  userData: string
  /** Chromium's network log of the whole run, readable once the app has closed (`remoteRequests`). */
  netLog: string
  takeUncaught: () => string
}

/**
 * Starts Orbit as launchOrbit does (offline, behind the same dead proxy; isolated profile), and also
 * records every network request Chromium makes from the first moment, for OB-02.
 */
export async function launchFirstRun(
  opts: { userData?: string; env?: Record<string, string> } = {},
): Promise<FirstRun> {
  const userData = opts.userData ?? mkdtempSync(join(tmpdir(), 'orbit-e2e-'))
  const netLog = join(mkdtempSync(join(tmpdir(), 'orbit-netlog-')), 'netlog.json')
  const args = ['--proxy-server=http://127.0.0.1:9', `--log-net-log=${netLog}`, resolve('out/main/index.js')]
  if (process.platform === 'linux') args.unshift('--no-sandbox')
  const app = await electron.launch({
    args,
    env: { ...process.env, ORBIT_E2E: '1', ORBIT_USER_DATA: userData, ...opts.env } as Record<string, string>,
  })
  evaluateBetweenTasks(app)
  const takeUncaught = checkQuit(app)
  return { app, userData, netLog, takeUncaught }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Requests to anywhere but this computer in a network log (`--log-net-log`), as URLs. */
export function remoteRequests(netLog: string): string[] {
  if (!existsSync(netLog)) throw new Error(`No network log at ${netLog}`)
  const found = new Set<string>()
  for (const [, url] of readFileSync(netLog, 'utf8').matchAll(/"url":"((?:https?|wss?):\/\/[^"]+)"/g)) {
    let host = ''
    try {
      host = new URL(url as string).hostname
    } catch {
      host = String(url)
    }
    if (!LOOPBACK.has(host)) found.add(url as string)
  }
  return [...found]
}

/** Words that would ask for an account (OB-02). */
export const ACCOUNT_WORDS =
  /\b(sign[ -]?(in|up|on)|log[ -]?(in|on)|create (an |your )?account|your account|my account|account)\b/i

/**
 * What on a page asks for an account: controls, headings and labels that say so, and e-mail or
 * password boxes.
 */
export function accountPrompts(page: Page): Promise<string[]> {
  return page.evaluate((source) => {
    const words = new RegExp(source, 'i')
    const found: string[] = []
    const named = document.querySelectorAll(
      'button, a, [role="button"], [role="link"], [role="menuitem"], [role="tab"], h1, h2, h3, label, input, textarea',
    )
    for (const el of named) {
      const name = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('placeholder') ?? ''} ${(el as HTMLElement).innerText ?? ''}`
      if (words.test(name)) found.push(name.trim())
    }
    for (const input of document.querySelectorAll('input')) {
      const kind = `${input.type} ${input.autocomplete}`
      if (/email|password|username/i.test(kind)) found.push(`<input ${kind}>`)
    }
    return found
  }, ACCOUNT_WORDS.source)
}
