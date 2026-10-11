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
    clockAhead: (ms: number) => void
    launchPassDone: () => boolean
    rowMenu: (windowId?: string) => RowMenuInfo | null
    chooseRowMenu: (path: string, windowId?: string) => boolean
    toastView: (windowId?: string) => ToastViewInfo
    undo: () => string | undefined
    resources: (memory?: { total: number; available: number } | null) => ResourceInfo
  }
}

/** A pass of the background limits (TB-16, `src/main/tabs/resources.ts`). */
export interface ResourceInfo {
  frozen: string[]
  /** Each awake tab's process, in % of one core over the last pass. */
  usage: Record<string, number>
  lowMemory: boolean
  saver: boolean
}

type Rect = { x: number; y: number; width: number; height: number }

/** The toast view over the page card while the sidebar is hidden (SB-13). */
export interface ToastViewInfo {
  /** In the window, showing toasts. */
  visible: boolean
  bounds?: Rect
  /** The page card it is centred on. */
  card?: Rect
}

/** The toast view of window `w`. */
export function toastView(app: ElectronApplication, w = 0): Promise<ToastViewInfo> {
  return app.evaluate((_e, wi) => {
    const g = globalThis as unknown as Hooks
    return g.__orbitTabs.toastView(g.__orbit.windowIds()[wi])
  }, w)
}

/** A sidebar row's right-click menu as the overlay draws it (TB-14). */
export interface RowMenuInfo {
  /** The row it is for (its slot's key). */
  key: string
  label: string
  /** Item labels, submenus as "Parent > Child". */
  labels: string[]
  enabled: Record<string, boolean>
  checked: Record<string, boolean>
  /** "Label=key" for each item that shows a key (KS-18). */
  hints: string[]
  /** The system's menu: a Peek had the overlay when it opened (PK-13). */
  native: boolean
}

/** The row menu open in window `w`, or null. */
export function rowMenu(app: ElectronApplication, w = 0): Promise<RowMenuInfo | null> {
  return app.evaluate((_e, wi) => {
    const g = globalThis as unknown as Hooks
    return g.__orbitTabs.rowMenu(g.__orbit.windowIds()[wi])
  }, w)
}

/** Waits for the menu of row `key` to be open in window `w`; returns its labels. */
export async function menuFor(app: ElectronApplication, key: string, w = 0): Promise<string[]> {
  await expect.poll(async () => (await rowMenu(app, w))?.key ?? null).toBe(key)
  return (await rowMenu(app, w))?.labels ?? []
}

/** Chooses an item of the open row menu by its label path, as a click in the menu does. */
export function chooseRowMenu(app: ElectronApplication, path: string, w = 0): Promise<boolean> {
  return app.evaluate(
    (_e, [label, wi]) => {
      const g = globalThis as unknown as Hooks
      return g.__orbitTabs.chooseRowMenu(label as string, g.__orbit.windowIds()[wi as number])
    },
    [path, w] as const,
  )
}

/** Closes whatever the overlay shows (a row menu left open after reading it). */
export function closeOverlay(app: ElectronApplication, w = 0): Promise<unknown> {
  return cmd(app, 'overlay.close', {}, w)
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

/** Waits until a tab is awake, shows a URL containing `part` and finished loading (its page title arrived). */
export async function waitTab(app: ElectronApplication, id: string, part: string): Promise<void> {
  await expect
    .poll(async () => {
      const t = await tab(app, id)
      return !!t && t.url.includes(part) && !t.loading && !t.asleep && !/^localhost(:\d+)?$/.test(t.title)
    })
    .toBe(true)
}

export function row(shell: Page, tabId: string): Locator {
  return shell.locator(`[data-testid="tab-row"][data-tab-id="${tabId}"]`)
}

export async function center(
  loc: Locator,
): Promise<{ x: number; y: number; box: { x: number; y: number; width: number; height: number } }> {
  await settled(loc.page())
  const box = await loc.boundingBox()
  if (!box) throw new Error('not visible')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box }
}

/** Waits until rows have finished growing in or out (row heights stable across frames). */
export async function settled(page: Page, timeout = 10_000): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const sample = () =>
            [...document.querySelectorAll<HTMLElement>('.row-slot')]
              .map((el) => `${el.dataset.exiting ? 'x' : ''}${el.offsetHeight}`)
              .join(',')
          const a = sample()
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
          const b = sample()
          const rows = [...document.querySelectorAll<HTMLElement>('.row-slot:not(.row-slot--split)')]
          return a === b && rows.every((el) => !!el.dataset.exiting || el.offsetHeight === 32)
        }),
      { timeout },
    )
    .toBe(true)
}

/** Presses on `from`, drags past the threshold to (x, y) and releases (unless `hold`). */
export async function drag(page: Page, from: Locator, to: { x: number; y: number }, opts: { hold?: boolean } = {}) {
  await settled(page)
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
