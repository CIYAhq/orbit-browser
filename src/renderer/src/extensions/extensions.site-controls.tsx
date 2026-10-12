import { useEffect, useState } from 'react'
import type { StoreListing } from '../../../shared/commands/extensions'
import { extensionKey } from '../../../shared/extensions'
import type { TabId } from '../../../shared/state'
import { invoke } from '../api'
import type { SiteControlsSection, SiteSectionProps } from '../overlay/site/registry'
import { useOrbit } from '../store'
import { ExtensionIcon } from './ExtensionIcon'
import './extensions.css'
import './site.css'

/**
 * On a store listing page, Orbit's own way to add its extension (EX-01): for when the store's button
 * doesn't offer to install in Orbit. Main reads the extension's ID from the tab's own address,
 * downloads and checks the file, and asks in Orbit's dialog, which takes the panel's place.
 */
function StoreRow({ tabId }: { tabId: TabId }) {
  const url = useOrbit((s) => s.tabs[tabId]?.url)
  const profileId = useOrbit((s) => s.tabs[tabId]?.profileId)
  const [listing, setListing] = useState<StoreListing | null>(null)
  const [adding, setAdding] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: asks again when the tab's page changes
  useEffect(() => {
    let live = true
    void invoke('extensions.storeListing', { tabId }).then((found) => {
      if (live) setListing(found)
    })
    return () => {
      live = false
    }
  }, [tabId, url])
  const added = useOrbit((s) =>
    listing && profileId ? (s.extensions[extensionKey(profileId, listing.id)] ?? null) : null,
  )
  if (!listing) return null
  const add = async () => {
    setAdding(true)
    try {
      await invoke('extensions.installFromStore', { tabId })
    } finally {
      setAdding(false)
    }
  }
  return (
    <section className="site-panel__section" aria-label="Extension store" data-testid="ext-store">
      <ul className="site-panel__rows">
        <li className="site-panel__row ext-site-row" data-testid="ext-store-row" data-state={added ? 'added' : 'new'}>
          <ExtensionIcon icon={added?.icon ?? ''} size={18} />
          <span className="site-panel__name">
            {added ? added.name : 'This extension'}
            <span className="site-panel__state">
              {added ? 'In this profile' : listing.private ? 'Not in a private window' : 'From the extension store'}
            </span>
          </span>
          {!added && !listing.private && (
            <button
              type="button"
              className="site-panel__button is-primary"
              data-testid="ext-store-add"
              disabled={adding}
              onClick={() => void add()}
            >
              {adding ? 'Adding…' : 'Add to Orbit'}
            </button>
          )}
        </li>
      </ul>
    </section>
  )
}

/** The extensions part of the site controls panel (EX-01, EX-03). */
function ExtensionsSection({ tabId }: SiteSectionProps) {
  return <StoreRow tabId={tabId} />
}

export const section: SiteControlsSection = { id: 'extensions', order: 10, component: ExtensionsSection }
