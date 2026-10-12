import type { Tweak, TweakStyle } from '../../../shared/state'
import { FONT_PRESETS, TEXT_CASES } from '../../../shared/tweaks'
import { updateTweak } from './edit'

/**
 * Font presets (BO-07): an "Aa" in each preset's own typeface. One applies to all the site's text
 * (not its icons or code); choosing it again gives the site its own fonts back.
 */
export function FontPresets({ tweak }: { tweak: Tweak }) {
  const font = tweak.style.font
  return (
    <div className="tweak-fonts" role="group" aria-label="Font">
      {FONT_PRESETS.map((preset) => {
        const on = font === preset.id
        return (
          <button
            key={preset.id}
            type="button"
            className="tweak-font"
            data-testid={`tweak-font-${preset.id}`}
            aria-pressed={on}
            aria-label={preset.label}
            title={on ? `${preset.label}: choose again for the site’s own fonts` : preset.label}
            style={{ fontFamily: preset.stack }}
            onClick={() => updateTweak(tweak.id, { style: { font: on ? '' : preset.id } })}
          >
            Aa
          </button>
        )
      })}
    </div>
  )
}

const CASE_NAMES: Record<TweakStyle['textCase'], string> = {
  none: 'As written',
  lower: 'lowercase',
  upper: 'UPPERCASE',
  capitalize: 'Capitalized Words',
}

/** Text case (BO-09): each click the next of as written, lowercase, UPPERCASE and Capitalized Words. */
export function CaseControl({ tweak }: { tweak: Tweak }) {
  const now = tweak.style.textCase
  const next = TEXT_CASES[(TEXT_CASES.indexOf(now) + 1) % TEXT_CASES.length] ?? 'none'
  return (
    <button
      type="button"
      className="tweak-chip"
      data-testid="tweak-case"
      data-case={now}
      aria-label={`Text case: ${CASE_NAMES[now]}`}
      title={`Next: ${CASE_NAMES[next]}`}
      onClick={() => updateTweak(tweak.id, { style: { textCase: next } })}
    >
      {CASE_NAMES[now]}
    </button>
  )
}
