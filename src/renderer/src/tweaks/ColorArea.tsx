import { CircleX, Lightbulb, SlidersHorizontal } from 'lucide-react'
import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react'
import type { Tweak } from '../../../shared/state'
import {
  colorReset,
  hasColor,
  SATURATION_MAX,
  SLIDER_MAX,
  SLIDER_MIN,
  wheelColor,
  wrapHue,
} from '../../../shared/tweaks'
import { type StyleEdit, updateTweak, useLiveValue, useStyleEdits } from './edit'

/** The wheel's diameter (px). */
const WHEEL = 116
/** How far the big handle reaches from the centre at full intensity, and where the rim handle rides (px). */
const MAIN_REACH = WHEEL / 2 - 16
const RIM_REACH = WHEEL / 2 - 7
/** A press this close to a handle's centre takes it (px); the big one first, as it lies on top. */
const GRAB_MAIN = 12
const GRAB_RIM = 10

interface Wheel {
  hue: number
  intensity: number
  accent: number
}

const sameWheel = (a: Wheel, b: Wheel) =>
  Math.abs(a.hue - b.hue) < 0.01 && Math.abs(a.intensity - b.intensity) < 0.0005 && Math.abs(a.accent - b.accent) < 0.01
const sameNumber = (a: number, b: number) => a === b

const rad = (deg: number) => (deg * Math.PI) / 180
/** Degrees in [0, 360) to a tenth. */
const tenth = (deg: number) => wrapHue(Math.round(wrapHue(deg) * 10) / 10)
const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** A point at an angle and a distance (px) from the wheel's centre, from its centre. */
const spot = (angle: number, dist: number) => ({
  x: dist * Math.sin(rad(angle)),
  y: -dist * Math.cos(rad(angle)),
})

/**
 * The colour area (BO-03 to BO-06): the wheel, and beside it invert lightness, the advanced sliders
 * and reset colours. Everything applies to the page as it moves, at most once a frame.
 */
export function ColorArea({ tweak }: { tweak: Tweak }) {
  const style = tweak.style
  const send = useStyleEdits(tweak.id)
  const [sliders, setSliders] = useState(
    () => style.contrast !== 100 || style.brightness !== 100 || style.saturation !== 100,
  )
  return (
    <div className="tweak-color" data-testid="tweak-color">
      <div className="tweak-color__main">
        <ColorWheel tweak={tweak} send={send} />
        <div className="tweak-color__tools">
          <button
            type="button"
            className="tweak-color__tool"
            data-testid="tweak-invert"
            aria-pressed={style.invert}
            title="Invert lightness: a light page goes dark, a dark one light; photos stay as they are"
            onClick={() => updateTweak(tweak.id, { style: { invert: !style.invert } })}
          >
            <Lightbulb size={14} aria-hidden />
            <span>Invert</span>
          </button>
          <button
            type="button"
            className="tweak-color__tool"
            data-testid="tweak-sliders"
            aria-pressed={sliders}
            aria-expanded={sliders}
            title="Contrast, brightness and the page’s own saturation"
            onClick={() => setSliders(!sliders)}
          >
            <SlidersHorizontal size={14} aria-hidden />
            <span>Adjust</span>
          </button>
          <button
            type="button"
            className="tweak-color__tool"
            data-testid="tweak-color-reset"
            disabled={!hasColor(style)}
            title="The site’s own colours again (fonts, size and the rest stay)"
            onClick={() => updateTweak(tweak.id, { style: colorReset() })}
          >
            <CircleX size={14} aria-hidden />
            <span>Reset</span>
          </button>
        </div>
      </div>
      {sliders && (
        <div className="tweak-sliders" data-testid="tweak-slider-group">
          <datalist id="tweak-neutral">
            <option value="100" />
          </datalist>
          <Slider tweak={tweak} send={send} name="contrast" label="Contrast" min={SLIDER_MIN} max={SLIDER_MAX} />
          <Slider tweak={tweak} send={send} name="brightness" label="Brightness" min={SLIDER_MIN} max={SLIDER_MAX} />
          <Slider
            tweak={tweak}
            send={send}
            name="saturation"
            label="Original saturation"
            min={0}
            max={SATURATION_MAX}
          />
        </div>
      )}
    </div>
  )
}

/**
 * The colour wheel (BO-03): the big handle goes anywhere inside, its angle the tint's hue and its
 * distance from the centre how strong it is; the small one rides the rim, the accent hue, and turns
 * with the big one. A press on a handle takes it; anywhere else it moves the big handle there.
 * Arrow keys move the handle that has the keyboard; with ⇧, further.
 */
function ColorWheel({ tweak, send }: { tweak: Tweak; send: (style: StyleEdit) => void }) {
  const { hue, intensity, accent } = tweak.style
  const [value, setValue] = useLiveValue<Wheel>({ hue, intensity, accent }, sameWheel)
  const latest = useRef(value)
  latest.current = value
  const grabbed = useRef<'main' | 'accent' | null>(null)
  const mainHandle = useRef<HTMLDivElement>(null)
  const rimHandle = useRef<HTMLDivElement>(null)

  const set = (next: Wheel) => {
    latest.current = next
    setValue(next)
    send(next)
  }
  /** The big handle to a hue and intensity; the accent keeps its distance from the hue. */
  const setMain = (nextHue: number, nextIntensity: number) => {
    const v = latest.current
    const h = tenth(nextHue)
    set({ hue: h, intensity: Math.round(clamp01(nextIntensity) * 1000) / 1000, accent: tenth(v.accent + h - v.hue) })
  }

  const follow = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const dx = e.clientX - (r.left + r.width / 2)
    const dy = e.clientY - (r.top + r.height / 2)
    const angle = (Math.atan2(dx, -dy) * 180) / Math.PI
    if (grabbed.current === 'accent') {
      set({ ...latest.current, accent: tenth(angle) })
      return
    }
    const dist = Math.min(1, Math.hypot(dx, dy) / MAIN_REACH)
    // At the very centre the hue has no direction: it stays as it was.
    setMain(dist < 0.02 ? latest.current.hue : angle, dist)
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const r = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - (r.left + r.width / 2)
    const y = e.clientY - (r.top + r.height / 2)
    const main = spot(latest.current.hue, latest.current.intensity * MAIN_REACH)
    const rim = spot(latest.current.accent, RIM_REACH)
    const nearRim = Math.hypot(x - main.x, y - main.y) > GRAB_MAIN && Math.hypot(x - rim.x, y - rim.y) <= GRAB_RIM
    grabbed.current = nearRim ? 'accent' : 'main'
    ;(nearRim ? rimHandle : mainHandle).current?.focus({ preventScroll: true })
    e.currentTarget.setPointerCapture(e.pointerId)
    follow(e)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (grabbed.current) follow(e)
  }
  const release = () => {
    grabbed.current = null
  }

  const onMainKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const v = latest.current
    const turn = e.shiftKey ? 15 : 5
    const push = e.shiftKey ? 0.2 : 0.05
    const moves: Record<string, () => void> = {
      ArrowLeft: () => setMain(v.hue - turn, v.intensity),
      ArrowRight: () => setMain(v.hue + turn, v.intensity),
      ArrowUp: () => setMain(v.hue, v.intensity + push),
      ArrowDown: () => setMain(v.hue, v.intensity - push),
      Home: () => setMain(v.hue, 0),
      End: () => setMain(v.hue, 1),
    }
    const move = moves[e.key]
    if (!move) return
    e.preventDefault()
    move()
  }
  const onRimKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key]
    if (!step) return
    e.preventDefault()
    const v = latest.current
    set({ ...v, accent: tenth(v.accent + step * (e.shiftKey ? 15 : 5)) })
  }

  const main = spot(value.hue, value.intensity * MAIN_REACH)
  const rim = spot(value.accent, RIM_REACH)
  const strength = Math.round(value.intensity * 100)
  return (
    <div
      className="tweak-wheel"
      data-testid="tweak-wheel"
      style={{ width: WHEEL, height: WHEEL }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
    >
      <div
        ref={mainHandle}
        className="tweak-wheel__handle"
        data-testid="tweak-wheel-main"
        role="slider"
        tabIndex={0}
        aria-label="Tint"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={strength}
        aria-valuetext={strength ? `Hue ${Math.round(value.hue)}°, strength ${strength}%` : 'No tint'}
        style={{
          left: WHEEL / 2 + main.x,
          top: WHEEL / 2 + main.y,
          background: wheelColor(value.hue, value.intensity),
        }}
        onKeyDown={onMainKey}
      />
      <div
        ref={rimHandle}
        className="tweak-wheel__rim"
        data-testid="tweak-wheel-accent"
        role="slider"
        tabIndex={0}
        aria-label="Accent hue"
        aria-valuemin={0}
        aria-valuemax={359}
        aria-valuenow={Math.round(value.accent)}
        aria-valuetext={`Hue ${Math.round(value.accent)}°`}
        style={{ left: WHEEL / 2 + rim.x, top: WHEEL / 2 + rim.y, background: `hsl(${value.accent} 80% 55%)` }}
        onKeyDown={onRimKey}
      />
    </div>
  )
}

type SliderName = 'contrast' | 'brightness' | 'saturation'

/** One advanced colour slider (BO-05), in percent; 100, the middle, changes nothing. A double-click puts it back. */
function Slider({
  tweak,
  send,
  name,
  label,
  min,
  max,
}: {
  tweak: Tweak
  send: (style: StyleEdit) => void
  name: SliderName
  label: string
  min: number
  max: number
}) {
  const [value, setValue] = useLiveValue(tweak.style[name], sameNumber)
  const change = (next: number) => {
    setValue(next)
    send({ [name]: next })
  }
  return (
    <label className="tweak-slider">
      <span className="tweak-slider__label">{label}</span>
      <input
        type="range"
        data-testid={`tweak-${name}`}
        min={min}
        max={max}
        step={1}
        list="tweak-neutral"
        value={value}
        onChange={(e) => change(Number(e.currentTarget.value))}
        onDoubleClick={() => change(100)}
      />
      <span className="tweak-slider__value">{value}%</span>
    </label>
  )
}
