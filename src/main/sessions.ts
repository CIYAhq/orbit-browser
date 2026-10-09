import { dialog, type Session, session } from 'electron'
import { DEFAULT_PROFILE_ID } from '../shared/defaults'
import type { ProfileId } from '../shared/state'
import type { Store } from './store'

/** Permissions granted without asking (harmless or user-initiated). */
const ALWAYS_ALLOW = new Set([
  'fullscreen',
  'clipboard-sanitized-write',
  'pointerLock',
  'keyboardLock',
  'window-management',
  'speaker-selection',
])
/** Permissions Orbit asks about once per origin per run. */
const ASK = new Set(['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'clipboard-read', 'idle-detection'])

/**
 * One Electron session per Orbit profile. Profiles isolate cookies, storage,
 * cache, permissions and extensions. Configures each session once.
 */
export class Sessions {
  private configured = new Set<string>()
  private decisions = new Map<string, boolean>()
  private listeners: ((ses: Session, profileId: ProfileId) => void)[] = []

  constructor(private store: Store) {}

  /** Lets features (downloads, extensions, tweaks) configure every profile session. */
  onSessionCreated(listener: (ses: Session, profileId: ProfileId) => void): void {
    this.listeners.push(listener)
    for (const profile of Object.values(this.store.state.profiles)) {
      if (this.configured.has(profile.partition)) listener(session.fromPartition(profile.partition), profile.id)
    }
  }

  get(profileId: ProfileId): Session {
    const profiles = this.store.state.profiles
    const profile = profiles[profileId] ?? profiles[DEFAULT_PROFILE_ID] ?? Object.values(profiles)[0]
    if (!profile) throw new Error('No profiles')
    const ses = session.fromPartition(profile.partition)
    if (!this.configured.has(profile.partition)) {
      this.configured.add(profile.partition)
      this.configure(ses)
      for (const listener of this.listeners) listener(ses, profile.id)
    }
    return ses
  }

  private configure(ses: Session): void {
    // Present as plain Chrome: some sites block "embedded" browsers by user agent.
    ses.setUserAgent(cleanUserAgent(ses.getUserAgent()))
    ses.setPermissionCheckHandler((_wc, permission) => ALWAYS_ALLOW.has(permission) || ASK.has(permission))
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      if (ALWAYS_ALLOW.has(permission)) return callback(true)
      if (!ASK.has(permission)) return callback(false)
      let origin = 'this site'
      try {
        origin = new URL(details.requestingUrl ?? wc.getURL()).origin
      } catch {
        // keep generic label
      }
      const key = `${origin}|${permission}`
      const known = this.decisions.get(key)
      if (known !== undefined) return callback(known)
      if (process.env.ORBIT_E2E === '1') return callback(false)
      const label = permission === 'media' ? 'use your camera and/or microphone' : `use ${permission}`
      void dialog
        .showMessageBox({
          type: 'question',
          buttons: ['Allow', 'Block'],
          defaultId: 1,
          cancelId: 1,
          message: `${origin} wants to ${label}.`,
        })
        .then(({ response }) => {
          const allowed = response === 0
          this.decisions.set(key, allowed)
          callback(allowed)
        })
    })
  }
}

export function cleanUserAgent(ua: string): string {
  return ua
    .replace(/\s?Electron\/\S+/i, '')
    .replace(/\s?orbit-browser\/\S+/i, '')
    .replace(/\s?Orbit\/\S+/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
