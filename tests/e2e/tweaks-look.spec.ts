import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { colorCss, DEFAULT_TWEAK_STYLE } from '../../src/shared/tweaks'
import { bestOf, type Frame, note, pacing, record } from './frames'
import { FRAME_SLACK, launchOrbit, type Orbit, run, state } from './helpers'
import { act, cmd } from './tabs-support'
import {
  editorPage,
  openFixture,
  PHOTO,
  pageTweaks,
  pixelAt,
  rgbOf,
  startTweakFixtures,
  type TweakFixtures,
  waitEditor,
  zoomOf,
} from './tweaks-support'

/** Tweaks' no-code controls (BO-03 to BO-09, BO-12, BO-13). Feature IDs lead each title. */

let fx: TweakFixtures
let orbit: Orbit | undefined

test.beforeAll(async () => {
  fx = await startTweakFixtures()
})
test.afterAll(async () => {
  await fx.close()
})
test.afterEach(async () => {
  await orbit?.app.close()
  orbit = undefined
})

const openPage = (app: ElectronApplication, path: string) => openFixture(app, fx, path)

/** A new Tweak for a tab's site, made as New Tweak… does, its editor open (the intro already read). */
async function newTweak(app: ElectronApplication, tabId: string): Promise<{ id: string; view: Page }> {
  await run(app, 'tweaks.dismissIntro', {})
  const id = (await run(app, 'tweaks.create', { tabId })) as string
  await waitEditor(app, true)
  return { id, view: await editorPage(app) }
}

const styleOf = async (app: ElectronApplication, id: string) => {
  const tweak = (await state(app)).tweaks[id]
  if (!tweak) throw new Error(`no Tweak ${id}`)
  return tweak.style
}

/**
 * Points on the editor's wheel: where the big handle goes for a hue and a strength (0 to 1), and
 * where the rim handle rides at an angle (`out` px further out, clear of the big handle).
 */
async function wheelOf(view: Page) {
  const box = await view.getByTestId('tweak-wheel').boundingBox()
  if (!box) throw new Error('no wheel')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const rad = (deg: number) => (deg * Math.PI) / 180
  const point = (deg: number, r: number) => ({ x: cx + r * Math.sin(rad(deg)), y: cy - r * Math.cos(rad(deg)) })
  return {
    main: (hue: number, dist: number) => point(hue, (box.width / 2 - 16) * dist),
    rim: (deg: number, out = 0) => point(deg, box.width / 2 - 7 + out),
  }
}

/** A point of the page's own background, clear of its text and photo. */
const PLAIN = { x: 12, y: 520 }

const hueGap = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180)

test('[BO-03][BO-06] the colour wheel tints the page as the big handle moves, red then blue; the rim handle sets the accent and turns with the big one; arrow keys move them; Reset gives the site its own colours back and keeps the rest', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const { tabId } = await openPage(app, '/look/Wheel')
  const { id, view } = await newTweak(app, tabId)
  await view.getByTestId('tweak-size-up').click()
  await view.getByTestId('tweak-font-serif').click()
  await expect.poll(async () => (await styleOf(app, id)).font).toBe('serif')
  expect(await pixelAt(app, tabId, PLAIN.x, PLAIN.y)).toBe('#ffffff')
  await expect(view.getByTestId('tweak-color-reset')).toBeDisabled()

  // The big handle out to the rim at the top: a full red tint on the page's white.
  const at = await wheelOf(view)
  const red = at.main(0, 1)
  await view.mouse.move(red.x, red.y)
  await view.mouse.down()
  await view.mouse.up()
  await expect.poll(async () => (await styleOf(app, id)).intensity).toBeGreaterThan(0.95)
  expect(hueGap((await styleOf(app, id)).hue, 0)).toBeLessThan(3)
  await expect
    .poll(async () => {
      const [r, , b] = rgbOf(await pixelAt(app, tabId, PLAIN.x, PLAIN.y))
      return r - b
    })
    .toBeGreaterThan(40)

  // Dragged round to blue, the page follows.
  const blue = at.main(220, 1)
  await view.mouse.move(red.x, red.y)
  await view.mouse.down()
  await view.mouse.move(blue.x, blue.y, { steps: 12 })
  await view.mouse.up()
  await expect.poll(async () => hueGap((await styleOf(app, id)).hue, 220)).toBeLessThan(3)
  await expect
    .poll(async () => {
      const [r, , b] = rgbOf(await pixelAt(app, tabId, PLAIN.x, PLAIN.y))
      return b - r
    })
    .toBeGreaterThan(40)
  // The accent turned with it: it started on the main hue, and it is there still.
  expect(hueGap((await styleOf(app, id)).accent, 220)).toBeLessThan(3)

  // The rim handle takes the accent alone; the big handle turns it by as much as it turns.
  const rim = at.rim(220, 4)
  const to = at.rim(100)
  await view.mouse.move(rim.x, rim.y)
  await view.mouse.down()
  await view.mouse.move(to.x, to.y, { steps: 8 })
  await view.mouse.up()
  await expect.poll(async () => hueGap((await styleOf(app, id)).accent, 100)).toBeLessThan(3)
  expect(hueGap((await styleOf(app, id)).hue, 220)).toBeLessThan(3)
  const turn = at.main(250, 0.8)
  await view.mouse.move(turn.x, turn.y)
  await view.mouse.down()
  await view.mouse.up()
  await expect.poll(async () => hueGap((await styleOf(app, id)).hue, 250)).toBeLessThan(3)
  expect(hueGap((await styleOf(app, id)).accent, 130)).toBeLessThan(4)
  expect((await styleOf(app, id)).intensity).toBeCloseTo(0.8, 1)

  // Arrow keys: left and right turn the hue, up and down the strength.
  const before = await styleOf(app, id)
  await view.getByTestId('tweak-wheel-main').focus()
  await view.keyboard.press('ArrowRight')
  await view.keyboard.press('ArrowDown')
  await expect.poll(async () => hueGap((await styleOf(app, id)).hue, before.hue + 5)).toBeLessThan(0.2)
  await expect.poll(async () => (await styleOf(app, id)).intensity).toBeCloseTo(before.intensity - 0.05, 3)
  expect(hueGap((await styleOf(app, id)).accent, before.accent + 5)).toBeLessThan(0.2)
  await view.getByTestId('tweak-wheel-accent').focus()
  await view.keyboard.press('ArrowLeft')
  await expect.poll(async () => hueGap((await styleOf(app, id)).accent, before.accent)).toBeLessThan(0.2)

  // Reset: the site's own colours, the size and font kept (BO-06).
  await view.getByTestId('tweak-color-reset').click()
  await expect.poll(() => pixelAt(app, tabId, PLAIN.x, PLAIN.y)).toBe('#ffffff')
  const reset = await styleOf(app, id)
  expect([reset.intensity, reset.invert, reset.contrast, reset.brightness, reset.saturation]).toEqual([
    0,
    false,
    100,
    100,
    100,
  ])
  expect([reset.size, reset.font]).toEqual([110, 'serif'])
  await expect(view.getByTestId('tweak-color-reset')).toBeDisabled()
})

test('[BO-04][BO-05] invert makes a white page dark and keeps the photo’s colours; the sliders change contrast, brightness and the page’s own saturation, with 100 in the middle changing nothing', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const { tabId, page } = await openPage(app, '/look/Dark')
  const { id, view } = await newTweak(app, tabId)
  const photo = await page.evaluate(() => {
    const r = (document.getElementById('photo') as HTMLElement).getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  expect(await pixelAt(app, tabId, photo.x, photo.y)).toBe(PHOTO)

  await view.getByTestId('tweak-invert').click()
  await expect(view.getByTestId('tweak-invert')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => Math.max(...rgbOf(await pixelAt(app, tabId, PLAIN.x, PLAIN.y)))).toBeLessThan(40)
  // The photo isn't shown as a negative.
  const kept = rgbOf(await pixelAt(app, tabId, photo.x, photo.y))
  rgbOf(PHOTO).forEach((c, i) => {
    expect(Math.abs(c - (kept[i] as number))).toBeLessThanOrEqual(16)
  })
  await view.getByTestId('tweak-invert').click()
  await expect.poll(() => pixelAt(app, tabId, PLAIN.x, PLAIN.y)).toBe('#ffffff')

  // The sliders: each at 100, the middle of its range.
  await view.getByTestId('tweak-sliders').click()
  const sliders = ['contrast', 'brightness', 'saturation'] as const
  for (const name of sliders) {
    const input = view.getByTestId(`tweak-${name}`)
    await expect(input).toHaveValue('100')
    const [min, max] = await input.evaluate((el) => [
      Number((el as HTMLInputElement).min),
      Number((el as HTMLInputElement).max),
    ])
    expect((min + max) / 2).toBe(100)
  }
  const filter = () => page.evaluate(() => getComputedStyle(document.documentElement).filter)
  await view.getByTestId('tweak-contrast').fill('130')
  await view.getByTestId('tweak-brightness').fill('80')
  await view.getByTestId('tweak-saturation').fill('0')
  await expect
    .poll(async () => {
      const { contrast, brightness, saturation } = await styleOf(app, id)
      return { contrast, brightness, saturation }
    })
    .toEqual({ contrast: 130, brightness: 80, saturation: 0 })
  await expect.poll(filter).toContain('brightness(0.8)')
  expect(await filter()).toContain('contrast(1.3)')
  expect(await filter()).toContain('saturate(0)')
  // White at 80% brightness, a little lifted by the contrast.
  await expect.poll(async () => rgbOf(await pixelAt(app, tabId, PLAIN.x, PLAIN.y))[0]).toBeLessThan(240)
  // A double-click puts a slider back to the middle.
  await view.getByTestId('tweak-brightness').dblclick()
  await expect.poll(async () => (await styleOf(app, id)).brightness).toBe(100)
  await expect(view.getByTestId('tweak-brightness')).toHaveValue('100')

  await view.getByTestId('tweak-color-reset').click()
  await expect.poll(async () => (await styleOf(app, id)).contrast).toBe(100)
  for (const name of sliders) await expect(view.getByTestId(`tweak-${name}`)).toHaveValue('100')
  await expect.poll(filter).toBe('none')
})

test('[BO-03] dragging the wheel recolours the page as fast as the page could change its own colours', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const { tabId, page } = await openPage(app, '/look/Fps')
  const { view } = await newTweak(app, tabId)
  const at = await wheelOf(view)
  const filter = () => page.evaluate(() => getComputedStyle(document.documentElement).filter)

  /** Distinct colours the page showed, how many a second from the first to the last, and its slowest frame. */
  const summary = (frames: Frame[]) => {
    const filters = frames.map((f) => f.els.root?.style?.filter ?? '')
    const changed = frames.filter((_f, i) => i > 0 && filters[i] !== filters[i - 1])
    const first = changed[0]
    const last = changed.at(-1)
    const span = first && last ? last.t - first.t : 0
    const during = frames.filter((f) => first && last && f.t >= first.t && f.t <= last.t)
    return {
      changes: changed.length,
      rate: span > 0 ? ((changed.length - 1) * 1000) / span : 0,
      p99: pacing(during).p99,
    }
  }
  const watch = () => record(page, { root: { selector: 'html', style: ['filter'] } }, { maxMs: 6000 })

  // What this machine allows: the page itself puts in the very colours the drag below makes, one
  // each frame. Under a virtual display, with no GPU, that is near 30 a second; on a GPU, 60.
  const turn = (i: number) => ({ ...DEFAULT_TWEAK_STYLE, hue: (i * 6) % 360, accent: (i * 6) % 360, intensity: 0.7 })
  const sheets = Array.from({ length: 60 }, (_v, i) => colorCss(turn(i + 1)))
  const own = async () => {
    const rec = await watch()
    await page.evaluate(
      (list) =>
        new Promise<void>((resolve) => {
          const sheet = document.createElement('style')
          document.head.append(sheet)
          let i = 0
          const step = () => {
            sheet.textContent = list[i] ?? ''
            if (++i < list.length) requestAnimationFrame(step)
            else requestAnimationFrame(() => resolve(sheet.remove()))
          }
          requestAnimationFrame(step)
        }),
      sheets,
    )
    return summary((await rec.stop()).frames)
  }
  // The drag: a press on the big handle, then once round the wheel with a move in each of the panel's
  // frames, as a hand gives them. The moves are the page's own events: Playwright's take ~30 ms each
  // under load, too slow to give one a frame.
  const drag = async () => {
    const start = at.main(0, 0.7)
    await view.mouse.move(start.x, start.y)
    await view.mouse.down()
    const rec = await watch()
    const points = Array.from({ length: 60 }, (_v, i) => at.main((i + 1) * 6, 0.7))
    await view.evaluate(
      (list) =>
        new Promise<void>((resolve) => {
          const wheel = document.querySelector('[data-testid="tweak-wheel"]') as HTMLElement
          let i = 0
          const step = () => {
            const p = list[i] as { x: number; y: number }
            const move = { bubbles: true, pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: p.x, clientY: p.y }
            wheel.dispatchEvent(new PointerEvent('pointermove', move))
            if (++i < list.length) requestAnimationFrame(step)
            else resolve()
          }
          requestAnimationFrame(step)
        }),
      points,
    )
    // The last colour lands, then the page settles.
    await expect.poll(filter).toContain('hue-rotate')
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)))
    await view.mouse.up()
    return summary((await rec.stop()).frames)
  }
  const measure = async () => {
    const base = await own()
    const wheel = await drag()
    // Back to the site's own colours for the next round.
    await view.getByTestId('tweak-color-reset').click()
    await expect.poll(filter).toBe('none')
    return { base, wheel }
  }
  // D46: the drag keeps up with the page's own rate, and costs it at most a frame more at its slowest.
  const meets = (r: Awaited<ReturnType<typeof measure>>) =>
    r.wheel.rate >= 0.85 * r.base.rate && r.wheel.p99 <= Math.max(34, r.base.p99 + 17) * FRAME_SLACK
  const { best, all } = await bestOf(measure, meets)
  for (const r of all) {
    note(
      'BO-03',
      'page recolours per second as the page itself changes them, one a frame',
      r.base.rate,
      '60/s on a GPU',
      '/s',
    )
    note(
      'BO-03',
      'page recolours per second while the wheel is dragged',
      r.wheel.rate,
      `≥ ${Math.round(r.base.rate * 0.85)}/s (0.85× the page's own)`,
      '/s',
    )
    note(
      'BO-03',
      'slowest page frame during the drag (p99)',
      r.wheel.p99,
      `≤ ${Math.round(Math.max(34, r.base.p99 + 17))} ms (the page's own ${Math.round(r.base.p99)} ms, plus a frame)`,
    )
  }
  expect(best.base.changes).toBeGreaterThan(50)
  expect(best.wheel.changes).toBeGreaterThan(25)
  expect(best.wheel.rate).toBeGreaterThanOrEqual(0.85 * best.base.rate)
  expect(best.wheel.p99).toBeLessThanOrEqual(Math.max(34, best.base.p99 + 17) * FRAME_SLACK)
})

test('[BO-07][BO-09] font presets reach all the text but icons and code, and the active one chosen again gives the site its own fonts back; the case button goes through lowercase, UPPERCASE, Capitalized Words and back, never in fields', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const { tabId, page } = await openPage(app, '/look/Type')
  const { id, view } = await newTweak(app, tabId)
  const fontOf = (sel: string) =>
    page.evaluate((s) => getComputedStyle(document.querySelector(s) as Element).fontFamily, sel)
  const own = { text: await fontOf('#text'), icon: await fontOf('#icon'), code: await fontOf('#code') }
  await expect(view.locator('.tweak-font')).toHaveCount(8)

  await view.getByTestId('tweak-font-serif').click()
  await expect(view.getByTestId('tweak-font-serif')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => fontOf('#text')).toContain('Charter')
  expect(await fontOf('#title')).toContain('Charter')
  expect([await fontOf('#icon'), await fontOf('#code')]).toEqual([own.icon, own.code])
  await view.getByTestId('tweak-font-mono').click()
  await expect.poll(() => fontOf('#text')).toContain('ui-monospace')
  await expect(view.getByTestId('tweak-font-serif')).toHaveAttribute('aria-pressed', 'false')
  await view.getByTestId('tweak-font-mono').click()
  await expect.poll(() => fontOf('#text')).toBe(own.text)
  expect((await styleOf(app, id)).font).toBe('')

  const caseOf = (sel: string) =>
    page.evaluate((s) => getComputedStyle(document.querySelector(s) as Element).textTransform, sel)
  const steps = [
    ['lowercase', 'lowercase'],
    ['UPPERCASE', 'uppercase'],
    ['Capitalized Words', 'capitalize'],
    ['As written', 'none'],
  ] as const
  await expect(view.getByTestId('tweak-case')).toHaveText('As written')
  for (const [label, transform] of steps) {
    await view.getByTestId('tweak-case').click()
    await expect(view.getByTestId('tweak-case')).toHaveText(label)
    await expect.poll(() => caseOf('#text')).toBe(transform)
    expect(await caseOf('#field')).toBe('none')
  }
})

test('[BO-08][NV-06] the Tweak’s size and the page zoom multiply, each keeping its own value', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const { tabId, page } = await openPage(app, '/look/Size')
  const { id, view } = await newTweak(app, tabId)
  // How wide the photo is painted, in the window's pixels.
  const painted = () =>
    app.evaluate(
      async (_e, [tab, hex]) => {
        type G = { __orbit: { ctx: { tabs: { contents: (id: string) => Electron.WebContents | undefined } } } }
        const contents = (globalThis as unknown as G).__orbit.ctx.tabs.contents(tab)
        if (!contents) throw new Error('no page')
        const image = await contents.capturePage()
        const { width, height } = image.getSize()
        const px = image.toBitmap()
        const want = [
          Number.parseInt(hex.slice(5, 7), 16),
          Number.parseInt(hex.slice(3, 5), 16),
          Number.parseInt(hex.slice(1, 3), 16),
        ]
        let min = width
        let max = -1
        for (let y = 0; y < height; y += 3) {
          for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4
            if (want.every((c, k) => Math.abs((px[i + k] ?? 0) - c) <= 6)) {
              if (x < min) min = x
              if (x > max) max = x
            }
          }
        }
        return max >= min ? max - min + 1 : 0
      },
      [tabId, PHOTO] as const,
    )
  const base = await painted()
  expect(base).toBeGreaterThan(0)

  await view.getByTestId('tweak-size-up').click()
  await view.getByTestId('tweak-size-up').click()
  await expect(view.getByTestId('tweak-size')).toHaveText('125%')
  await expect.poll(async () => (await painted()) / base).toBeCloseTo(1.25, 1)

  // The page zoom on top: 125% × 110%.
  await act(app, 'page.zoomIn')
  await expect.poll(async () => ((await cmd(app, 'zoom.get', { tabId })) as { percent: number }).percent).toBe(110)
  await expect.poll(async () => (await painted()) / base).toBeCloseTo(1.375, 1)
  expect((await styleOf(app, id)).size).toBe(125)
  expect(await zoomOf(page)).toBe('1.25')
  await expect(view.getByTestId('tweak-size')).toHaveText('125%')

  // Back to the Tweak's size alone; the zoom stays the page's own.
  await act(app, 'page.zoomReset')
  await expect.poll(async () => (await painted()) / base).toBeCloseTo(1.25, 1)
  await view.getByTestId('tweak-size').click()
  await expect.poll(async () => (await painted()) / base).toBeCloseTo(1, 1)
  expect((await pageTweaks(app, tabId))?.parts).toEqual([])
})

test('[BO-12][BO-13] the name’s ▾ menu: Rename… edits it in place (Enter keeps it, Esc leaves it), Shuffle gives a new look but keeps hidden elements and code, and Reset all edits asks first, then clears every edit but the name', async () => {
  orbit = await launchOrbit()
  const { app } = orbit
  const { tabId, page } = await openPage(app, '/look/Menu')
  const { id, view } = await newTweak(app, tabId)
  const tweak = async () => (await state(app)).tweaks[id]

  // Rename…: Enter keeps the new name; the site's name shows beside it.
  await view.getByTestId('tweak-name').click()
  await expect(view.getByTestId('tweak-menu')).toBeVisible()
  await view.getByTestId('tweak-menu-rename').click()
  const input = view.getByTestId('tweak-name-input')
  await expect(input).toBeFocused()
  expect(
    await input.evaluate((el) => [(el as HTMLInputElement).selectionStart, (el as HTMLInputElement).selectionEnd]),
  ).toEqual([0, 9])
  await input.pressSequentially('Reading')
  await input.press('Enter')
  await expect(view.getByTestId('tweak-name')).toHaveText('Reading')
  await expect.poll(async () => (await tweak())?.name).toBe('Reading')
  await expect(view.locator('.tweak-panel__host')).toHaveText('localhost')

  // Esc leaves the name as it was, and the panel open; so does Esc in the menu.
  await view.getByTestId('tweak-name').click()
  await view.getByTestId('tweak-menu-rename').click()
  await view.getByTestId('tweak-name-input').pressSequentially('Other')
  await view.getByTestId('tweak-name-input').press('Escape')
  await expect(view.getByTestId('tweak-name')).toHaveText('Reading')
  await view.getByTestId('tweak-name').click()
  await expect(view.getByTestId('tweak-menu-rename')).toBeFocused()
  await view.keyboard.press('ArrowDown')
  await expect(view.getByTestId('tweak-menu-shuffle')).toBeFocused()
  await view.keyboard.press('Escape')
  await expect(view.getByTestId('tweak-menu')).toHaveCount(0)
  expect((await tweak())?.name).toBe('Reading')
  await waitEditor(app, true)

  // Something hidden and some code, which Shuffle never touches.
  await run(app, 'tweaks.update', { id, patch: { css: 'p { letter-spacing: 1px }' } })
  await view.getByTestId('tweak-hide-button').click()
  await expect(view.getByTestId('tweak-hide-hint')).toBeVisible()
  const title = await page.locator('#title').boundingBox()
  if (!title) throw new Error('no title')
  await page.mouse.move(title.x + 10, title.y + title.height / 2)
  await page.mouse.click(title.x + 10, title.y + title.height / 2)
  await view.getByTestId('tweak-hide-this').click()
  await expect.poll(async () => (await tweak())?.style.hidden.length).toBe(1)
  await view.getByTestId('tweak-hide-done').click()

  await view.getByTestId('tweak-name').click()
  await view.getByTestId('tweak-menu-shuffle').click()
  await expect.poll(async () => (await tweak())?.style.intensity ?? 0).toBeGreaterThan(0)
  const first = await tweak()
  expect(first?.style.font).not.toBe('')
  await view.getByTestId('tweak-menu-shuffle').click()
  await expect.poll(async () => JSON.stringify((await tweak())?.style)).not.toBe(JSON.stringify(first?.style))
  const shuffled = await tweak()
  expect(shuffled?.style.hidden).toEqual(first?.style.hidden)
  expect(shuffled?.css).toBe('p { letter-spacing: 1px }')

  // Reset all edits asks first: Cancel keeps everything.
  await view.getByTestId('tweak-menu-reset').click()
  await expect(view.getByText('Reset all edits?')).toBeVisible()
  await view.getByTestId('tweak-reset-cancel').click()
  await expect(view.getByTestId('tweak-menu')).toHaveCount(0)
  expect((await tweak())?.style).toEqual(shuffled?.style)
  await view.getByTestId('tweak-name').click()
  await view.getByTestId('tweak-menu-reset').click()
  await view.getByTestId('tweak-reset-confirm').click()
  await expect.poll(async () => (await tweak())?.style.hidden.length).toBe(0)
  const cleared = await tweak()
  expect(cleared).toMatchObject({ name: 'Reading', css: '', js: '', enabled: true })
  expect(cleared?.style).toMatchObject({ intensity: 0, invert: false, font: '', size: 100, textCase: 'none' })
  await expect.poll(async () => (await pageTweaks(app, tabId))?.parts).toEqual([])
  await expect(page.locator('#title')).toBeVisible()
  await waitEditor(app, true)
})
