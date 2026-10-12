import { ShieldBan } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AdBlockSite } from '../../../shared/ad-block'
import { invoke } from '../api'
import type { SiteControlsSection, SiteSectionProps } from '../overlay/site/registry'
import { useOrbit } from '../store'

/** The row's line under its name: on or off, and why, with what this page had stopped. */
function stateOf(everywhere: boolean, site: AdBlockSite): string {
  if (!everywhere) return 'Off for every site in Settings'
  if (site.allowed) return 'Off for this site'
  if (site.blocked === 0) return 'On · nothing blocked on this page'
  return `On · ${site.blocked} blocked on this page`
}

/**
 * Ad and tracker blocking on this site (OB-06): on, unless the user turned it off here or for every
 * site in Settings → Privacy, with how many requests the page had stopped. The switch turns it off
 * or on for the site and loads the page again, so the change shows at once.
 */
function AdRows({ tabId, info }: SiteSectionProps) {
  const everywhere = useOrbit((s) => s.settings.adBlocking)
  const loading = useOrbit((s) => s.tabs[tabId]?.loading ?? false)
  const [site, setSite] = useState<AdBlockSite | null>(null)
  // Read again as the page changes and loads (what it stops grows while it does), and as the setting does.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these say when to read again
  useEffect(() => {
    if (!info.web) return
    let live = true
    void invoke('adBlock.site', { tabId }).then((read) => {
      if (live) setSite(read)
    })
    return () => {
      live = false
    }
  }, [tabId, info.web, info.url, loading, everywhere])
  if (!info.web || !site) return null
  const on = everywhere && !site.allowed
  return (
    <section className="site-panel__section" aria-label="Ads and trackers">
      <ul className="site-panel__rows">
        <li className="site-panel__row" data-testid="site-controls-ads" data-on={on ? 'true' : 'false'}>
          <ShieldBan size={14} aria-hidden />
          <span className="site-panel__name" title="Ads, and the trackers that follow you from site to site">
            Block ads and trackers
            <span className="site-panel__state" data-testid="site-controls-ads-state">
              {stateOf(everywhere, site)}
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label="Block ads and trackers"
            className={`site-switch${on ? ' is-on' : ''}`}
            data-testid="site-switch-ads"
            disabled={!everywhere}
            onClick={() => {
              setSite({ ...site, allowed: on, blocked: 0 })
              void invoke('adBlock.setSite', { tabId, blocked: !on })
            }}
          >
            <span className="site-switch__knob" />
          </button>
        </li>
      </ul>
    </section>
  )
}

export const section: SiteControlsSection = { id: 'ads', order: 15, component: AdRows }
