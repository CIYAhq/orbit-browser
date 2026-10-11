/**
 * Frames the "feels right" sign-off held back (reviews/feel-signoff-1.md), each checked where the
 * gap showed: in main, where the page views are, or in the renderers, frame by frame. Each test logs
 * its numbers (`[feel]` lines) beside their targets.
 */
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { note } from './frames'
import {
  action,
  type Fixtures,
  launchOrbit,
  MOD,
  type Orbit,
  run,
  startFixtures,
  state,
  tabPage,
  viewPage,
} from './helpers'
import { screenPage, swipeInfo, swipeOverPage, waitNoScreen, waitScreen } from './pages-support'

let fx: Fixtures
let orbit: Orbit

test.describe.configure({ timeout: 120_000 })

test.beforeAll(async () => {
  fx = await startFixtures()
})
test.afterAll(async () => {
  await fx.close()
})
test.beforeEach(async () => {
  orbit = await launchOrbit()
})
test.afterEach(async () => {
  await orbit.app.close()
})

async function openTab(name: string, activate = true): Promise<string> {
  return (await run(orbit.app, 'tabs.create', { url: fx.url(`/page/${name}`), activate })) as string
}

type Box = { x: number; y: number; width: number; height: number }

const near = (a: Box | undefined | null, b: Box | undefined | null, tol = 1.5) =>
  !!a &&
  !!b &&
  Math.abs(a.x - b.x) <= tol &&
  Math.abs(a.y - b.y) <= tol &&
  Math.abs(a.width - b.width) <= tol &&
  Math.abs(a.height - b.height) <= tol

// ---- Page views, sampled in main ----

interface ViewState {
  bounds: Box
  visible: boolean
  /** A child of the window's content view (it can draw). */
  attached: boolean
}
interface ViewSample {
  t: number
  views: Record<string, ViewState>
}

/**
 * Records, in main, every tab view of the first window: where it is, whether it is shown, whether it
 * is attached. A sample is taken once the code that moved, showed, hid, attached or removed a view
 * has run through (what the next frame draws), and every 4 ms besides. Returns a reader that stops it.
 */
async function watchViews(app: ElectronApplication): Promise<() => Promise<ViewSample[]>> {
  await app.evaluate(() => {
    type View = Electron.WebContentsView & Record<string, unknown>
    type Orbit = {
      windowIds: () => string[]
      state: () => { tabs: Record<string, unknown> }
      ctx: {
        tabs: { get: (id: string) => View | undefined }
        windows: { get: (id: string) => Electron.BrowserWindow | undefined }
      }
    }
    const g = globalThis as unknown as {
      __orbit: Orbit
      __feelFixViews?: { samples: ViewSample[]; stop: () => void }
    }
    g.__feelFixViews?.stop()
    const o = g.__orbit
    const win = o.ctx.windows.get(o.windowIds()[0] as string)
    if (!win) throw new Error('no window')
    const samples: ViewSample[] = []
    let queued = false
    const snap = () => {
      queued = false
      if (win.isDestroyed()) return
      const children = win.contentView.children
      const views: Record<string, ViewState> = {}
      for (const id of Object.keys(o.state().tabs)) {
        const view = o.ctx.tabs.get(id)
        if (!view) continue
        views[id] = { bounds: view.getBounds(), visible: view.getVisible(), attached: children.includes(view) }
      }
      samples.push({ t: performance.now(), views })
    }
    const later = () => {
      if (queued) return
      queued = true
      queueMicrotask(snap)
    }
    const undo: (() => void)[] = []
    const wrap = (target: object, name: string) => {
      const host = target as Record<string, unknown>
      const original = host[name] as (...args: unknown[]) => unknown
      host[name] = function (this: unknown, ...args: unknown[]) {
        const result = original.apply(this, args)
        later()
        return result
      }
      undo.push(() => {
        host[name] = original
      })
    }
    wrap(win.contentView, 'addChildView')
    wrap(win.contentView, 'removeChildView')
    for (const id of Object.keys(o.state().tabs)) {
      const view = o.ctx.tabs.get(id)
      if (!view) continue
      wrap(view, 'setBounds')
      wrap(view, 'setVisible')
    }
    const timer = setInterval(snap, 4)
    g.__feelFixViews = {
      samples,
      stop: () => {
        clearInterval(timer)
        for (const fn of undo.splice(0)) fn()
      },
    }
    snap()
  })
  return () =>
    app.evaluate(() => {
      const g = globalThis as unknown as { __feelFixViews?: { samples: ViewSample[]; stop: () => void } }
      g.__feelFixViews?.stop()
      const samples = g.__feelFixViews?.samples ?? []
      g.__feelFixViews = undefined
      return samples
    })
}

const shown = (v: ViewState | undefined): v is ViewState => !!v && v.visible && v.attached

function union(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  const right = Math.max(...boxes.map((b) => b.x + b.width))
  const bottom = Math.max(...boxes.map((b) => b.y + b.height))
  return { x, y, width: right - x, height: bottom - y }
}

/** The space between two boxes: positive when they are apart, negative when they overlap. */
function gapBetween(a: Box, b: Box): number {
  const across = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width))
  const down = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height))
  return Math.max(across, down)
}

const inside = (a: Box, area: Box, tol = 1) =>
  a.x >= area.x - tol &&
  a.y >= area.y - tol &&
  a.x + a.width <= area.x + area.width + tol &&
  a.y + a.height <= area.y + area.height + tol

// ---- SV-02, SV-03, SV-07, SV-15: an open tab chosen for a pane ----

/** The tabs of the split that holds `tabId`, in layout order. */
async function splitTabs(app: ElectronApplication, tabId: string): Promise<string[]> {
  const s = await state(app)
  for (const split of Object.values(s.splits)) {
    const ids: string[] = JSON.stringify(split.layout).match(/t-[a-z0-9]+/g) ?? []
    if (ids.includes(tabId)) return ids
  }
  return []
}

/** Waits until each tab's page view is shown over its pane card and the cards hold still. */
async function settledOver(o: Orbit, tabIds: string[]): Promise<void> {
  await expect
    .poll(
      async () => {
        const cards = await o.shell.evaluate(async (ids) => {
          const boxes = () =>
            ids.map((id) => {
              const el = document.querySelector(`[data-testid="split-pane"][data-tab-id="${id}"]`)
              const r = el?.getBoundingClientRect()
              return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
            })
          const before = boxes()
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
          const after = boxes()
          return JSON.stringify(before) === JSON.stringify(after) ? after : null
        }, tabIds)
        if (!cards) return false
        const views = await o.app.evaluate((_e, ids) => {
          const hooks = (
            globalThis as unknown as {
              __orbit: { tabView: (id: string) => { bounds: Box; visible: boolean } | null }
            }
          ).__orbit
          return ids.map((id) => hooks.tabView(id))
        }, tabIds)
        return tabIds.every((_, i) => views[i]?.visible === true && near(views[i]?.bounds, cards[i]))
      },
      { message: `views of ${tabIds.join(', ')} over their panes` },
    )
    .toBe(true)
}

/**
 * Chooses an open tab in the command bar (already open for a pane) with Enter, sampling the page
 * views in main from just before Enter until the split has settled. Returns what was seen.
 */
async function chooseOpenTab(overlay: Page, text: string, chosen: string, panes: string[]) {
  const input = overlay.getByTestId('command-input')
  await expect(input).toBeFocused()
  await input.fill(text)
  const first = overlay.getByTestId('command-result').first()
  await expect(first).toHaveAttribute('data-kind', 'tab')
  await expect(first).toContainText(text)
  const read = await watchViews(orbit.app)
  await input.press('Enter')
  await expect.poll(() => splitTabs(orbit.app, panes[0] as string)).toEqual(expect.arrayContaining(panes))
  await settledOver(orbit, panes)
  const samples = await read()
  const end = samples.at(-1)
  const area = union(panes.map((id) => end?.views[id]?.bounds).filter((b): b is Box => !!b))
  const others = panes.filter((id) => id !== chosen)
  // Each sample: the chosen tab's view never covers the split's whole area; every shown pane's view
  // stays inside it, FL-18's 8 px gutter apart; the other panes stay attached and shown.
  const alone = samples.filter((s) => {
    const v = s.views[chosen]
    return shown(v) && v.bounds.width >= area.width - 8 && v.bounds.height >= area.height - 8
  })
  const outside = samples.filter((s) => panes.some((id) => shown(s.views[id]) && !inside(s.views[id].bounds, area)))
  const crowded = samples.filter((s) => {
    const live = panes.map((id) => s.views[id]).filter(shown)
    return live.some((a, i) => live.some((b, j) => j > i && gapBetween(a.bounds, b.bounds) < 7))
  })
  const dropped = samples.filter((s) => others.some((id) => !shown(s.views[id])))
  // Once shown, the chosen tab's view keeps the pane's place: it takes the empty pane's card as it is.
  const firstShown = samples.findIndex((s) => shown(s.views[chosen]))
  const resized = samples
    .slice(Math.max(0, firstShown))
    .filter((s) => shown(s.views[chosen]) && !near(s.views[chosen]?.bounds, end?.views[chosen]?.bounds, 1))
  return { samples: samples.length, alone, outside, crowded, dropped, resized, area }
}

test('[SV-02][SV-03][SV-07][SV-15] an open tab chosen for a pane goes straight into it: no frame shows it alone', async () => {
  const metrics = await openTab('Metrics')
  const standup = await openTab('Standup')
  const design = await openTab('Design')
  const notes = await openTab('Notes')
  const base = await openTab('Changelog')
  await settledOver(orbit, [base])
  const overlay = await viewPage(orbit.app, 'overlay')
  const input = overlay.getByTestId('command-input')
  const check = (round: string, seen: Awaited<ReturnType<typeof chooseOpenTab>>) => {
    const span = (list: { t: number }[]) => ((list.at(-1)?.t ?? 0) - (list[0]?.t ?? 0)) as number
    note(round, 'samples with the chosen tab covering the split', seen.alone.length, '0', '')
    note(round, 'chosen tab shown alone for', seen.alone.length ? span(seen.alone) : 0, '0 ms')
    expect(seen.samples, round).toBeGreaterThan(5)
    expect(
      seen.alone.map((s) => s.t),
      `${round}: the chosen tab covers the split`,
    ).toEqual([])
    expect(
      seen.outside.map((s) => s.t),
      `${round}: a pane's view leaves the split`,
    ).toEqual([])
    expect(
      seen.crowded.map((s) => s.t),
      `${round}: two panes' views closer than the gutter`,
    ).toEqual([])
    expect(
      seen.dropped.map((s) => s.t),
      `${round}: another pane's view went away`,
    ).toEqual([])
    expect(
      seen.resized.map((s) => s.t),
      `${round}: the chosen tab's view changed size once shown`,
    ).toEqual([])
  }

  // SV-02: ⌃⇧= adds an empty pane on the right with the command bar; Enter on an open tab fills it.
  await orbit.shell.keyboard.press('Control+Shift+Equal')
  await expect(input).toBeFocused()
  await expect.poll(async () => (await splitTabs(orbit.app, base)).length).toBe(2)
  await settledOver(orbit, [base])
  check('SV-02', await chooseOpenTab(overlay, 'Metrics', metrics, [base, metrics]))

  // SV-03: Add Split Below from the command bar puts the next empty pane under the focused one.
  await orbit.shell.keyboard.press(`${MOD}+T`)
  await expect(input).toBeFocused()
  await input.fill('split below')
  await expect(overlay.getByTestId('command-result').first()).toContainText('Add Split Below')
  await input.press('Enter')
  await expect(overlay.getByTestId('command-bar')).toHaveAttribute('data-mode', 'edit-url')
  await expect.poll(async () => (await splitTabs(orbit.app, base)).length).toBe(3)
  await settledOver(orbit, [base, metrics])
  check('SV-03', await chooseOpenTab(overlay, 'Standup', standup, [base, metrics, standup]))

  // SV-07: the "+" menu's New Split View runs the same action as ⌃⇧=.
  await action(orbit.app, 'split.add')
  await expect(input).toBeFocused()
  await expect.poll(async () => (await splitTabs(orbit.app, base)).length).toBe(4)
  await settledOver(orbit, [base, metrics, standup])
  check('SV-07', await chooseOpenTab(overlay, 'Design', design, [base, metrics, standup, design]))

  // SV-15: ⌘L on a pane, then an open tab: it takes that pane's place.
  await orbit.shell.keyboard.press(`${MOD}+L`)
  await expect(overlay.getByTestId('command-bar')).toHaveAttribute('data-mode', 'edit-url')
  check('SV-15', await chooseOpenTab(overlay, 'Notes', notes, [base, metrics, standup, notes]))
  expect(await splitTabs(orbit.app, base)).not.toContain(design)
  expect(Object.keys((await state(orbit.app)).tabs)).toContain(design)
})

// ---- Reduce Motion in the page screens and the swipe arrow (D70, FL-28) ----

/** Turns Orbit's own Reduce Motion on (the system asks for nothing here). */
async function reduceMotion(app: ElectronApplication): Promise<void> {
  await action(app, 'app.toggleReduceMotion')
  await expect.poll(async () => (await state(app)).settings.reduceMotion).toBe(true)
}

/** The longest of a computed `transition-duration` list ("0.12s, 0s"), in ms. */
const longest = (durations: string) => Math.max(0, ...durations.split(',').map((d) => Number.parseFloat(d) * 1000))

test("[FL-28][NV-13] with Orbit's Reduce Motion on, a page's error screen shows in place, with no animation", async () => {
  const { app } = orbit
  const tabId = await openTab('Start')
  await expect.poll(async () => (await state(app)).tabs[tabId]?.title).toBe('Start')
  /** Whether the screen's view has reduced motion, and the animation its card runs as it shows. */
  const check = async (reduced: boolean) => {
    await run(app, 'tabs.navigate', { tabId, url: 'http://nonexistent.invalid/' })
    const shown = await waitScreen(app, (s) => s.tabId === tabId && s.onScreen)
    const view = await screenPage(app, shown.id)
    const card = view.locator(`[data-screen-id="${shown.id}"]`)
    await expect
      .poll(async () => ({
        reduced: await view.locator('html').evaluate((html) => html.classList.contains('reduce-motion')),
        animation: await card.evaluate((el) => getComputedStyle(el).animationName),
      }))
      .toEqual({ reduced, animation: reduced ? 'none' : 'page-screen-in' })
    await run(app, 'tabs.navigate', { tabId, url: fx.url('/page/Start') })
    await waitNoScreen(app, tabId)
  }
  // Off, with a system that asks for nothing: the card fades and rises in.
  await check(false)
  await reduceMotion(app)
  await check(true)
})

test("[FL-28][NV-02] with Orbit's Reduce Motion on, the swipe arrow fills and fades with no motion: no transition and no scale", async () => {
  const { app } = orbit
  const tabId = await openTab('One')
  await expect.poll(async () => (await state(app)).tabs[tabId]?.title).toBe('One')
  await (await tabPage(app, '/page/One')).evaluate((to) => location.assign(to), fx.url('/page/Two'))
  await expect.poll(async () => (await state(app)).tabs[tabId]?.title).toBe('Two')
  const windowId = Object.keys((await state(app)).windows)[0] as string
  /** A full swipe from `from` (the arrow fills, and letting go goes there); what its arrow did. */
  const check = async (from: string, to: string, deltas: number[], reduced: boolean) => {
    const info = await swipeOverPage(app, windowId, fx.url(`/page/${from}`), { x: 300, y: 300 }, deltas)
    expect(info).toMatchObject({ visible: true, armed: true })
    let view: Page | undefined
    await expect
      .poll(() => {
        view = app.windows().find((p) => p.url().includes('view=swipe'))
        return !!view
      })
      .toBe(true)
    const arrow = (view as Page).getByTestId('swipe-arrow')
    // Filled: its circle scales up a little as it fills, over the quick timing.
    await expect(arrow).toHaveAttribute('data-armed', 'true')
    const filled = await arrow.evaluate((el) => {
      const circle = el.querySelector('.swipe-arrow__circle') as HTMLElement
      const style = getComputedStyle(circle)
      return {
        reduced: document.documentElement.classList.contains('reduce-motion'),
        transform: style.transform,
        duration: style.transitionDuration,
      }
    })
    expect(filled.reduced).toBe(reduced)
    expect(filled.transform === 'none', `the filled circle's transform (${filled.transform})`).toBe(reduced)
    expect(longest(filled.duration) > 0, `the circle's transitions (${filled.duration})`).toBe(!reduced)
    // Let go: the page goes, and the arrow fades out (or just goes).
    await expect.poll(async () => (await state(app)).tabs[tabId]?.title).toBe(to)
    await expect.poll(() => arrow.evaluate((el) => el.classList.contains('is-done'))).toBe(true)
    const fade = await arrow.evaluate((el) => getComputedStyle(el).transitionDuration)
    expect(longest(fade) > 0, `the arrow's fade (${fade})`).toBe(!reduced)
    await expect.poll(async () => (await swipeInfo(app, windowId)).visible).toBe(false)
  }
  // Off: back to One, with motion.
  await check('Two', 'One', Array(8).fill(-16), false)
  await reduceMotion(app)
  // On: forward to Two again, without.
  await check('One', 'Two', Array(8).fill(16), true)
})
