import { dialog, type Session, session } from 'electron'
import { DEFAULT_PROFILE_ID } from '../shared/defaults'
import { isPrivateProfileId, PRIVATE_PARTITION_PREFIX } from '../shared/private'
import type { ProfileId } from '../shared/state'
import type { Store } from './store'

/** Permissions granted without asking (harmless or user-initiated). */
const ALWAYS_ALLOW = new Set([
  'fullscreen',
  'clipboard-sanitized-write',
  'pointerLock',
  'keyboardLock',
  'speaker-selection',
])
/**
 * Permissions Orbit asks about, once per origin and profile. Until the user allows one, permission
 * checks report it as not granted, so `Notification.permission` and `permissions.query()` don't
 * claim access the user never gave. Electron's check handler is boolean, so "not decided yet" reads
 * as 'denied' (Chromium would say 'default'); `Notification.requestPermission()` and other requests
 * still reach the request handler and its prompt. `window-management` exposes the full screen
 * layout, so Chrome asks for it too.
 */
const ASK = new Set([
  'media',
  'geolocation',
  'notifications',
  'midi',
  'midiSysex',
  'clipboard-read',
  'idle-detection',
  'window-management',
])

/** Origin of a URL or origin string ("this site" when it has none). */
export function originOf(urlOrOrigin: string | undefined): string {
  if (!urlOrOrigin) return 'this site'
  try {
    const origin = new URL(urlOrOrigin).origin
    return origin === 'null' ? urlOrOrigin : origin
  } catch {
    return urlOrOrigin
  }
}

/** Decisions are per profile (session partition), origin and permission. */
export function permissionKey(partition: string, origin: string, permission: string): string {
  return `${partition}|${origin}|${permission}`
}

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
    // A private profile that is gone (its last window closed) never falls back to a normal one:
    // whatever still asks for it gets a session that keeps nothing (NV-11).
    const fallback = isPrivateProfileId(profileId)
      ? { id: profileId, partition: `${PRIVATE_PARTITION_PREFIX}gone` }
      : (profiles[DEFAULT_PROFILE_ID] ?? Object.values(profiles)[0])
    const profile = profiles[profileId] ?? fallback
    if (!profile) throw new Error('No profiles')
    const ses = session.fromPartition(profile.partition)
    if (!this.configured.has(profile.partition)) {
      this.configured.add(profile.partition)
      this.configure(ses, profile.partition)
      for (const listener of this.listeners) listener(ses, profile.id)
    }
    return ses
  }

  /** The user's decision for a permission on an origin in a profile, if they made one. */
  decision(partition: string, origin: string, permission: string): boolean | undefined {
    return this.decisions.get(permissionKey(partition, originOf(origin), permission))
  }

  /** Forgets every decision made in a profile (a private session ended, NV-11). */
  forget(partition: string): void {
    for (const key of [...this.decisions.keys()]) if (key.startsWith(`${partition}|`)) this.decisions.delete(key)
  }

  /** Records a decision (from the prompt; later from site controls). */
  decide(partition: string, origin: string, permission: string, allowed: boolean): void {
    this.decisions.set(permissionKey(partition, originOf(origin), permission), allowed)
  }

  private configure(ses: Session, partition: string): void {
    // Present as plain Chrome: some sites block "embedded" browsers by user agent.
    ses.setUserAgent(cleanUserAgent(ses.getUserAgent()))
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
      if (ALWAYS_ALLOW.has(permission)) return true
      if (!ASK.has(permission)) return false
      // Granted only when the user allowed it for this origin in this profile.
      return this.decision(partition, requestingOrigin, permission) === true
    })
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      if (ALWAYS_ALLOW.has(permission)) return callback(true)
      if (!ASK.has(permission)) return callback(false)
      const origin = originOf(details.requestingUrl || wc.getURL())
      const known = this.decision(partition, origin, permission)
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
          this.decide(partition, origin, permission, allowed)
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
