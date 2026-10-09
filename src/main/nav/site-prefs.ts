import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { sameZoom, ZOOM_STEPS } from '../../shared/nav'
import { isPrivateProfileId } from '../../shared/private'

interface SitePrefsData {
  /** One-time hints already shown (e.g. the ⌘⇧C tip, NV-17). */
  hints: Record<string, true>
  /** Page zoom per profile and host, when not 100% (NV-06). */
  zoom: Record<string, Record<string, number>>
  /** Hosts allowed to open pop-ups without a click, per profile (NV-09, NV-16). */
  popups: Record<string, Record<string, true>>
}

const MIN_ZOOM = ZOOM_STEPS[0] as number
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1] as number

type SiteChoices = Pick<SitePrefsData, 'zoom' | 'popups'>

/**
 * The chrome lane's small per-user settings, kept out of OrbitState so they never travel to the
 * renderers: one-time hints and per-site choices. Saved off the main thread shortly after a
 * change, and synchronously on quit. Private profiles' choices stay in memory (NV-11).
 */
export class SitePrefs {
  private data: SitePrefsData = { hints: {}, zoom: {}, popups: {} }
  /** Choices made in private windows: never written, gone with the private session. */
  private ephemeral: SiteChoices = { zoom: {}, popups: {} }
  private timer: NodeJS.Timeout | undefined
  private dirty = false

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
      this.data = { hints, zoom, popups }
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

  /** Forgets every choice made in private windows (the last one closed). */
  forgetPrivate(): void {
    this.ephemeral = { zoom: {}, popups: {} }
  }

  private choices(profileId: string): SiteChoices {
    return isPrivateProfileId(profileId) ? this.ephemeral : this.data
  }

  private changed(profileId: string): void {
    if (!isPrivateProfileId(profileId)) this.schedule()
  }

  /** Writes pending changes now (quit). */
  flush(): void {
    if (!this.dirty) return
    clearTimeout(this.timer)
    this.timer = undefined
    this.dirty = false
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data))
      renameSync(tmp, this.file)
    } catch (err) {
      console.error('[site-prefs] could not save', err)
    }
  }

  private schedule(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.dirty) return
      this.dirty = false
      const tmp = `${this.file}.tmp`
      void mkdir(dirname(this.file), { recursive: true })
        .then(() => writeFile(tmp, JSON.stringify(this.data)))
        .then(() => rename(tmp, this.file))
        .catch((err) => console.error('[site-prefs] could not save', err))
    }, 500)
    this.timer.unref?.()
  }
}
