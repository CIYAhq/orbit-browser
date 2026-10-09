/**
 * Helpers for the tabs e2e specs (tabs lane). Builds on helpers.ts.
 */
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import type { OrbitState, Tab } from '../../src/shared/state'
import { state } from './helpers'

export const PROFILE = 'p-default'

type Hooks = {
  __orbit: {
    run: (n: string, a: unknown, w?: string) => Promise<unknown>
    windowIds: () => string[]
    liveTabs: () => string[]
    ctx: { store: { update: (fn: (d: OrbitState) => void) => void } }
  }
  __orbitTabs: {
    maintenance: (now?: number) => { archived: string[]; slept: string[] }
    lastMenu: () => string[]
    clickMenu: (path: string) => boolean
    undo: () => string | undefined
  }
}

/** Runs a command as if from window `w` (default: the first window). */
export function cmd<T = unknown>(app: ElectronApplication, name: string, args: unknown = {}, w = 0): Promise<T> {
  return app.evaluate(
    async (_e, [n, a, wi]) => {
      const g = globalThis as unknown as Hooks
      return g.__orbit.run(n, a, g.__orbit.windowIds()[wi])
    },
    [name, args, w] as const,
  ) as Promise<T>
}

/** Runs a user action (shortcut/menu verb) in window `w`. */
export function act(app: ElectronApplication, id: string, w = 0): Promise<void> {
  return app.evaluate(
    async (_e, [actionId, wi]) => {
      const g = globalThis as unknown as Hooks & {
        __orbit: { action: (id: string, w?: string) => Promise<void> }
      }
      await g.__orbit.action(actionId, g.__orbit.windowIds()[wi])
    },
    [id, w] as const,
  )
}

/** Mutates main-process state directly (test setup only). */
export function setState(app: ElectronApplication, fn: string, arg: unknown = null): Promise<void> {
  return app.evaluate(
    (_e, [body, a]) => {
      const g = globalThis as unknown as Hooks
      const f = new Function('d', 'arg', body) as (d: OrbitState, arg: unknown) => void
      g.__orbit.ctx.store.update((d) => f(d, a))
    },
    [fn, arg] as const,
  )
}

export function tabsHook<T>(app: ElectronApplication, name: keyof Hooks['__orbitTabs'], arg?: unknown): Promise<T> {
  return app.evaluate(
    (_e, [n, a]) => {
      const g = globalThis as unknown as Hooks
      return (g.__orbitTabs[n] as (x?: unknown) => unknown)(a)
    },
    [name, arg] as const,
  ) as Promise<T>
}

export function liveTabs(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as Hooks).__orbit.liveTabs())
}

export async function newTab(
  app: ElectronApplication,
  url: string,
  opts: { activate?: boolean; container?: unknown; spaceId?: string } = {},
): Promise<string> {
  return cmd<string>(app, 'tabs.create', { url, activate: opts.activate ?? true, ...opts })
}

export async function space(app: ElectronApplication, index = 0) {
  const s = await state(app)
  const id = s.spaceOrder[index] as string
  return s.spaces[id] as OrbitState['spaces'][string]
}

export async function activeId(app: ElectronApplication, w = 0): Promise<string | null> {
  const s = await state(app)
  const ids = await app.evaluate(() => (globalThis as unknown as Hooks).__orbit.windowIds())
  const win = s.windows[ids[w] as string]
  return win ? (win.activeTab[win.spaceId] ?? null) : null
}

export async function tab(app: ElectronApplication, id: string): Promise<Tab | undefined> {
  return (await state(app)).tabs[id]
}

/** Waits until a tab shows a URL containing `part` and finished loading. */
export async function waitTab(app: ElectronApplication, id: string, part: string): Promise<void> {
  await expect
    .poll(async () => {
      const t = await tab(app, id)
      return !!t && t.url.includes(part) && !t.loading
    })
    .toBe(true)
}

export function row(shell: Page, tabId: string): Locator {
  return shell.locator(`[data-testid="tab-row"][data-tab-id="${tabId}"]`)
}

export async function center(
  loc: Locator,
): Promise<{ x: number; y: number; box: { x: number; y: number; width: number; height: number } }> {
  const box = await loc.boundingBox()
  if (!box) throw new Error('not visible')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box }
}

/** Presses on `from`, drags past the threshold to (x, y) and releases (unless `hold`). */
export async function drag(page: Page, from: Locator, to: { x: number; y: number }, opts: { hold?: boolean } = {}) {
  const start = await center(from)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x, start.y + 6, { steps: 2 })
  await page.mouse.move(to.x, to.y, { steps: 14 })
  await page.waitForTimeout(80)
  if (!opts.hold) {
    await page.mouse.up()
    await expect(page.getByTestId('drag-ghost')).toHaveCount(0)
  }
}

/** Visible row ids of a list, in order. */
export async function rowIds(shell: Page, testId: 'today-list' | 'pinned-list'): Promise<string[]> {
  return shell
    .getByTestId(testId)
    .locator(':scope > [data-slot="item"]')
    .evaluateAll((els) =>
      els.filter((e) => !(e as HTMLElement).dataset.exiting).map((e) => (e as HTMLElement).dataset.key ?? ''),
    )
}
