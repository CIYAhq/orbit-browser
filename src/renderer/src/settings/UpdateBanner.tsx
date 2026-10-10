import { ArrowDownToLine, ShieldAlert, Sparkles, X } from 'lucide-react'
import { memo } from 'react'
import type { ReleaseInfo } from '../../../shared/updates'
import { invoke } from '../api'
import { useOrbit } from '../store'
import './update-banner.css'

/**
 * The banner at the bottom of the sidebar, above the Space switcher (UP-02, UP-06, UP-10, UP-12).
 * - A newer version: a compact pill ("New version available", or "Important security update")
 *   that opens on hover to offer it. Orbit's builds are unsigned, so a click opens the release's
 *   page in a tab rather than relaunching into it (UP-10).
 * - After an update: "Updated to Orbit X" with See what's new (UP-06).
 * ✕ dismisses: an update comes back after about a day or at the next launch; What's new ends.
 */
export const UpdateBanner = memo(function UpdateBanner() {
  const latest = useOrbit((s) => s.updates?.latest)
  const dismissed = useOrbit((s) => s.updates?.dismissed?.version)
  const news = useOrbit((s) => s.settings.whatsNew?.version)
  if (latest && dismissed !== latest.version) return <Available release={latest} />
  if (news) return <WhatsNew version={news} />
  return null
})

function Available({ release }: { release: ReleaseInfo }) {
  const title = release.security ? 'Important security update' : 'New version available'
  return (
    <div
      className={`upd${release.security ? ' upd--security' : ''}`}
      data-testid="update-banner"
      data-kind={release.security ? 'security' : 'update'}
    >
      <button
        type="button"
        className="upd__main"
        data-testid="update-banner-open"
        aria-label={`${title}: Orbit ${release.version}. Open its page`}
        onClick={() => void invoke('updates.open', {})}
      >
        <span className="upd__icon" aria-hidden="true">
          {release.security ? <ShieldAlert size={15} /> : <ArrowDownToLine size={15} />}
        </span>
        <span className="upd__text">
          <span className="upd__title">{title}</span>
          <span className="upd__more">
            <span className="upd__more-inner">
              {release.summary && <span className="upd__detail">{release.summary}</span>}
              <span className="upd__cta">Get Orbit {release.version}</span>
            </span>
          </span>
        </span>
      </button>
      <Dismiss banner="update" />
    </div>
  )
}

function WhatsNew({ version }: { version: string }) {
  return (
    <div className="upd upd--news" data-testid="update-banner" data-kind="whats-new">
      <button
        type="button"
        className="upd__main"
        data-testid="update-banner-open"
        onClick={() => void invoke('updates.whatsNew', {})}
      >
        <span className="upd__icon" aria-hidden="true">
          <Sparkles size={15} />
        </span>
        <span className="upd__text">
          <span className="upd__title">Updated to Orbit {version}</span>
          <span className="upd__link">See what's new</span>
        </span>
      </button>
      <Dismiss banner="whatsNew" />
    </div>
  )
}

function Dismiss({ banner }: { banner: 'update' | 'whatsNew' }) {
  return (
    <button
      type="button"
      className="upd__close"
      aria-label="Dismiss"
      title="Dismiss"
      data-testid="update-banner-dismiss"
      onClick={() => void invoke('updates.dismiss', { banner })}
    >
      <X size={12} aria-hidden="true" />
    </button>
  )
}
