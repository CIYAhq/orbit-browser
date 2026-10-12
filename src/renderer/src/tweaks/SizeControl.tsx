import { Minus, Plus } from 'lucide-react'
import type { Tweak } from '../../../shared/state'
import { TWEAK_SIZES } from '../../../shared/tweaks'
import { updateTweak } from './edit'

/**
 * Page size (BO-08): − and + step through 90, 100, 110, 125 and 150%; the value puts it back to
 * 100%. It is the Tweak's own size, on top of the page zoom (NV-06): the two multiply.
 */
export function SizeControl({ tweak }: { tweak: Tweak }) {
  const size = tweak.style.size
  const smaller = [...TWEAK_SIZES].reverse().find((s) => s < size)
  const larger = TWEAK_SIZES.find((s) => s > size)
  const set = (next: number | undefined) => {
    if (next !== undefined) updateTweak(tweak.id, { style: { size: next } })
  }
  return (
    <div className="tweak-stepper" role="group" aria-label="Page size">
      <button
        type="button"
        className="tweak-stepper__button"
        data-testid="tweak-size-down"
        aria-label="Smaller"
        title="Smaller"
        disabled={smaller === undefined}
        onClick={() => set(smaller)}
      >
        <Minus size={14} />
      </button>
      <button
        type="button"
        className="tweak-stepper__value"
        data-testid="tweak-size"
        title={size === 100 ? 'Page size' : 'Back to 100%'}
        aria-label={`Page size ${size}%`}
        onClick={() => set(100)}
      >
        {size}%
      </button>
      <button
        type="button"
        className="tweak-stepper__button"
        data-testid="tweak-size-up"
        aria-label="Larger"
        title="Larger"
        disabled={larger === undefined}
        onClick={() => set(larger)}
      >
        <Plus size={14} />
      </button>
    </div>
  )
}
