/**
 * The shared frame sampler for feel tests (feel.md FL-*). It records, in every animation frame of a
 * page, the box and opacity of chosen elements, and the frame times; the helpers below turn a
 * recording into the observables the spec names (when something first showed, how long it moved,
 * whether it jumped, frame pacing).
 *
 * How times compare:
 * - `t` is the frame's `requestAnimationFrame` time, in ms since the recording started. The frame is
 *   read after every animation-frame callback and layout, just before paint, so what it holds is
 *   what the frame paints: "first frame that shows X" is the first frame whose sample shows it.
 * - `wall` is the same instant on the wall clock (`performance.timeOrigin` + the frame time), which
 *   every process shares: compare it with `mainInputs()` (when main saw a key) or `Date.now()`.
 *
 * Sampling forces a style and layout pass each frame, as any rAF sampler does; keep targets few.
 */
import { appendFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import type { ElectronApplication, Page } from '@playwright/test'

/** An element to sample: a selector (the first match), or every match keyed by an attribute. */
export type Target =
  | string
  | {
      selector: string
      /**
       * Sample every match, keyed by this attribute (e.g. `data-key`) into `Frame.lists`. The match's
       * closest element with the attribute gives the key, so a row's title can be keyed by its row.
       */
      key?: string
      /** Computed style properties to keep, e.g. `['transform', 'background-color']`. */
      style?: string[]
      /** Keep the element's class attribute. */
      classes?: boolean
      /** Selectors to test the element against each frame, e.g. `[':hover', '.is-active']`. */
      matches?: string[]
      /** Keep the element's text: an input's value, otherwise its text content. */
      text?: boolean
      /** Attributes to keep, e.g. `['aria-selected', 'data-kind']`. */
      attrs?: string[]
    }

export interface Box {
  x: number
  y: number
  width: number
  height: number
  /** The element's opacity times its ancestors' (what shows), 0 when `visibility` hides it. */
  opacity: number
  classes?: string
  style?: Record<string, string>
  /** The `matches` selectors the element matched in this frame. */
  matched?: string[]
  text?: string
  attrs?: Record<string, string | null>
}

export interface Frame {
  /** This frame's place in the recording (0 = the first). */
  i: number
  /** ms since the recording started (this frame's rAF time). */
  t: number
  /** When the frame was read (ms since the start): after any input handled before this frame. */
  run: number
  /** The same instant on the wall clock (ms). */
  wall: number
  /** Time since the previous frame (ms); 0 for the first frame. */
  dt: number
  /** Single targets: null when the element isn't there (or isn't laid out). */
  els: Record<string, Box | null>
  /** Targets sampled with `key`: every match, by key. */
  lists: Record<string, Record<string, Box>>
}

/** An input event the page received, on the recording's clock. */
export interface PageInput {
  type: string
  key?: string
  /** Pointer position (CSS px) for pointer and wheel events. */
  x?: number
  y?: number
  /** A wheel event's deltas. */
  dx?: number
  dy?: number
  /** The event's time stamp, ms since the recording started. */
  t: number
  wall: number
  /** The first frame drawn after the page handled this input (its index in `frames`). */
  frame: number
}

export interface Recording {
  frames: Frame[]
  inputs: PageInput[]
  /** Wall-clock time the recording started. */
  wall0: number
}

export interface Recorder {
  /** Stops now and returns what was recorded. */
  stop(): Promise<Recording>
  /** Waits until `ms` after the start (in the page's time), then stops. */
  until(ms: number): Promise<Recording>
}

interface PageRecorder {
  frames: Frame[]
  inputs: PageInput[]
  wall0: number
  stop: () => void
  done: Promise<void>
}

/**
 * Starts recording `targets` in `page`, every frame, until `stop()`/`until()` or `maxMs` (default
 * 5 s). Starts at the next frame; await it before giving the input you want to time. A page whose
 * view is hidden draws no frames: with `hidden`, recording starts without waiting for one.
 */
export async function record(
  page: Page,
  targets: Record<string, Target>,
  opts: { maxMs?: number; hidden?: boolean } = {},
): Promise<Recorder> {
  await page.evaluate(
    ({ targets, maxMs, hidden }) => {
      type Spec = {
        selector: string
        key?: string
        style?: string[]
        classes?: boolean
        matches?: string[]
        text?: boolean
        attrs?: string[]
      }
      type W = { __feelRec?: PageRecorder }
      const w = window as unknown as W
      w.__feelRec?.stop()
      const specs = Object.entries(targets).map(
        ([name, t]) => [name, typeof t === 'string' ? { selector: t } : t] as [string, Spec],
      )
      // An element's opacity times its ancestors', memoized for the frame (rows share ancestors).
      let memo = new Map<Element, number>()
      const opacityOf = (el: Element): number => {
        const hit = memo.get(el)
        if (hit !== undefined) return hit
        const own = Number(getComputedStyle(el).opacity)
        const o = own === 0 ? 0 : own * (el.parentElement ? opacityOf(el.parentElement) : 1)
        memo.set(el, o)
        return o
      }
      const box = (el: Element, spec: Spec): Box | null => {
        if (el.getClientRects().length === 0) return null
        const r = el.getBoundingClientRect()
        const shown = getComputedStyle(el).visibility !== 'hidden'
        const out: Box = { x: r.x, y: r.y, width: r.width, height: r.height, opacity: shown ? opacityOf(el) : 0 }
        if (spec.classes) out.classes = el.getAttribute('class') ?? ''
        if (spec.matches) out.matched = spec.matches.filter((m) => el.matches(m))
        if (spec.text) out.text = el instanceof HTMLInputElement ? el.value : (el.textContent ?? '')
        if (spec.attrs) out.attrs = Object.fromEntries(spec.attrs.map((a) => [a, el.getAttribute(a)]))
        if (spec.style) {
          const cs = getComputedStyle(el)
          out.style = Object.fromEntries(spec.style.map((p) => [p, cs.getPropertyValue(p)]))
        }
        return out
      }
      const t0 = performance.now()
      const rec: PageRecorder = {
        frames: [],
        inputs: [],
        wall0: performance.timeOrigin + t0,
        stop: () => {},
        done: Promise.resolve(),
      }
      let raf = 0
      let last = -1
      let finish: () => void = () => {}
      rec.done = new Promise<void>((resolve) => {
        finish = resolve
      })
      const onInput = (e: Event) => {
        const p = e as PointerEvent
        const wheel = e as WheelEvent
        rec.inputs.push({
          type: e.type,
          key: (e as KeyboardEvent).key,
          x: p.clientX,
          y: p.clientY,
          dx: e.type === 'wheel' ? wheel.deltaX : undefined,
          dy: e.type === 'wheel' ? wheel.deltaY : undefined,
          t: e.timeStamp - t0,
          wall: performance.timeOrigin + e.timeStamp,
          frame: rec.frames.length,
        })
      }
      const kinds = ['keydown', 'keyup', 'pointerdown', 'pointerup', 'pointermove', 'wheel'] as const
      for (const k of kinds) window.addEventListener(k, onInput, { capture: true, passive: true })
      // The frame is read after every animation-frame callback has run, not in our own: a callback
      // that runs after ours (an animation library's frame loop, a store applying patches once per
      // frame) would otherwise show one frame late. A probe whose size changes each frame gets a
      // ResizeObserver callback after layout and before paint, which is when the frame is final.
      const probe = document.createElement('div')
      probe.style.cssText =
        'position:fixed;left:-8px;top:-8px;width:1px;height:1px;visibility:hidden;pointer-events:none;contain:strict'
      document.documentElement.appendChild(probe)
      let pending: { now: number; dt: number } | null = null
      const sample = ({ now, dt }: { now: number; dt: number }) => {
        const frame: Frame = {
          i: rec.frames.length,
          t: now - t0,
          run: performance.now() - t0,
          wall: performance.timeOrigin + now,
          dt,
          els: {},
          lists: {},
        }
        memo = new Map()
        for (const [name, spec] of specs) {
          if (spec.key) {
            const all: Record<string, Box> = {}
            for (const el of document.querySelectorAll(spec.selector)) {
              const b = box(el, spec)
              const k = el.closest(`[${spec.key}]`)?.getAttribute(spec.key)
              if (b && k != null) all[k] = b
            }
            frame.lists[name] = all
          } else {
            const el = document.querySelector(spec.selector)
            frame.els[name] = el ? box(el, spec) : null
          }
        }
        rec.frames.push(frame)
      }
      let ending = false
      const observer = new ResizeObserver(() => {
        if (!pending) return
        sample(pending)
        pending = null
        if (ending) rec.stop()
      })
      observer.observe(probe)
      let flip = false
      const tick = (now: number) => {
        // No observer callback last frame (nothing laid out): read that frame now rather than lose it.
        if (pending) sample(pending)
        pending = { now, dt: last < 0 ? 0 : now - last }
        last = now
        flip = !flip
        probe.style.width = flip ? '2px' : '1px'
        if (now - t0 >= maxMs) ending = true
        else raf = requestAnimationFrame(tick)
      }
      rec.stop = () => {
        cancelAnimationFrame(raf)
        for (const k of kinds) window.removeEventListener(k, onInput, { capture: true })
        // Stopped between a frame's callback and its observer callback (or it never came): read it now.
        if (pending) sample(pending)
        pending = null
        observer.disconnect()
        probe.remove()
        finish()
      }
      w.__feelRec = rec
      // Resolves once the first frame is recorded: input given after this lands in the recording.
      return new Promise<void>((resolve) => {
        raf = requestAnimationFrame((now) => {
          tick(now)
          resolve()
        })
        if (hidden) resolve()
      })
    },
    { targets, maxMs: opts.maxMs ?? 5000, hidden: !!opts.hidden },
  )
  const take = () =>
    page.evaluate(() => {
      const rec = (window as unknown as { __feelRec?: PageRecorder }).__feelRec
      if (!rec) throw new Error('no recording in this page')
      rec.stop()
      ;(window as unknown as { __feelRec?: PageRecorder }).__feelRec = undefined
      return { frames: rec.frames, inputs: rec.inputs, wall0: rec.wall0 }
    })
  return {
    stop: take,
    until: async (ms: number) => {
      await page.evaluate(async (ms) => {
        const rec = (window as unknown as { __feelRec?: PageRecorder }).__feelRec
        if (!rec) return
        const t0 = rec.wall0 - performance.timeOrigin
        const left = t0 + ms - performance.now()
        await Promise.race([rec.done, new Promise((r) => setTimeout(r, Math.max(0, left)))])
      }, ms)
      return take()
    },
  }
}

// ---- Reading a recording ----

/** Frame-time statistics, the first frame (which has no interval) left out. */
export function pacing(rec: Recording | Frame[]): { frames: number; p50: number; p99: number; max: number } {
  const frames = Array.isArray(rec) ? rec : rec.frames
  const dts = frames
    .slice(1)
    .map((f) => f.dt)
    .sort((a, b) => a - b)
  const at = (q: number) => dts[Math.min(dts.length - 1, Math.max(0, Math.ceil(q * dts.length) - 1))] ?? 0
  return { frames: dts.length, p50: at(0.5), p99: at(0.99), max: dts.at(-1) ?? 0 }
}

/** The first frame (at or after `from` ms) that satisfies `test`. */
export function firstFrame(rec: Recording, test: (f: Frame) => boolean, from = 0): Frame | undefined {
  return rec.frames.find((f) => f.t >= from && test(f))
}

/** The last frame (index) at which `test` fails, +1: from there on `test` holds in every frame. */
export function settledFrom(rec: Recording, test: (f: Frame) => boolean): Frame | undefined {
  let i = rec.frames.length
  while (i > 0 && test(rec.frames[i - 1] as Frame)) i--
  return i < rec.frames.length ? rec.frames[i] : undefined
}

/**
 * One number per frame for a target, e.g. `series(rec, 'row', (b) => b.height)`, or for one key of a
 * keyed target; NaN where it's absent.
 */
export function series(
  rec: Recording,
  name: string,
  value: (b: Box) => number,
  key?: string,
): { t: number; v: number }[] {
  return rec.frames.map((f) => {
    const b = key === undefined ? f.els[name] : f.lists[name]?.[key]
    return { t: f.t, v: b ? value(b) : Number.NaN }
  })
}

/**
 * The biggest per-frame step of a moving value, as a speed (units per ms), over the frames where
 * it moves. FL-01: nothing jumps by more than its per-frame velocity; a value that snaps from start
 * to end shows here as one step the size of the whole travel in one frame.
 */
export function steps(points: { t: number; v: number }[]): { dv: number; dt: number; speed: number; t: number }[] {
  const out: { dv: number; dt: number; speed: number; t: number }[] = []
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as { t: number; v: number }
    const b = points[i] as { t: number; v: number }
    if (Number.isNaN(a.v) || Number.isNaN(b.v)) continue
    const dv = b.v - a.v
    const dt = b.t - a.t
    if (dv !== 0) out.push({ dv, dt, speed: Math.abs(dv) / Math.max(dt, 1), t: b.t })
  }
  return out
}

/**
 * When a value starts and stops changing (ms since the recording started), how far it went, and its
 * largest single-frame step as a share of that travel. `eps` ignores sub-pixel noise.
 */
export function motionOf(points: { t: number; v: number }[], eps = 0.5) {
  const real = points.filter((p) => !Number.isNaN(p.v))
  const first = real[0]
  const last = real.at(-1)
  if (!first || !last) return { start: undefined, end: undefined, travel: 0, biggestStep: 0, moving: 0 }
  const moves = steps(real).filter((s) => Math.abs(s.dv) > eps)
  const travel = Math.abs(last.v - first.v)
  return {
    /** Time of the first frame that differs from the starting value. */
    start: moves[0]?.t,
    /** Time of the last frame that differs from the one before. */
    end: moves.at(-1)?.t,
    travel,
    /** Largest single-frame step, as a share of the whole travel (1 = everything in one frame). */
    biggestStep: travel > 0 ? Math.max(0, ...moves.map((s) => Math.abs(s.dv))) / travel : 0,
    /** Frames in which it moved. */
    moving: moves.length,
  }
}

/** How soon a frame showed the response to an input: the first frame at or after it that passes `test`. */
export function responseTo(
  rec: Recording,
  input: { frame: number; t: number },
  test: (f: Frame) => boolean,
): { frame: Frame; frames: number; ms: number } | undefined {
  const frame = rec.frames.find((f) => f.i >= input.frame && test(f))
  if (!frame) return undefined
  /** 1 = the first frame drawn after the input. */
  const frames = frame.i - input.frame + 1
  return { frame, frames, ms: Math.max(0, frame.t - input.t) }
}

/** The first frame whose callback ran after a wall-clock instant (e.g. a key main saw). */
export function frameAfterWall(rec: Recording, wall: number): number {
  const at = rec.frames.findIndex((f) => rec.wall0 + f.run > wall)
  return at < 0 ? rec.frames.length : at
}

/** `rgb()`/`rgba()` as numbers; transparent for anything else. */
export function rgba(color: string | undefined): [number, number, number, number] {
  const m = /rgba?\(([^)]+)\)/.exec(color ?? '')
  if (!m) return [0, 0, 0, 0]
  const [r = 0, g = 0, b = 0, a = 1] = (m[1] as string)
    .split(/[,\s/]+/)
    .filter(Boolean)
    .map(Number)
  return [r, g, b, a]
}

/**
 * FL-01's jump check: the fastest single-frame step of a motion against its average speed. A curve
 * that starts fast peaks at a few times its average (cubic-bezier(0.2, 0.9, 0.1, 1) at about 4.5×);
 * a value that snaps across most of its travel in one frame is far above that.
 */
export function jumpRatio(points: { t: number; v: number }[], eps = 0.5): number {
  const m = motionOf(points, eps)
  const moves = steps(points.filter((p) => !Number.isNaN(p.v))).filter((s) => Math.abs(s.dv) > eps)
  if (m.start === undefined || m.end === undefined || moves.length === 0) return 0
  // The path's length, so a motion that turns back still counts all its travel.
  const path = moves.reduce((sum, s) => sum + Math.abs(s.dv), 0)
  // The motion's span reaches back one frame before its first step: that step happened during it.
  const span = Math.max(m.end - m.start + (moves[0]?.dt ?? 0), 1)
  const average = path / span
  return Math.max(...moves.map((s) => s.speed)) / average
}

/**
 * FL-01's interruption check: how far a value moved in the frames just after an interruption
 * (recording time `at`) against how fast it moved just before. An animation that carries on from
 * where it was steps about as far as it was stepping; one that jumps (to its end state, or back to
 * its start) steps far more.
 */
export function interruption(points: { t: number; v: number }[], at: number): { before: number; after: number } {
  const valid = points.filter((p) => !Number.isNaN(p.v))
  const k = valid.findIndex((p) => p.t >= at)
  if (k < 2) return { before: Number.NaN, after: Number.NaN }
  const step = (j: number) => Math.abs((valid[j]?.v ?? Number.NaN) - (valid[j - 1]?.v ?? Number.NaN))
  const before = Math.max(step(k - 1), step(k - 2) || 0)
  const after = Math.max(step(k), valid[k + 1] ? step(k + 1) : 0)
  return { before, after }
}

/**
 * D46: measures up to `rounds` rounds and stops at the first that meets every budget. Returns it,
 * or the last round when none did; `all` keeps every round for the log.
 */
export async function bestOf<T>(
  measure: (round: number) => Promise<T>,
  meets: (r: T) => boolean,
  rounds = 3,
): Promise<{ best: T; all: T[] }> {
  const all: T[] = []
  for (let round = 1; round <= rounds; round++) {
    const r = await measure(round)
    all.push(r)
    if (meets(r)) return { best: r, all }
  }
  return { best: all.at(-1) as T, all }
}

/**
 * Logs a measured number beside its target, with the load average: the numbers in docs/FEEL.md come
 * from these lines. With `FEEL_LOG` set, also appends them to that file as JSON lines.
 */
export function note(id: string, what: string, value: number | undefined, target: string, unit = 'ms'): void {
  const load = Math.round((loadavg()[0] ?? 0) * 10) / 10
  // Ratios (no unit) keep three decimals, so a scale of 0.97 reads as such.
  const places = unit ? 10 : 1000
  const shown =
    value === undefined || Number.isNaN(value) ? '–' : `${Math.round(value * places) / places}${unit ? ` ${unit}` : ''}`
  console.log(`[feel] ${id} ${what}: ${shown} (target ${target}; load ${load})`)
  const file = process.env.FEEL_LOG
  if (file) {
    appendFileSync(file, `${JSON.stringify({ id, what, value, unit, target, load, at: new Date().toISOString() })}\n`)
  }
}

// ---- Main-process input times ----

/**
 * Records, in main, when every web contents receives a key or mouse press (before Orbit's own
 * `before-input-event` handlers see it), on the wall clock. Use for shortcuts main handles, which
 * the page never receives. Returns a reader that takes what was recorded so far.
 */
export async function mainInputs(
  app: ElectronApplication,
): Promise<() => Promise<{ type: string; key: string; wall: number }[]>> {
  await app.evaluate(({ app: electronApp, webContents }) => {
    type G = { __feelInputs?: { type: string; key: string; wall: number }[]; __feelInputsOn?: boolean }
    const g = globalThis as unknown as G
    g.__feelInputs = []
    if (g.__feelInputsOn) return
    g.__feelInputsOn = true
    const watch = (wc: Electron.WebContents) =>
      wc.prependListener('before-input-event', (_e, input) => {
        g.__feelInputs?.push({ type: input.type, key: input.key, wall: performance.timeOrigin + performance.now() })
      })
    for (const wc of webContents.getAllWebContents()) watch(wc)
    electronApp.on('web-contents-created', (_e, wc) => watch(wc))
  })
  return () =>
    app.evaluate(() => {
      const g = globalThis as unknown as { __feelInputs?: { type: string; key: string; wall: number }[] }
      return (g.__feelInputs ?? []).splice(0)
    })
}

/**
 * Records, in main, when a tab's view goes from hidden to shown (on the wall clock): Orbit shows a
 * tab's page by showing its view, so the next frame of the window draws it. Returns a reader.
 */
export async function viewShown(app: ElectronApplication, tabId: string): Promise<() => Promise<number[]>> {
  await app.evaluate((_e, id) => {
    type View = { setVisible: (on: boolean) => void; getVisible: () => boolean; __feelShown?: number[] }
    const hooks = (globalThis as unknown as { __orbit: { ctx: { tabs: { get: (id: string) => View | undefined } } } })
      .__orbit
    const view = hooks.ctx.tabs.get(id)
    if (!view) throw new Error(`no view for ${id}`)
    if (view.__feelShown) {
      view.__feelShown.length = 0
      return
    }
    const shown: number[] = []
    view.__feelShown = shown
    const setVisible = view.setVisible.bind(view)
    view.setVisible = (on: boolean) => {
      const was = view.getVisible()
      setVisible(on)
      if (on && !was) shown.push(performance.timeOrigin + performance.now())
    }
  }, tabId)
  return () =>
    app.evaluate((_e, id) => {
      type View = { __feelShown?: number[] }
      const hooks = (globalThis as unknown as { __orbit: { ctx: { tabs: { get: (id: string) => View | undefined } } } })
        .__orbit
      return [...(hooks.ctx.tabs.get(id)?.__feelShown ?? [])]
    }, tabId)
}

/** Rounds for logs. */
export const ms = (n: number | undefined) =>
  n === undefined || Number.isNaN(n) ? '–' : `${Math.round(n * 10) / 10} ms`
