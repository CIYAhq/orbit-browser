import type { ElectronApplication, Page } from '@playwright/test'
import type { OrbitState } from '../../src/shared/state'
import { run, state } from './helpers'

/** Helpers for the Spaces/profiles e2e tests. */

export async function win(app: ElectronApplication) {
  const s = await state(app)
  return Object.values(s.windows)[0] as OrbitState['windows'][string]
}

export async function activeSpace(app: ElectronApplication): Promise<string> {
  return (await win(app)).spaceId
}

export async function order(app: ElectronApplication): Promise<string[]> {
  return (await state(app)).spaceOrder
}

export async function names(app: ElectronApplication): Promise<string[]> {
  const s = await state(app)
  return s.spaceOrder.map((id) => s.spaces[id]?.name ?? '?')
}

export async function createSpace(
  app: ElectronApplication,
  args: { name?: string; icon?: string; profileId?: string; activate?: boolean; afterSpaceId?: string } = {},
): Promise<string> {
  return (await run(app, 'spaces.create', args)) as string
}

export async function newTab(app: ElectronApplication, url: string, extra: Record<string, unknown> = {}) {
  return (await run(app, 'tabs.create', { url, ...extra })) as string
}

/** The strip's current translateX in px (0 at rest). */
export async function stripX(shell: Page): Promise<number> {
  return shell.evaluate(() => {
    const track = document.querySelector<HTMLElement>('.space-strip__track')
    const m = /translate3d\((-?[\d.]+)px/.exec(track?.style.transform ?? '')
    return m ? Number(m[1]) : 0
  })
}

export async function stripWidth(shell: Page): Promise<number> {
  return shell.evaluate(() => document.querySelector<HTMLElement>('.space-strip')?.clientWidth ?? 0)
}

/** Moves the mouse over the middle of the sidebar's tab list. */
export async function hoverSidebar(shell: Page): Promise<void> {
  const box = await shell.getByTestId('space-strip').boundingBox()
  if (!box) throw new Error('no strip')
  await shell.mouse.move(box.x + box.width / 2, box.y + Math.min(120, box.height / 2))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * A two-finger horizontal swipe as wheel events (deltaX > 0 = toward the next
 * Space with natural scrolling): `steps` events of `dx` px, `interval` ms apart.
 */
export async function swipe(shell: Page, dx: number, steps: number, interval = 16, dy = 0): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await shell.mouse.wheel(dx, dy)
    if (interval) await sleep(interval)
  }
}

/**
 * A quick flick: wheel events dispatched inside the page at a fixed pace, so
 * the release velocity doesn't depend on the test driver's latency.
 */
export async function flick(shell: Page, deltas: number[], intervalMs: number): Promise<void> {
  await shell.evaluate(
    async ([ds, ms]) => {
      const target = document.querySelector('[data-testid="sidebar-scroll"]') as HTMLElement
      for (const d of ds) {
        target.dispatchEvent(new WheelEvent('wheel', { deltaX: d, deltaY: 0, bubbles: true, cancelable: true }))
        await new Promise((r) => setTimeout(r, ms))
      }
    },
    [deltas, intervalMs] as const,
  )
}

/** Waits until the strip is back at rest (no previews mounted). */
export async function settled(shell: Page): Promise<void> {
  await shell.waitForFunction(
    () => {
      const track = document.querySelector<HTMLElement>('.space-strip__track')
      return !!track && track.style.transform === '' && document.querySelectorAll('[data-preview-space]').length === 0
    },
    undefined,
    { timeout: 5000 },
  )
}

/** A property of the theme's background layer (`.shell-bg`), e.g. --bg-top. */
export async function bgVar(shell: Page, name: string): Promise<string> {
  return shell.evaluate(
    (n) => (document.querySelector('.shell-bg') as HTMLElement).style.getPropertyValue(n).trim(),
    name,
  )
}

/** Shell CSS variable value (e.g. the theme's --frame-top). */
export async function cssVar(shell: Page, name: string): Promise<string> {
  return shell.evaluate(
    (n) => (document.querySelector('[data-testid="shell"]') as HTMLElement).style.getPropertyValue(n).trim(),
    name,
  )
}
