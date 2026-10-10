import { type ElectronApplication, expect, type Page } from '@playwright/test'
import type { MainContext } from '../../src/main/context'
import { run } from './helpers'

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
