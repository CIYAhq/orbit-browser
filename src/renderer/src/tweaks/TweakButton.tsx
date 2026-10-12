import { Paintbrush } from 'lucide-react'
import { runAction } from '../api'
import { useKeymap } from '../keys/live'
import { withShortcut } from '../shell/chrome/shortcut-label'
import { useTweakSite } from './site'
import './tweak-entry.css'

/**
 * The paintbrush in the address field (BO-01, BO-14). On a site with a Tweak on it shows in the
 * accent colour and turns the site's Tweaks off; on one whose Tweaks are all off it shows grey and
 * turns them on again. On any other website it shows with the field's other buttons (pointer over
 * the field, or focus in it) and makes a new Tweak. None where Tweaks can't go, or are off (BO-16).
 */
export function TweakButton({ windowId }: { windowId: string }) {
  // The tooltip follows remapped shortcuts (KS-18).
  useKeymap()
  const site = useTweakSite(windowId)
  if (!site.allowed || !site.host) return null
  const state = site.total === 0 ? 'none' : site.on > 0 ? 'on' : 'off'
  const [label, actionId] =
    state === 'none'
      ? ['New Tweak…', 'tweak.new']
      : state === 'on'
        ? ['Turn Off Tweaks for This Site', 'tweak.siteOff']
        : ['Turn On Tweaks for This Site', 'tweak.siteOn']
  return (
    <button
      type="button"
      className={`address__button address__tweak is-${state}`}
      data-testid="tweak-button"
      data-state={state}
      aria-label={label}
      aria-pressed={state === 'none' ? undefined : state === 'on'}
      title={withShortcut(label, actionId)}
      onClick={() => runAction(actionId)}
    >
      <Paintbrush size={13} />
    </button>
  )
}
