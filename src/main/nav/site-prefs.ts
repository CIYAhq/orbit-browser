import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { sameZoom, ZOOM_STEPS } from '../../shared/nav'
import { isPrivateProfileId } from '../../shared/private'
import { type DeviceKind, isPermissionKind, type PermissionChoice, type PermissionKind } from '../../shared/site'

interface SitePrefsData {
  /** One-time hints already shown (e.g. the ⌘⇧C tip, NV-17). */
  hints: Record<string, true>
  /** Page zoom per profile and host, when not 100% (NV-06). */
  zoom: Record<string, Record<string, number>>
  /** Hosts allowed to open pop-ups without a click, per profile (NV-09, NV-16). */
  popups: Record<string, Record<string, true>>
  /** Permission choices per profile and origin (NV-15, NV-16). */
  permissions: Record<string, Record<string, SitePermissions>>
  /** Devices a site may use again without asking, per profile and origin (NV-15). */
  devices: Record<string, Record<string, DeviceGrant[]>>
}

export type SitePermissions = Partial<Record<PermissionKind, PermissionChoice>>

/** A device a site was allowed to connect to: its lasting identity and its name. */
export interface DeviceGrant {
  type: DeviceKind
  key: string
  name: string
}

const DEVICE_KINDS: readonly DeviceKind[] = ['serial', 'usb', 'hid']

const MIN_ZOOM = ZOOM_STEPS[0] as number
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1] as number

type SiteChoices = Pick<SitePrefsData, 'zoom' | 'popups' | 'permissions' | 'devices'>

const emptyChoices = (): SiteChoices => ({ zoom: {}, popups: {}, permissions: {}, devices: {} })

/**
 * The chrome lane's small per-user settings, kept out of OrbitState so they never travel to the
 * renderers: one-time hints and per-site choices. Saved off the main thread shortly after a
 * change, and synchronously on quit. Private profiles' choices stay in memory (NV-11).
 */
export class SitePrefs {
  private data: SitePrefsData = { hints: {}, ...emptyChoices() }
  /** Choices made in private windows: never written, gone with the private session. */
  private ephemeral: SiteChoices = emptyChoices()
  private timer: NodeJS.Timeout | undefined
  /** Counts changes; `saved` is the count the file on disk has caught up with. */
  private changes = 0
  private saved = 0
  private writing: Promise<void> = Promise.resolve()

  constructor(private file: string) {}

  load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<SitePrefsData>
      const hints: Record<string, true> = {}
      for (const [id, shown] of Object.entries(raw.hints ?? {})) if (shown === true) hints[id] = true
      const zoom: Record<string, Record<string, number>> = {}
      for (const [profile, hosts] of Object.entries(raw.zoom ?? {})) {
        if (!hosts || typeof hosts !== 'object') continue
        for (const [host, factor] of Object.entries(hosts)) {
          if (typeof factor !== 'number' || !(factor >= MIN_ZOOM && factor <= MAX_ZOOM) || sameZoom(factor, 1)) continue
          zoom[profile] ??= {}
          ;(zoom[profile] as Record<string, number>)[host] = factor
        }
      }
      const popups: Record<string, Record<string, true>> = {}
      for (const [profile, hosts] of Object.entries(raw.popups ?? {})) {
        if (!hosts || typeof hosts !== 'object') continue
        for (const [host, allowed] of Object.entries(hosts)) {
          if (allowed !== true) continue
          popups[profile] ??= {}
          ;(popups[profile] as Record<string, true>)[host] = true
        }
      }
      const permissions: Record<string, Record<string, SitePermissions>> = {}
      for (const [profile, origins] of Object.entries(raw.permissions ?? {})) {
        if (!origins || typeof origins !== 'object') continue
        for (const [origin, kinds] of Object.entries(origins)) {
          if (!kinds || typeof kinds !== 'object') continue
          const kept: SitePermissions = {}
          for (const [kind, choice] of Object.entries(kinds)) {
            if (isPermissionKind(kind) && (choice === 'allow' || choice === 'block')) kept[kind] = choice
          }
          if (Object.keys(kept).length === 0) continue
          permissions[profile] ??= {}
          ;(permissions[profile] as Record<string, SitePermissions>)[origin] = kept
        }
      }
      const devices: Record<string, Record<string, DeviceGrant[]>> = {}
      for (const [profile, origins] of Object.entries(raw.devices ?? {})) {
        if (!origins || typeof origins !== 'object') continue
        for (const [origin, grants] of Object.entries(origins)) {
          if (!Array.isArray(grants)) continue
          const kept = grants.filter(
            (g): g is DeviceGrant =>
              !!g &&
              DEVICE_KINDS.includes(g.type) &&
              typeof g.key === 'string' &&
              typeof g.name === 'string' &&
              g.key.length > 0,
          )
          if (kept.length === 0) continue
          devices[profile] ??= {}
          ;(devices[profile] as Record<string, DeviceGrant[]>)[origin] = kept.map(({ type, key, name }) => ({
            type,
            key,
            name,
          }))
        }
      }
      this.data = { hints, zoom, popups, permissions, devices }
    } catch {
      // No file yet, or unreadable: start empty.
    }
  }

  hintShown(id: string): boolean {
    return this.data.hints[id] === true
  }

  markHint(id: string): void {
    if (this.data.hints[id]) return
    this.data.hints[id] = true
    this.schedule()
  }

  /** The page zoom remembered for a host in a profile (NV-06); undefined means 100%. */
  zoomFor(profileId: string, host: string): number | undefined {
    return this.choices(profileId).zoom[profileId]?.[host]
  }

  setZoom(profileId: string, host: string, factor: number): void {
    const choices = this.choices(profileId)
    const hosts = choices.zoom[profileId]
    if (sameZoom(factor, 1)) {
      if (!hosts || hosts[host] === undefined) return
      delete hosts[host]
      if (Object.keys(hosts).length === 0) delete choices.zoom[profileId]
    } else {
      if (hosts?.[host] !== undefined && sameZoom(hosts[host] as number, factor)) return
      choices.zoom[profileId] = { ...hosts, [host]: factor }
    }
    this.changed(profileId)
  }

  /** Whether a host may open pop-ups without a click in a profile (NV-09). */
  popupsAllowed(profileId: string, host: string): boolean {
    return this.choices(profileId).popups[profileId]?.[host] === true
  }

  setPopupsAllowed(profileId: string, host: string, allowed: boolean): void {
    if (this.popupsAllowed(profileId, host) === allowed) return
    const choices = this.choices(profileId)
    const hosts = { ...choices.popups[profileId] }
    if (allowed) hosts[host] = true
    else delete hosts[host]
    if (Object.keys(hosts).length > 0) choices.popups[profileId] = hosts
    else delete choices.popups[profileId]
    this.changed(profileId)
  }

  /** The user's choice for a permission on an origin in a profile (NV-15), if they made one. */
  permission(profileId: string, origin: string, kind: PermissionKind): PermissionChoice | undefined {
    return this.choices(profileId).permissions[profileId]?.[origin]?.[kind]
  }

  /** Every permission choice made on an origin in a profile. */
  permissionsFor(profileId: string, origin: string): SitePermissions {
    return { ...this.choices(profileId).permissions[profileId]?.[origin] }
  }

  /** Records (or with undefined, forgets) a permission choice. */
  setPermission(profileId: string, origin: string, kind: PermissionKind, choice: PermissionChoice | undefined): void {
    if (this.permission(profileId, origin, kind) === choice) return
    const choices = this.choices(profileId)
    const origins = { ...choices.permissions[profileId] }
    const kinds: SitePermissions = { ...origins[origin] }
    if (choice) kinds[kind] = choice
    else delete kinds[kind]
    if (Object.keys(kinds).length > 0) origins[origin] = kinds
    else delete origins[origin]
    if (Object.keys(origins).length > 0) choices.permissions[profileId] = origins
    else delete choices.permissions[profileId]
    this.changed(profileId)
  }

  /** Devices an origin may use again in a profile (NV-15). */
  devicesFor(profileId: string, origin: string): DeviceGrant[] {
    return [...(this.choices(profileId).devices[profileId]?.[origin] ?? [])]
  }

  grantDevice(profileId: string, origin: string, grant: DeviceGrant): void {
    const current = this.devicesFor(profileId, origin)
    if (current.some((g) => g.key === grant.key)) return
    this.setDevices(profileId, origin, [...current, { type: grant.type, key: grant.key, name: grant.name }])
  }

  revokeDevice(profileId: string, origin: string, key: string): void {
    const current = this.devicesFor(profileId, origin)
    const next = current.filter((g) => g.key !== key)
    if (next.length !== current.length) this.setDevices(profileId, origin, next)
  }

  private setDevices(profileId: string, origin: string, grants: DeviceGrant[]): void {
    const choices = this.choices(profileId)
    const origins = { ...choices.devices[profileId] }
    if (grants.length > 0) origins[origin] = grants
    else delete origins[origin]
    if (Object.keys(origins).length > 0) choices.devices[profileId] = origins
    else delete choices.devices[profileId]
    this.changed(profileId)
  }

  /**
   * Every per-site choice of a profile, for Settings → Site settings (ST-13): permission choices
   * and devices by origin, and the hosts allowed pop-ups.
   */
  sitesOf(profileId: string): {
    permissions: Record<string, SitePermissions>
    popups: string[]
    devices: Record<string, DeviceGrant[]>
  } {
    const choices = this.choices(profileId)
    const permissions: Record<string, SitePermissions> = {}
    for (const [origin, kinds] of Object.entries(choices.permissions[profileId] ?? {}))
      permissions[origin] = { ...kinds }
    const devices: Record<string, DeviceGrant[]> = {}
    for (const [origin, grants] of Object.entries(choices.devices[profileId] ?? {})) {
      devices[origin] = grants.map((g) => ({ ...g }))
    }
    return { permissions, popups: Object.keys(choices.popups[profileId] ?? {}), devices }
  }

  /** Forgets every choice made in private windows (the last one closed). */
  forgetPrivate(): void {
    this.ephemeral = emptyChoices()
  }

  /** Forgets a deleted profile's choices: zoom, pop-up hosts, permissions and devices (review B-F7). */
  forgetProfile(profileId: string): void {
    const choices = this.choices(profileId)
    const kept = [choices.zoom, choices.popups, choices.permissions, choices.devices].filter((map) => profileId in map)
    if (kept.length === 0) return
    for (const map of kept) delete map[profileId]
    this.changed(profileId)
  }

  private choices(profileId: string): SiteChoices {
    return isPrivateProfileId(profileId) ? this.ephemeral : this.data
  }

  private changed(profileId: string): void {
    if (!isPrivateProfileId(profileId)) this.schedule()
  }

  /**
   * Writes what the file hasn't caught up with now (quit), including changes a write still on its
   * way holds: the app may be gone before that write lands (review A-F9).
   */
  flush(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.saved >= this.changes) return
    const upTo = this.changes
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data))
      renameSync(tmp, this.file)
      this.saved = upTo
    } catch (err) {
      console.error('[site-prefs] could not save', err)
    }
  }

  /** Resolves once the background writes started so far have landed, or given way to a newer one (tests). */
  written(): Promise<void> {
    return this.writing
  }

  private schedule(): void {
    this.changes++
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      const upTo = this.changes
      if (this.saved >= upTo) return
      const data = JSON.stringify(this.data)
      // A file of its own: a write on quit, or a later one, may run while this one is on its way.
      const tmp = `${this.file}.${upTo}.tmp`
      const write = mkdir(dirname(this.file), { recursive: true })
        .then(() => writeFile(tmp, data))
        .then(() => {
          // In the same tick as the check: something newer on disk (a write on quit) is never undone.
          if (this.saved >= upTo) rmSync(tmp, { force: true })
          else {
            renameSync(tmp, this.file)
            this.saved = upTo
          }
        })
        .catch((err) => console.error('[site-prefs] could not save', err))
      this.writing = Promise.all([this.writing, write]).then(() => undefined)
    }, 500)
    this.timer.unref?.()
  }
}
