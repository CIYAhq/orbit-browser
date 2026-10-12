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
  FRAME_SLACK,
  isMac,
  launchOrbit,
  MOD,
  type Orbit,
  run,
  startFixtures,
  state,
  tabPage,
  viewPage,
} from './helpers'
import { pressInPage, toolsInfo, toolsPage } from './nav-support'
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

// ---- A view put back in the window never shows its last frame first (NV-06, AR-02) ----

/** A frame the page tools' page drew: the find bar's text and the zoom indicator's number in it, if any. */
interface ToolsFrame {
  /** When (ms since the epoch, as main counts it). */
  at: number
  find: string | null
  zoom: string | null
  /** Which zoom indicator element it drew (1, 2…), 0 for none. */
  pill: number
}

/**
 * Logs, in main, each time the page tools' view goes into or out of the first window: when (ms since
 * the epoch, as their page counts it) and whether it is in. Returns a reader that stops it.
 */
async function watchToolsView(app: ElectronApplication): Promise<() => Promise<{ at: number; attached: boolean }[]>> {
  await app.evaluate(() => {
    type Orbit = {
      windowIds: () => string[]
      ctx: { windows: { get: (id: string) => Electron.BrowserWindow | undefined } }
    }
    const g = globalThis as unknown as {
      __orbit: Orbit
      __feelFixTools?: { log: { at: number; attached: boolean }[]; stop: () => void }
    }
    g.__feelFixTools?.stop()
    const win = g.__orbit.ctx.windows.get(g.__orbit.windowIds()[0] as string)
    if (!win) throw new Error('no window')
    const log: { at: number; attached: boolean }[] = []
    let attached = false
    const host = win.contentView as unknown as Record<string, (...args: unknown[]) => unknown>
    const undo = (['addChildView', 'removeChildView'] as const).map((name) => {
      const original = host[name] as (...args: unknown[]) => unknown
      host[name] = function (this: unknown, ...args: unknown[]) {
        const result = original.apply(this, args)
        const contents = (args[0] as Electron.WebContentsView | undefined)?.webContents
        if (contents && !contents.isDestroyed() && contents.getURL().includes('view=tools')) {
          const now = win.contentView.children.includes(args[0] as Electron.View)
          if (now !== attached) log.push({ at: performance.timeOrigin + performance.now(), attached: now })
          attached = now
        }
        return result
      }
      return () => {
        host[name] = original
      }
    })
    g.__feelFixTools = {
      log,
      stop: () => {
        for (const fn of undo) fn()
      },
    }
  })
  return () =>
    app.evaluate(() => {
      const g = globalThis as unknown as {
        __feelFixTools?: { log: { at: number; attached: boolean }[]; stop: () => void }
      }
      g.__feelFixTools?.stop()
      const log = g.__feelFixTools?.log ?? []
      g.__feelFixTools = undefined
      return log
    })
}

/** Records, in the page tools' page, what each frame it draws holds. Returns a reader. */
async function recordTools(tools: Page): Promise<() => Promise<ToolsFrame[]>> {
  await tools.evaluate(() => {
    const frames: ToolsFrame[] = []
    ;(window as unknown as { __feelFixFrames: ToolsFrame[] }).__feelFixFrames = frames
    const ids = new WeakMap<Element, number>()
    let next = 0
    const tick = () => {
      const input = document.querySelector<HTMLInputElement>('[data-testid="find-input"]')
      const pill = document.querySelector('[data-testid="zoom-indicator"]')
      if (pill && !ids.has(pill)) ids.set(pill, ++next)
      frames.push({
        at: performance.timeOrigin + performance.now(),
        find: input ? input.value : null,
        zoom: pill ? (pill.querySelector('[data-testid="zoom-percent"]')?.textContent ?? '') : null,
        pill: pill ? (ids.get(pill) ?? 0) : 0,
      })
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  return () => tools.evaluate(() => (window as unknown as { __feelFixFrames: ToolsFrame[] }).__feelFixFrames)
}

const drew = (f: ToolsFrame | undefined) =>
  !f
    ? 'nothing yet'
    : f.find !== null
      ? `the find bar ("${f.find}")`
      : f.zoom !== null
        ? `the zoom indicator (${f.zoom})`
        : 'nothing'

test('[NV-06][NV-05] the page tools leave the window drawn empty, so put back they never show the old find bar or zoom first; the zoom indicator changes its number in place', async () => {
  const { app } = orbit
  const mod = isMac ? 'meta' : 'control'
  const tabId = await openTab('Tools')
  await expect.poll(async () => (await state(app)).tabs[tabId]?.title).toBe('Tools')
  const tools = await toolsPage(app)
  await expect.poll(async () => ((await toolsInfo(app)) as { ready?: boolean }).ready, { timeout: 10_000 }).toBe(true)
  const placements = await watchToolsView(app)
  const frames = await recordTools(tools)
  const lastFrame = async () =>
    (await tools.evaluate(() => (window as unknown as { __feelFixFrames: ToolsFrame[] }).__feelFixFrames.at(-1))) as
      | ToolsFrame
      | undefined
  const gone = async () => {
    await expect.poll(async () => (await toolsInfo(app)).placed, { timeout: 8000 }).toBe(false)
    // Out of the window (it may stay a moment, drawn empty): its page draws no more frames.
    await expect
      .poll(async () => {
        const before = (await lastFrame())?.at
        await new Promise((r) => setTimeout(r, 120))
        return before === (await lastFrame())?.at
      })
      .toBe(true)
  }
  // The find bar, with a search, closed with Esc.
  await pressInPage(app, '/page/Tools', 'F', [mod])
  await expect(tools.getByTestId('find-input')).toBeFocused()
  await tools.keyboard.type('page')
  await expect(tools.getByTestId('find-count')).toHaveText(/^\d+\/\d+$/)
  await tools.keyboard.press('Escape')
  await gone()
  // ⌘+ twice: the indicator comes, then its number changes.
  const percent = tools.getByTestId('zoom-percent')
  await pressInPage(app, '/page/Tools', '=', [mod])
  await expect(percent).toHaveText('110%')
  await expect.poll(async () => (await lastFrame())?.zoom).toBe('110%')
  await pressInPage(app, '/page/Tools', '=', [mod])
  await expect(percent).toHaveText('125%')
  await expect.poll(async () => (await lastFrame())?.zoom).toBe('125%')
  // It goes on its own; ⌘0 brings it back at 100%, and it goes again.
  await gone()
  await pressInPage(app, '/page/Tools', '0', [mod])
  await expect(percent).toHaveText('100%')
  await expect.poll(async () => (await lastFrame())?.zoom).toBe('100%')
  await gone()

  const log = await placements()
  const drawn = await frames()
  // Each time the view is put back, it shows what it last drew until it draws again.
  const returns = log.filter((e) => e.attached && drawn.some((f) => f.at < e.at))
  const shownFirst = returns.map((e) => drew(drawn.filter((f) => f.at < e.at).at(-1)))
  console.info(`[feel] NV-06 the page tools put back in the window, before they draw again: ${shownFirst.join('; ')}`)
  // While it shows, the indicator stays one element, in every frame from 110% to 125%.
  const from = drawn.findIndex((f) => f.zoom === '110%')
  const to = drawn.findIndex((f) => f.zoom === '125%')
  const pills = [...new Set(drawn.slice(from, to + 1).map((f) => f.pill))]
  console.info(
    `[feel] NV-06 the zoom indicator from 110% to 125%: ${pills.length === 1 && pills[0] ? 'the same element in every frame' : `elements ${pills.join(', ')} (0: a frame without one)`}`,
  )
  expect(returns.length).toBeGreaterThanOrEqual(2)
  expect({ shownFirst, pills: pills.length }).toEqual({ shownFirst: returns.map(() => 'nothing'), pills: 1 })
  expect(pills[0]).toBeGreaterThan(0)
})

/** A frame the Library's page drew. */
interface LibraryFrame {
  at: number
  visible: boolean
  open: string
  opacity: number
  section: string
  /** The sections whose entry in the list shows highlighted (its background, as drawn). */
  marked: string[]
}

/** What the Library's page draws now (its next frame, if nothing changes first). */
function libraryNow(): LibraryFrame | null {
  const el = document.querySelector<HTMLElement>('[data-testid="library"]')
  if (!el) return null
  const alpha = (c: string) => {
    if (c === 'transparent') return 0
    const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(c)
    if (slash) return Number(slash[1]) / (slash[2] ? 100 : 1)
    const parts = /\(([^)]*)\)/.exec(c)?.[1]?.split(',') ?? []
    return parts.length === 4 ? Number(parts[3]) : 1
  }
  return {
    at: performance.now(),
    visible: document.visibilityState === 'visible',
    open: el.dataset.open ?? '',
    opacity: Number(getComputedStyle(el).opacity),
    section: el.querySelector('[data-testid="library-section"]')?.getAttribute('data-section-id') ?? '',
    marked: [...el.querySelectorAll('[data-testid="library-nav-item"]')]
      .filter((b) => alpha(getComputedStyle(b).backgroundColor) > 0.02)
      .map((b) => b.getAttribute('data-section-id') ?? ''),
  }
}

test('[AR-02][FL-24][DL-10] the Library made ahead of its first open draws nothing until it opens, then only the section it opens on; a later open too', async () => {
  const { app } = orbit
  await run(app, 'archive.testSeed', { base: fx.url(''), count: 30, days: 3 })
  // Nothing loading and nothing over the window: the view is made a few seconds after launch, hidden.
  await expect
    .poll(async () => ((await run(app, 'library.testInfo')) as { ready: boolean }).ready, { timeout: 20_000 })
    .toBe(true)
  let lib: Page | undefined
  await expect
    .poll(() => {
      lib = app.windows().find((p) => p.url().includes('view=library'))
      return !!lib
    })
    .toBe(true)
  const page = lib as Page
  await expect(page.getByTestId('library')).toHaveAttribute('data-open', 'false')
  // What its first frame draws, before it hears what to show: nothing, with no section marked.
  const idle = (await page.evaluate(`(${libraryNow.toString()})()`)) as LibraryFrame | null
  await page.evaluate(`(() => {
    const frames = []
    window.__feelFixLibrary = frames
    const now = ${libraryNow.toString()}
    const tick = () => {
      const f = now()
      if (f) frames.push(f)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })()`)
  const frames = () => page.evaluate('window.__feelFixLibrary') as Promise<LibraryFrame[]>
  /** Opens the Library on `section` and returns the frames that showed it as anything else. */
  const openOn = async (section: string) => {
    await page.evaluate('window.__feelFixLibrary.length = 0')
    await run(app, 'library.open', { section })
    await expect(page.getByTestId('library')).toHaveAttribute('data-open', 'true')
    await expect.poll(async () => (await frames()).some((f) => f.opacity >= 0.999), { timeout: 5000 }).toBe(true)
    const drawn = await frames()
    const first = drawn.find((f) => f.visible && f.opacity > 0.01)
    console.info(
      `[feel] AR-02 open on ${section}: ${drawn.length} frames; the first it shows in, ${first ? `${(first.at - (drawn[0]?.at ?? 0)).toFixed(0)} ms after the first: ${first.open === 'true' ? 'open' : 'closed'} on ${first.section}, ${first.marked.join(', ') || 'nothing'} marked, opacity ${first.opacity.toFixed(2)}` : 'none'}`,
    )
    return drawn
      .filter((f) => f.visible && f.opacity > 0.01)
      .filter((f) => f.open !== 'true' || f.section !== section || f.marked.some((id) => id !== section))
      .map(
        (f) =>
          `${f.open === 'true' ? 'open' : 'closed'} on ${f.section}, ${f.marked.join(', ') || 'nothing'} marked, at ${f.opacity.toFixed(2)}`,
      )
  }
  // The first open, on another section than the one it was made with (DL-10: Downloads after a download).
  const firstOpen = await openOn('downloads')
  await run(app, 'library.close', {})
  await expect
    .poll(async () => ((await run(app, 'library.testInfo')) as { visible: boolean }).visible, { timeout: 5000 })
    .toBe(false)
  // A later open, on the Archive.
  const laterOpen = await openOn('archive')
  expect({ idle: { opacity: idle?.opacity, marked: idle?.marked }, firstOpen, laterOpen }).toEqual({
    idle: { opacity: 0, marked: [] },
    firstOpen: [],
    laterOpen: [],
  })
})

test('[AR-02][FL-24] a closed Library leaves the window once its page has drawn itself faded out, even when its page draws late; not on a timer', async () => {
  const { app } = orbit
  await run(app, 'library.open', { section: 'archive' })
  let lib: Page | undefined
  await expect
    .poll(() => {
      lib = app.windows().find((p) => p.url().includes('view=library'))
      return !!lib
    })
    .toBe(true)
  const page = lib as Page
  await expect(page.getByTestId('library')).toHaveAttribute('data-open', 'true')
  const opacity = () =>
    page.evaluate(() => Number(getComputedStyle(document.querySelector('.library') as Element).opacity))
  await expect.poll(opacity).toBe(1)
  // Main: when the Library's view hides (main's clock).
  await app.evaluate(() => {
    const g = globalThis as unknown as {
      __orbit: { ctx: { windows: { get(id: string): Electron.BrowserWindow | undefined; ids(): string[] } } }
      __feelLibraryHidden?: number
    }
    const ctx = g.__orbit.ctx
    const win = ctx.windows.get(ctx.windows.ids()[0] as string)
    const view = win?.contentView.children.find((v) =>
      (v as Electron.WebContentsView).webContents?.getURL().includes('view=library'),
    )
    if (!view) throw new Error('no Library view')
    g.__feelLibraryHidden = 0
    const setVisible = view.setVisible.bind(view)
    view.setVisible = (visible: boolean) => {
      if (!visible && !g.__feelLibraryHidden) g.__feelLibraryHidden = performance.timeOrigin + performance.now()
      setVisible(visible)
    }
  })
  // The page: the opacity of each frame it draws; and, 50 ms into its fade, it falls 250 ms behind
  // (as on a loaded machine), so the fade's last frames come late.
  await page.evaluate(() => {
    const w = window as unknown as {
      __feelLibraryFrames: { wall: number; opacity: number }[]
      orbit: { on(channel: string, listener: (payload: unknown) => void): () => void }
    }
    const el = document.querySelector('.library') as Element
    w.__feelLibraryFrames = []
    const tick = () => {
      w.__feelLibraryFrames.push({
        wall: performance.timeOrigin + performance.now(),
        opacity: Number(getComputedStyle(el).opacity),
      })
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    w.orbit.on('library:hide', () => {
      setTimeout(() => {
        const end = performance.now() + 250
        while (performance.now() < end) {}
      }, 50)
    })
  })
  const closedAt = await app.evaluate(() => performance.timeOrigin + performance.now())
  await run(app, 'library.close', {})
  await expect
    .poll(() =>
      app.evaluate(() => (globalThis as unknown as { __feelLibraryHidden?: number }).__feelLibraryHidden ?? 0),
    )
    .toBeGreaterThan(0)
  const hidden = await app.evaluate(
    () => (globalThis as unknown as { __feelLibraryHidden: number }).__feelLibraryHidden,
  )
  const frames = await page.evaluate(
    () => (window as unknown as { __feelLibraryFrames: { wall: number; opacity: number }[] }).__feelLibraryFrames,
  )
  const before = frames.filter((f) => f.wall <= hidden)
  const last = before.at(-1)
  const faded = frames.find((f) => f.wall >= closedAt && f.opacity === 0)
  console.info(
    `[feel] FL-24 Library close: view hidden ${(hidden - closedAt).toFixed(0)} ms after the close; the last frame before, at opacity ${last?.opacity.toFixed(2)}; the first at 0, ${faded ? `${(faded.wall - closedAt).toFixed(0)} ms` : 'none'}`,
  )
  // The last frame the page drew before its view left was the fade's end…
  expect(last?.opacity).toBe(0)
  // …and the view left as soon as the page had drawn it (two frames to say so), not on a timer.
  expect(faded).toBeDefined()
  expect(hidden - (faded?.wall ?? 0)).toBeLessThanOrEqual(150 * FRAME_SLACK)
})
