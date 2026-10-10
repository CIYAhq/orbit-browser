import { Download, LoaderCircle, ShieldAlert } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import type { BuildInfo } from '../../../shared/commands/settings'
import { invoke } from '../api'
import { useOrbit } from '../store'
import { Button, LinkButton, SettingRow, Switch, TextField } from './controls'
import { ago } from './format'
import { useMainValue } from './hooks'

const readBuildInfo = () => invoke('settings.buildInfo', {})

/**
 * Check for updates (UP-03, ST-03, ST-17): what the last check found, Check Now, and the newer
 * version's Download (its page in a tab, UP-10). `feedHere`: the feed field is in the same group.
 */
export function UpdateCheckRow({ id, feedHere = false }: { id: string; feedHere?: boolean }) {
  const updates = useOrbit((s) => s.updates)
  const feed = useOrbit((s) => s.settings.updateFeedUrl)
  // Read again whenever Settings comes to the front, which also refreshes "Checked 5 minutes ago"
  // without a timer running while Settings sits in the background.
  const [info] = useMainValue<BuildInfo>(readBuildInfo)
  const state = updates?.state ?? 'idle'
  const latest = updates?.latest
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
  } else if (latest) {
    status = `Orbit ${latest.version} is available (you have ${version}).${latest.security ? ' It fixes a serious security problem.' : ''}`
  } else if (state === 'current') {
    status = `Orbit ${version} is up to date.${checked}`
  } else if (state === 'failed') {
    status = `Couldn't check: ${updates?.error ?? 'the feed did not answer.'} Orbit tries again later.`
  } else {
    status = 'Not checked yet.'
  }
  return (
    <SettingRow
      id={id}
      label="Updates"
      description={
        <span data-testid="updates-status" data-state={latest ? 'available' : state}>
          {status}
        </span>
      }
    >
      {latest ? (
        <Button kind="primary" testId="updates-download" onClick={() => void invoke('updates.open', {})}>
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
