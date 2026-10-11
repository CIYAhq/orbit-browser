import { EyeOff, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { TweakEditorState, TweakHideChoice } from '../../../shared/commands/tweaks'
import type { Tweak } from '../../../shared/state'
import { invoke } from '../api'

const preview = (choice: TweakHideChoice | null) => void invoke('tweaks.hidePreview', { choice })

/** The button that turns Hide-element mode on and off (BO-10); pressed too while the mode is starting (D89). */
export function HideButton({ on }: { on: boolean }) {
  return (
    <button
      type="button"
      className="tweak-color__tool tweak-tools__button"
      data-testid="tweak-hide-button"
      aria-pressed={on}
      title={on ? 'Stop hiding elements' : 'Hide elements: click them on the page'}
      onClick={() => void invoke('tweaks.hideMode', { on: !on })}
    >
      <Zap size={15} aria-hidden />
      Hide elements
    </button>
  )
}

/**
 * Hide-element mode (BO-10). The button above turns it on: the page outlines what is under the pointer,
 * and a click there picks it without the page acting on it. The panel then offers "Hide this" or
 * "Hide all similar", with a slider from narrow to broad and how many that hides (and how many of
 * those show on the page, where fewer do); outlined in the page as it moves. Done hiding, or Esc,
 * leaves the mode. On a page still loading, the mode starts when the load ends: the area says so
 * meanwhile, and Done or Esc cancels it (D89). Each hidden element has a restore marker here:
 * hovered, it shows the element again for a moment; clicked, it brings it back.
 */
export function HideArea({ tweak, state }: { tweak: Tweak; state: TweakEditorState }) {
  const { on, starting, pick } = state.hide
  const [breadth, setBreadth] = useState(0)
  // Each pick starts at its narrowest "similar".
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new pick resets it
  useEffect(() => setBreadth(0), [pick])
  const similar = pick?.similar ?? []
  const level = similar[Math.min(breadth, similar.length - 1)]

  return (
    <>
      {(on || starting) && (
        <div
          className="tweak-hide"
          data-testid="tweak-hide"
          data-state={on ? 'on' : 'starting'}
          role="group"
          aria-label="Hide elements"
        >
          {pick ? (
            <>
              <div className="tweak-hide__what" data-testid="tweak-hide-label" title={pick.label}>
                {pick.label}
              </div>
              <div className="tweak-hide__choices">
                <button
                  type="button"
                  className="tweak-button"
                  data-testid="tweak-hide-this"
                  onPointerEnter={() => preview('this')}
                  onPointerLeave={() => preview(null)}
                  onClick={() => void invoke('tweaks.hide', { choice: 'this' })}
                >
                  Hide this
                </button>
                <button
                  type="button"
                  className="tweak-button"
                  data-testid="tweak-hide-similar"
                  disabled={!level}
                  title={level ? undefined : 'Nothing else on the page is like it'}
                  onPointerEnter={() => level && preview(breadth)}
                  onPointerLeave={() => preview(null)}
                  onClick={() => void invoke('tweaks.hide', { choice: breadth })}
                >
                  Hide all similar
                  <span
                    className="tweak-hide__count"
                    data-testid="tweak-hide-count"
                    title={
                      level && level.shown < level.count
                        ? `Hides ${level.count}, of which ${level.shown} show on the page now, outlined there`
                        : undefined
                    }
                  >
                    {!level ? 0 : level.shown < level.count ? `${level.count} (${level.shown} shown)` : level.count}
                  </span>
                </button>
              </div>
              {similar.length > 1 && (
                <label className="tweak-hide__breadth">
                  <span>Narrow</span>
                  <input
                    type="range"
                    data-testid="tweak-hide-breadth"
                    aria-label="How alike"
                    min={0}
                    max={similar.length - 1}
                    step={1}
                    value={Math.min(breadth, similar.length - 1)}
                    onChange={(e) => {
                      const next = Number(e.currentTarget.value)
                      setBreadth(next)
                      preview(next)
                    }}
                  />
                  <span>Broad</span>
                </label>
              )}
            </>
          ) : on ? (
            <p className="tweak-hide__hint" data-testid="tweak-hide-hint">
              Click what to hide on the page. Its links and buttons don’t act until you’re done.
            </p>
          ) : (
            <p className="tweak-hide__hint" data-testid="tweak-hide-starting">
              Starts when the page has loaded. Until then, the page acts as usual.
            </p>
          )}
          <div className="tweak-hide__bar">
            {pick && (
              <button
                type="button"
                className="tweak-button"
                data-testid="tweak-hide-cancel"
                onClick={() => void invoke('tweaks.hideCancel', {})}
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              className="tweak-button"
              data-testid="tweak-hide-done"
              title="Leave Hide-element mode (Esc)"
              onClick={() => void invoke('tweaks.hideMode', { on: false })}
            >
              Done hiding
            </button>
          </div>
        </div>
      )}
      {tweak.style.hidden.length > 0 && <RestoreMarkers tweak={tweak} />}
    </>
  )
}

/** One marker per hidden element (BO-10): hovered or focused it shows the element again, clicked it restores it. */
function RestoreMarkers({ tweak }: { tweak: Tweak }) {
  const show = (hiddenId: string | null) => void invoke('tweaks.showHidden', { hiddenId })
  return (
    <div className="tweak-restore" data-testid="tweak-restore" role="group" aria-label="Hidden elements">
      {tweak.style.hidden.map((h) => (
        <button
          key={h.id}
          type="button"
          className="tweak-restore__marker"
          data-testid="tweak-restore-marker"
          data-hidden={h.id}
          title={`Show again: ${h.label || h.selector}`}
          onPointerEnter={() => show(h.id)}
          onPointerLeave={() => show(null)}
          onFocus={() => show(h.id)}
          onBlur={() => show(null)}
          onClick={() => {
            show(null)
            void invoke('tweaks.unhide', { id: tweak.id, hiddenId: h.id })
          }}
        >
          <EyeOff size={12} aria-hidden />
          <span>{h.label || 'Element'}</span>
        </button>
      ))}
    </div>
  )
}
