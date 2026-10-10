import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, session } from 'electron'
import type { ClearDataKind } from '../../shared/commands/settings'
import type { SecureDnsChoice } from '../../shared/state'
import type { MainContext } from '../context'
import { clearRangeStart, hostResolverConfig, isClearRange } from './dns'
import { isPersistentProfile } from './profiles'

/**
 * Present in userData while graphics acceleration is off (ST-12). It is read before the app is ready,
 * when state isn't loaded yet; the setting itself lives in state and this file follows it.
 */
const GPU_OFF_MARKER = 'gpu-off'

/** Whether this run started with graphics acceleration turned off in Settings. */
let gpuOffAtStart = false

/** Start-up switches that must be set before the app is ready (src/main/index.ts calls this). */
export function applyStartupSwitches(): void {
  gpuOffAtStart = existsSync(join(app.getPath('userData'), GPU_OFF_MARKER))
  if (gpuOffAtStart) app.disableHardwareAcceleration()
}

function syncGpuMarker(userData: string, enabled: boolean): void {
  const marker = join(userData, GPU_OFF_MARKER)
  try {
    if (enabled) rmSync(marker, { force: true })
    else if (!existsSync(marker)) writeFileSync(marker, 'Graphics acceleration is off in Orbit Settings.\n')
  } catch (err) {
    console.error('[settings] could not record the graphics acceleration setting', err)
  }
}

function applySecureDns(choice: SecureDnsChoice): void {
  try {
    app.configureHostResolver(hostResolverConfig(choice, process.platform))
  } catch (err) {
    console.error('[settings] could not apply Secure DNS', err)
  }
}

const SITE_DATA: NonNullable<Electron.ClearDataOptions['dataTypes']> = [
  'cookies',
  'localStorage',
  'indexedDB',
  'serviceWorkers',
  'fileSystems',
  'webSQL',
  'backgroundFetch',
]
const CLEAR_KINDS: readonly ClearDataKind[] = ['history', 'siteData', 'cache']

/** Graphics acceleration, Secure DNS and Clear browsing data (ST-12); restarting Orbit. */
export function registerSystemSettings(ctx: MainContext): void {
  const { store, commands } = ctx
  const userData = ctx.paths.userData

  syncGpuMarker(userData, store.state.settings.hardwareAcceleration)
  // The engine's automatic mode is its default: only another choice needs configuring.
  if (store.state.settings.secureDns !== 'automatic') applySecureDns(store.state.settings.secureDns)
  store.subscribe((next, prev) => {
    if (next.settings === prev.settings) return
    if (next.settings.hardwareAcceleration !== prev.settings.hardwareAcceleration) {
      syncGpuMarker(userData, next.settings.hardwareAcceleration)
    }
    if (next.settings.secureDns !== prev.settings.secureDns) applySecureDns(next.settings.secureDns)
  })

  // What this run started with (`app.isHardwareAccelerationEnabled()` is also false without a usable GPU).
  commands.register('settings.systemStatus', () => ({ hardwareAcceleration: !gpuOffAtStart, canRelaunch: !ctx.e2e }))
  commands.register('settings.relaunch', () => {
    // A test run never starts a second Orbit.
    if (ctx.e2e) return false
    app.relaunch()
    app.quit()
    return true
  })

  commands.register('settings.clearData', async ({ profileId, range, kinds }, c) => {
    const profile = typeof profileId === 'string' ? store.state.profiles[profileId] : undefined
    if (!profile || !isPersistentProfile(store.state, profile.id) || !isClearRange(range)) return
    const wanted = new Set((Array.isArray(kinds) ? kinds : []).filter((k) => CLEAR_KINDS.includes(k)))
    const jobs: Promise<unknown>[] = []
    if (wanted.has('history') && commands.has('history.clear')) {
      const from = clearRangeStart(range, Date.now())
      jobs.push(commands.run('history.clear', from === undefined ? { profileId } : { profileId, from }, c))
    }
    const ses = session.fromPartition(profile.partition)
    // The engine clears site data and its cache for all time only.
    if (wanted.has('siteData')) jobs.push(ses.clearData({ dataTypes: SITE_DATA }))
    if (wanted.has('cache')) jobs.push(ses.clearCache(), ses.clearData({ dataTypes: ['cache'] }))
    await Promise.all(jobs)
  })
}
