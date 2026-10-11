import { ChevronRight, Paintbrush, Plus } from 'lucide-react'
import { tweakHostOf, tweaksFor } from '../../../shared/tweaks'
import { invoke } from '../api'
import type { SiteControlsSection, SiteSectionProps } from '../overlay/site/registry'
import { useOrbit, useOrbitShallow } from '../store'
import './tweak-site.css'

/**
 * The site's Tweaks in the site controls panel (BO-14, BO-01): a row each, whose name turns it on
 * or off at once and whose › opens it in the editor, and "New Tweak…" for another.
 */
function TweakRows({ tabId, info, close }: SiteSectionProps) {
  const host = info.web ? tweakHostOf(info.url) : null
  const allowed = useOrbit((s) => s.settings.tweaksEnabled)
  const failed = useOrbit((s) => !!s.tabs[tabId]?.error)
  const list = useOrbitShallow((s) => tweaksFor(s.tweaks, host))
  if (!host || failed) return null
  const edit = async (id: string) => {
    await close()
    await invoke('tweaks.edit', { id, tabId })
  }
  const create = async () => {
    await close()
    await invoke('tweaks.create', { tabId })
  }
  return (
    <section className="site-panel__section" aria-label="Tweaks" data-testid="site-tweaks">
      <h3 className="site-panel__title">Tweaks</h3>
      {!allowed ? (
        <p className="site-panel__note" data-testid="site-tweaks-off">
          Tweaks are turned off for every site in Settings.
        </p>
      ) : (
        <ul className="site-panel__rows">
          {list.map((tweak) => (
            <li
              key={tweak.id}
              className={`site-panel__row tweak-site-row${tweak.enabled ? ' is-on' : ''}`}
              data-testid="site-tweak"
              data-tweak={tweak.id}
              data-on={tweak.enabled ? 'true' : 'false'}
            >
              <button
                type="button"
                className="tweak-site-row__toggle"
                role="switch"
                aria-checked={tweak.enabled}
                title={tweak.enabled ? 'Turn this Tweak off' : 'Turn this Tweak on'}
                onClick={() => void invoke('tweaks.setEnabled', { id: tweak.id, enabled: !tweak.enabled })}
              >
                <Paintbrush size={14} className="tweak-site-row__brush" aria-hidden />
                <span className="site-panel__name">
                  <span className="tweak-site-row__name">{tweak.name}</span>
                  <span className="site-panel__state">{tweak.enabled ? 'On' : 'Off'}</span>
                </span>
              </button>
              {tweak.js.trim() && (
                <span className="tweak-site-row__badge" title="This Tweak runs JavaScript" data-testid="site-tweak-js">
                  JS
                </span>
              )}
              <button
                type="button"
                className="site-panel__icon-button"
                data-testid="site-tweak-edit"
                aria-label={`Edit ${tweak.name}`}
                title="Edit"
                onClick={() => void edit(tweak.id)}
              >
                <ChevronRight size={14} />
              </button>
            </li>
          ))}
          <li className="site-panel__row tweak-site-row">
            <button
              type="button"
              className="tweak-site-row__toggle"
              data-testid="site-tweak-new"
              onClick={() => void create()}
            >
              <Plus size={14} className="tweak-site-row__brush" aria-hidden />
              <span className="site-panel__name">New Tweak…</span>
            </button>
          </li>
        </ul>
      )}
    </section>
  )
}

export const section: SiteControlsSection = { id: 'tweaks', order: 45, component: TweakRows }
