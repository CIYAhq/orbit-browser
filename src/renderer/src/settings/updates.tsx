import { Download, LoaderCircle, RotateCw, ShieldAlert } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { invoke } from '../api'
import { useOrbit } from '../store'
import { useBuildInfo } from './build-info'
import { Button, LinkButton, SettingRow, Switch, TextField } from './controls'
import { ago } from './format'
import { useRedrawOnFocus } from './hooks'

/**
 * Check for updates (UP-03, ST-03, ST-17): what the last check found, Check Now, and the newer
 * version's Download → progress → Relaunch where Orbit installs it itself; elsewhere Download opens
 * its page in a tab (UP-10). `feedHere`: the feed field is in the same group.
 */
export function UpdateCheckRow({ id, feedHere = false }: { id: string; feedHere?: boolean }) {
  const updates = useOrbit((s) => s.updates)
  const feed = useOrbit((s) => s.settings.updateFeedUrl)
  const auto = useOrbit((s) => s.settings.updateChecks)
  const info = useBuildInfo()
  // "Checked 5 minutes ago" is drawn again when Settings comes to the front, with no timer running
  // while Settings sits in the background.
  useRedrawOnFocus()
  const state = updates?.state ?? 'idle'
  const latest = updates?.latest
  const installs = updates?.installable === true
  const percent = Math.round((updates?.progress ?? 0) * 100)
  const version = info?.version ?? ''
  const checked = updates?.checkedAt ? ` Checked ${ago(updates.checkedAt)}.` : ''
  let status: ReactNode
  if (!feed) {
    status = feedHere ? (
      "Orbit doesn't check: no update feed is set."
    ) : (
      <>
        Orbit doesn't check: no update feed is set.{' '}
        <LinkButton
          testId="updates-set-feed"
          onClick={() => void invoke('settings.open', { section: 'general', item: 'update-feed' })}
        >
          Set one…
        </LinkButton>
      </>
    )
  } else if (state === 'checking') {
    status = 'Checking…'
  } else if (latest && state === 'downloading') {
    status = `Downloading Orbit ${latest.version}… ${percent}%`
  } else if (latest && state === 'ready') {
    status = `Orbit ${latest.version} is ready. Relaunch to update (you have ${version}).`
  } else if (latest) {
    const failed = updates?.downloadError ? ` ${updates.downloadError}${auto ? ' Orbit tries again later.' : ''}` : ''
    status = `Orbit ${latest.version} is available (you have ${version}).${latest.security ? ' It fixes a serious security problem.' : ''}${failed}`
  } else if (state === 'current') {
    status = `Orbit ${version} is up to date.${checked}`
  } else if (state === 'failed') {
    status = `Couldn't check: ${updates?.error ?? 'the feed did not answer.'} Orbit tries again later.`
  } else {
    status = 'Not checked yet.'
  }
  const shown = latest && (state === 'downloading' || state === 'ready') ? state : latest ? 'available' : state
  return (
    <SettingRow
      id={id}
      label="Updates"
      description={
        <span data-testid="updates-status" data-state={shown}>
          {status}
        </span>
      }
    >
      {latest && state === 'downloading' ? (
        <div
          className="st-progress"
          role="progressbar"
          aria-label={`Downloading Orbit ${latest.version}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          data-testid="updates-progress"
        >
          <div className="st-progress__bar" style={{ width: `${percent}%` }} />
        </div>
      ) : latest && state === 'ready' ? (
        <Button kind="primary" testId="updates-relaunch" onClick={() => void invoke('updates.relaunch', {})}>
          <RotateCw size={13} aria-hidden="true" />
          Relaunch
        </Button>
      ) : latest ? (
        // Orbit downloads it here, or, where it can't install it itself, opens its page (UP-10).
        <Button
          kind="primary"
          testId="updates-download"
          onClick={() => void invoke(installs ? 'updates.download' : 'updates.open', {})}
        >
          {latest.security ? <ShieldAlert size={13} aria-hidden="true" /> : <Download size={13} aria-hidden="true" />}
          Download {latest.version}
        </Button>
      ) : (
        <Button
          testId="updates-check"
          disabled={!feed || state === 'checking'}
          onClick={() => void invoke('updates.check', {})}
        >
          {state === 'checking' && <LoaderCircle size={13} className="st-spin" aria-hidden="true" />}
          Check Now
        </Button>
      )}
    </SettingRow>
  )
}

/** Automatic checks (UP-01) and the feed address (UP-10), under General → Updates. */
export function UpdateSettingsRows() {
  const auto = useOrbit((s) => s.settings.updateChecks)
  const feed = useOrbit((s) => s.settings.updateFeedUrl)
  const [draft, setDraft] = useState(feed)
  const [error, setError] = useState('')
  useEffect(() => {
    setDraft(feed)
    setError('')
  }, [feed])
  const commit = () => {
    if (draft.trim() === feed) return setError('')
    void invoke('updates.setFeed', { url: draft }).then(setError)
  }
  return (
    <>
      <SettingRow
        id="auto-update-check"
        label="Check for updates automatically"
        description="When Orbit starts and every few hours. A check asks the update feed only, and tells it nothing but Orbit's version, your system and its processor type."
      >
        <Switch
          checked={auto}
          label="Check for updates automatically"
          testId="updates-auto"
          onChange={(next) => void invoke('settings.update', { updateChecks: next })}
        />
      </SettingRow>
      <SettingRow
        id="update-feed"
        label="Update feed"
        description="Where Orbit looks for new versions: a JSON release feed, or a GitHub project's latest release (https://api.github.com/repos/…/releases/latest). Leave it empty and Orbit never checks."
        stacked
      >
        <TextField
          value={draft}
          onChange={(v) => {
            setDraft(v)
            if (error) setError('')
          }}
          onCommit={commit}
          label="Update feed address"
          hideLabel
          wide
          placeholder="https://"
          error={error || undefined}
          testId="update-feed"
        />
      </SettingRow>
    </>
  )
}
