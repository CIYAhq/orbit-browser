import { ArrowDownToLine, RotateCw, ShieldAlert, Sparkles, X } from 'lucide-react'
import { memo } from 'react'
import type { ReleaseInfo } from '../../../shared/updates'
import { invoke } from '../api'
import { useOrbit } from '../store'
import './update-banner.css'

/**
 * The banner at the bottom of the sidebar, above the Space switcher (UP-02, UP-06, UP-10, UP-12).
 * - An update Orbit installs itself shows once it has downloaded (UP-01): "Update ready" (or
 *   "Important security update"), a compact pill that opens on hover to "Relaunch to update"; a
 *   click relaunches into it (UP-05).
 * - A newer version Orbit can't install itself (no file for this system, a copy that can't replace
 *   itself): "New version available", and a click opens the release's page in a tab (UP-10).
 * - After an update: "Updated to Orbit X", the release's line and See what's new (UP-06).
 * ✕ dismisses: an update comes back after about a day or at the next launch; What's new ends.
 */
export const UpdateBanner = memo(function UpdateBanner() {
  const latest = useOrbit((s) => s.updates?.latest)
  const installable = useOrbit((s) => s.updates?.installable === true)
  const ready = useOrbit((s) => s.updates?.state === 'ready')
  const dismissed = useOrbit((s) => s.updates?.dismissed?.version)
  const news = useOrbit((s) => s.settings.whatsNew)
  if (latest && dismissed !== latest.version && (ready || !installable)) {
    return <Release release={latest} ready={ready} />
  }
  if (news) return <WhatsNew version={news.version} summary={news.summary} />
  return null
})

function Release({ release, ready }: { release: ReleaseInfo; ready: boolean }) {
  const title = release.security ? 'Important security update' : ready ? 'Update ready' : 'New version available'
  return (
    <div
      className={`upd${release.security ? ' upd--security' : ''}`}
      data-testid="update-banner"
      data-kind={release.security ? 'security' : 'update'}
      data-action={ready ? 'relaunch' : 'open'}
    >
      <button
        type="button"
        className="upd__main"
        data-testid="update-banner-open"
        aria-label={`${title}: Orbit ${release.version}. ${ready ? 'Relaunch to update' : 'Open its page'}`}
        onClick={(e) => {
          // A click lets go of focus, so the pill closes when the pointer leaves (UP-10).
          if (e.detail > 0) e.currentTarget.blur()
          void invoke(ready ? 'updates.relaunch' : 'updates.open', {})
        }}
      >
        <span className="upd__icon" aria-hidden="true">
          {release.security ? (
            <ShieldAlert size={15} />
          ) : ready ? (
            <RotateCw size={15} />
          ) : (
            <ArrowDownToLine size={15} />
          )}
        </span>
        <span className="upd__text">
          <span className="upd__title">{title}</span>
          <span className="upd__more">
            <span className="upd__more-inner">
              {release.summary && <span className="upd__detail">{release.summary}</span>}
              <span className="upd__cta">{ready ? 'Relaunch to update' : `Get Orbit ${release.version}`}</span>
            </span>
          </span>
        </span>
      </button>
      <Dismiss banner="update" />
    </div>
  )
}

function WhatsNew({ version, summary }: { version: string; summary?: string }) {
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
          {summary && (
            <span className="upd__detail upd__detail--news" data-testid="update-banner-summary">
              {summary}
            </span>
          )}
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
