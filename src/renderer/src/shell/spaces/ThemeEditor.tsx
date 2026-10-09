import { Minus, Plus, RotateCcw } from 'lucide-react'
import { type PointerEvent as ReactPointerEvent, useRef, useState } from 'react'
import { THEME_PRESETS } from '../../../../shared/defaults'
import type { SpaceTheme } from '../../../../shared/state'
import { fieldColor, fieldPosition, hexToHsl, paletteFor, sameTheme } from '../../../../shared/theme'

const MAX_COLORS = 3

/** CSS gradient for a theme swatch (top to bottom, like the sidebar). */
export function swatchBackground(theme: SpaceTheme, dark = false): string {
  const p = paletteFor(theme, dark)
  return `linear-gradient(180deg, ${p.frameTop}, ${p.frameMid}, ${p.frameBottom})`
}

function presetBackground(theme: SpaceTheme): string {
  const c = theme.colors
  if (c.length === 0) return 'var(--hover)'
  if (c.length === 1) return c[0] as string
  return `linear-gradient(135deg, ${c.join(', ')})`
}

/**
 * Theme controls shared by the theme picker panel and the new-Space flow
 * (SP-14, SP-15, SP-17): a colour area with up to three draggable handles,
 * ready-made presets, intensity and grain, and reset to the neutral theme.
 * Every change is reported at once (drag rate); the caller applies it live.
 */
export function ThemeEditor({
  theme,
  onChange,
  compact = false,
}: {
  theme: SpaceTheme
  onChange: (theme: SpaceTheme) => void
  compact?: boolean
}) {
  const [selected, setSelected] = useState(0)
  const fieldRef = useRef<HTMLDivElement>(null)
  const dragging = useRef<number | null>(null)
  const colors = theme.colors
  const sel = Math.min(selected, Math.max(0, colors.length - 1))

  const setColor = (index: number, hex: string) => {
    const next = [...colors]
    next[index] = hex
    onChange({ ...theme, colors: next })
  }

  const pointAt = (e: { clientX: number; clientY: number }) => {
    const r = fieldRef.current?.getBoundingClientRect()
    if (!r || r.width === 0 || r.height === 0) return undefined
    return fieldColor((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height)
  }

  const onFieldDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const hex = pointAt(e)
    if (!hex) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-handle]')
    const index = target ? Number(target.dataset.handle) : colors.length === 0 ? 0 : sel
    dragging.current = index
    setSelected(index)
    if (!target) setColor(index, hex)
  }
  const onFieldMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging.current === null) return
    const hex = pointAt(e)
    if (hex) setColor(dragging.current, hex)
  }
  const onFieldUp = () => {
    dragging.current = null
  }

  const addColor = () => {
    if (colors.length >= MAX_COLORS) return
    const last = colors[colors.length - 1]
    const hex = last
      ? (() => {
          const { u, v } = fieldPosition(last)
          return fieldColor((u + 0.17) % 1, Math.min(0.6, v))
        })()
      : fieldColor(0.64, 0.25)
    onChange({ ...theme, colors: [...colors, hex] })
    setSelected(colors.length)
  }
  const removeColor = () => {
    if (colors.length === 0) return
    onChange({ ...theme, colors: colors.filter((_, i) => i !== sel) })
    setSelected(Math.max(0, sel - 1))
  }

  return (
    <div className={`theme-editor${compact ? ' is-compact' : ''}`} data-testid="theme-editor">
      <div
        className="theme-editor__field"
        ref={fieldRef}
        data-testid="theme-field"
        onPointerDown={onFieldDown}
        onPointerMove={onFieldMove}
        onPointerUp={onFieldUp}
        onPointerCancel={onFieldUp}
      >
        {colors.map((hex, i) => {
          const { u, v } = fieldPosition(hex)
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: handles are positional
              key={i}
              data-handle={i}
              data-testid="theme-handle"
              className={`theme-editor__handle${i === sel ? ' is-selected' : ''}`}
              style={{ left: `${u * 100}%`, top: `${v * 100}%`, background: hex }}
              title={`Colour ${i + 1}: ${hex}`}
            />
          )
        })}
        {colors.length === 0 && <span className="theme-editor__field-hint">Click to add a colour</span>}
      </div>
      <div className="theme-editor__row">
        <button
          type="button"
          className="theme-editor__tool"
          aria-label="Add a colour"
          title="Add a colour (up to three)"
          data-testid="theme-add-color"
          disabled={colors.length >= MAX_COLORS}
          onClick={addColor}
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          className="theme-editor__tool"
          aria-label="Remove the selected colour"
          title="Remove the selected colour"
          data-testid="theme-remove-color"
          disabled={colors.length === 0}
          onClick={removeColor}
        >
          <Minus size={14} />
        </button>
        <div className="theme-editor__stops">
          {colors.map((hex, i) => (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: stops are positional
              key={i}
              type="button"
              className={`theme-editor__stop${i === sel ? ' is-selected' : ''}`}
              style={{ background: hex }}
              aria-label={`Select colour ${i + 1} (hue ${Math.round(hexToHsl(hex).h)}°)`}
              onClick={() => setSelected(i)}
            />
          ))}
        </div>
        <button
          type="button"
          className="theme-editor__tool"
          aria-label="Use the neutral theme"
          title="Remove all colours (neutral theme)"
          data-testid="theme-reset"
          disabled={colors.length === 0}
          onClick={() => onChange({ ...theme, colors: [] })}
        >
          <RotateCcw size={13} />
        </button>
      </div>
      <div className="theme-editor__presets" aria-label="Presets">
        {THEME_PRESETS.map((preset) => (
          <button
            key={preset.colors.join('-')}
            type="button"
            className={`theme-editor__preset${sameTheme({ ...preset, intensity: theme.intensity, grain: theme.grain }, theme) ? ' is-selected' : ''}`}
            style={{ background: presetBackground(preset) }}
            aria-label={`Preset ${preset.colors.join(' to ')}`}
            data-testid="theme-preset"
            onClick={() => onChange({ ...theme, colors: [...preset.colors] })}
          />
        ))}
      </div>
      <label className="theme-editor__slider">
        <span>Intensity</span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(theme.intensity * 100)}
          data-testid="theme-intensity"
          onChange={(e) => onChange({ ...theme, intensity: Number(e.target.value) / 100 })}
        />
      </label>
      <label className="theme-editor__slider">
        <span>Grain</span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(theme.grain * 100)}
          data-testid="theme-grain"
          onChange={(e) => onChange({ ...theme, grain: Number(e.target.value) / 100 })}
        />
      </label>
    </div>
  )
}

/** Light and dark renditions of a theme side by side (SP-02 step 3, SP-15). */
export function ThemeRenditions({ theme }: { theme: SpaceTheme }) {
  return (
    <div className="theme-renditions" data-testid="theme-renditions">
      {[false, true].map((dark) => (
        <div
          key={dark ? 'dark' : 'light'}
          className="theme-renditions__card"
          style={{ background: swatchBackground(theme, dark), color: dark ? '#f3f3f5' : '#1c1c1f' }}
        >
          <span className="theme-renditions__row" />
          <span className="theme-renditions__row is-active" />
          <span className="theme-renditions__label">{dark ? 'Dark' : 'Light'}</span>
        </div>
      ))}
    </div>
  )
}
