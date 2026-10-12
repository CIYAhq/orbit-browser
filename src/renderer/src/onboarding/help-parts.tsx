import type { ReactNode } from 'react'
import type { HelpPageAction, SettingsTarget } from '../../../shared/commands/settings'
import { DEFAULT_PROFILE_ID } from '../../../shared/defaults'
import { archivePeriodText } from '../../../shared/hints'
import { invoke } from '../api'
import { followKeymap, shortcutLabel, useKeymap } from '../keys/live'
import { useOrbit } from '../store'
import './help-pages.css'

/**
 * What Orbit's own help pages share (OB-09, OB-10, OB-13): `orbit://welcome/`, `orbit://guide/`
 * and `orbit://help/`. They come with the app, open offline and send nothing anywhere. Their keys
 * are the user's as they are now (KS-18), and their buttons run only the few actions `help.run`
 * allows, or open Settings.
 */

let following = false

/** The page follows the user's keymap from its first render, and draws again when a key changes. */
export function useLiveKeys(): void {
  if (!following) {
    following = true
    followKeymap()
  }
  useKeymap()
}

/** " (⌘T)" after an action's name: its key as this platform shows it, or nothing when it has none. */
export function K({ a }: { a: string }) {
  const keys = shortcutLabel(a)
  if (!keys) return null
  return (
    <>
      {' ('}
      <kbd className="help__kbd" data-action={a}>
        {keys}
      </kbd>
      {')'}
    </>
  )
}

/** How long the Default profile's Today tabs wait before the Archive (ST-05): "12 hours". */
export function useArchivePeriod(): string {
  return useOrbit((s) => archivePeriodText(s.profiles[DEFAULT_PROFILE_ID]?.archiveAfterMs ?? s.settings.archiveAfterMs))
}

export function HelpButton({ id, testId, children }: { id: HelpPageAction; testId: string; children: ReactNode }) {
  return (
    <button
      type="button"
      className="internal__button"
      data-testid={testId}
      onClick={() => void invoke('help.run', { id })}
    >
      {children}
    </button>
  )
}

/** A link-like button to a Settings section, e.g. "Settings → Shortcuts". */
export function SettingsLink({ to, testId, children }: { to: SettingsTarget; testId?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      className="help__link-button"
      data-testid={testId}
      onClick={() => void invoke('settings.open', to)}
    >
      {children}
    </button>
  )
}

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="help__section" id={id} aria-labelledby={`${id}-title`} data-testid="help-section">
      <h2 id={`${id}-title`}>{title}</h2>
      {children}
    </section>
  )
}
