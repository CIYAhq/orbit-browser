/**
 * Pure media model shared by the main process and the sidebar (media lane): what Orbit's page
 * script reports, how that becomes a tab's `TabMedia`, who shows in the media tray, and when
 * leaving a tab opens picture-in-picture. No Electron or DOM here, so it is unit-tested.
 */
import { DEFAULT_PIP_PLACEMENT, normalizePlacement } from './pip'
import { windowMayShow } from './private'
import type { OrbitState, Settings, Tab, TabId, TabMedia, WindowId } from './state'

/** One report from Orbit's page script (src/main/media/agent.ts). */
export interface AgentSnapshot {
  /** Report version (increases with every media event in the page). */
  v: number
  /** Unmuted media is playing. */
  playing: boolean
  /** Any media element is playing (muted ones too). */
  active: boolean
  /** A media element exists that Orbit can control. */
  controllable: boolean
  /** The main media is a video with frames. */
  video: boolean
  /** A video in the page is in picture-in-picture (the engine's window or Orbit's player). */
  pip: boolean
  /** The video is in Orbit's floating player (lifted into the page's top layer). */
  player: boolean
  /** That video's aspect ratio (width / height); 0 when not in the player or unknown. */
  aspect: number
  /** A playing, unmuted video that automatic picture-in-picture may pick (MD-01). */
  pipCandidate: boolean
  title: string
  artist: string
  /** The main media has a finite length. */
  seekable: boolean
  /** The main media played to its end. */
  ended: boolean
  /** Playback of the main media (the player's video when it shows one). */
  time: MediaTime | null
  /** The last time picture-in-picture ended without Orbit asking, and how (MD-07). */
  pipEnd: { n: number; reason: PipEndReason } | null
  mic: boolean
  micMuted: boolean
  camera: boolean
  cameraOff: boolean
}

/** Where playback was at time `at` (ms since the epoch). */
export interface MediaTime {
  position: number
  /** Length in seconds; 0 when unknown or live. */
  duration: number
  rate: number
  paused: boolean
  live: boolean
  at: number
}

/**
 * Why picture-in-picture ended: Orbit closed it ('orbit'), the video ended, the user pressed the
 * engine player's close button ('close': playback continues as audio, MD-07) or its "Back to tab"
 * ('back'), or the video left the page ('gone').
 */
export type PipEndReason = 'orbit' | 'ended' | 'close' | 'back' | 'gone'

/**
 * Actions the sidebar controller, the floating player and commands send to a tab's media.
 * 'seek' moves by `value` seconds, 'seekTo' goes to `value` seconds, 'rate' sets the speed.
 */
export type MediaAction = 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'seek' | 'seekTo' | 'rate'

/** Playback speeds offered by the floating player's menu (MD-04). */
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

/** Where playback is now, extrapolated from the last report (players redraw without asking). */
export function currentPosition(
  m: Pick<TabMedia, 'position' | 'duration' | 'rate' | 'at' | 'paused'>,
  now: number,
): number {
  const base = m.position ?? 0
  if (m.paused || m.at === undefined) return base
  const moved = base + ((now - m.at) / 1000) * (m.rate ?? 1)
  return m.duration ? Math.min(Math.max(moved, 0), m.duration) : Math.max(moved, 0)
}

/** "1:05", "12:00", "1:02:03" for a position in seconds. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** The "site" for per-site picture-in-picture choices (MD-08): the host without "www.". */
export function siteOf(url: string | undefined): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return u.hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Local midnight after `now`: "Turn off for today" lasts until then. */
export function endOfDay(now: number): number {
  const d = new Date(now)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

export type SitePipMode = 'on' | 'today' | 'always'

/** The site's picture-in-picture choice (MD-08). */
export function sitePipMode(settings: Settings, url: string | undefined, now: number): SitePipMode {
  const site = siteOf(url)
  if (!site) return 'on'
  if (settings.pipOffSites?.includes(site)) return 'always'
  const until = settings.pipSnoozed?.[site]
  return until !== undefined && until > now ? 'today' : 'on'
}

/** Automatic picture-in-picture is allowed for this page: on globally and not off for its site. */
export function autoPipAllowed(settings: Settings, url: string | undefined, now: number): boolean {
  return settings.autoPip && sitePipMode(settings, url, now) === 'on'
}

/** Applies a site choice to settings (in an Immer draft or a copy). Expired snoozes are dropped. */
export function applySitePip(settings: Settings, url: string, mode: SitePipMode, now: number): void {
  const site = siteOf(url)
  if (!site) return
  const off = (settings.pipOffSites ?? []).filter((s) => s !== site)
  const snoozed: Record<string, number> = {}
  for (const [s, until] of Object.entries(settings.pipSnoozed ?? {})) if (s !== site && until > now) snoozed[s] = until
  if (mode === 'always') off.push(site)
  if (mode === 'today') snoozed[site] = endOfDay(now)
  settings.pipOffSites = off
  settings.pipSnoozed = snoozed
}

/**
 * Cleans the media settings read from disk (MD-06, MD-08): site lists hold host names, snoozes
 * that ran out are dropped, and the player's placement is a known corner and a sane size.
 */
export function normalizeMediaSettings(settings: Settings, now: number): void {
  const sites = Array.isArray(settings.pipOffSites) ? settings.pipOffSites : []
  settings.pipOffSites = [...new Set(sites.filter((s): s is string => typeof s === 'string' && s.length > 0))].slice(
    0,
    1000,
  )
  const snoozed: Record<string, number> = {}
  const raw = settings.pipSnoozed
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [site, until] of Object.entries(raw)) {
      if (site && typeof until === 'number' && Number.isFinite(until) && until > now) snoozed[site] = until
    }
  }
  settings.pipSnoozed = snoozed
  settings.pipPlacement = normalizePlacement(settings.pipPlacement) ?? { ...DEFAULT_PIP_PLACEMENT }
}

/** A fresh media record before the page script has reported. */
export function emptyMedia(): TabMedia {
  return {
    playing: false,
    active: false,
    controllable: false,
    video: false,
    pip: false,
    seekable: false,
    ended: false,
    tray: false,
    since: 0,
  }
}

/** Merges a page report into a tab's media record (tray membership is settled by `settleTray`). */
export function mediaFromSnapshot(prev: TabMedia | undefined, snap: AgentSnapshot): TabMedia {
  const base = prev ?? emptyMedia()
  const next: TabMedia = {
    ...base,
    playing: snap.playing,
    active: snap.active,
    controllable: snap.controllable,
    video: snap.video,
    pip: snap.pip,
    player: snap.player || undefined,
    seekable: snap.seekable,
    ended: snap.ended,
    paused: snap.time?.paused || undefined,
    live: snap.time?.live || undefined,
    position: snap.time ? Math.round(snap.time.position * 1000) / 1000 : undefined,
    duration: snap.time && !snap.time.live && snap.time.duration > 0 ? snap.time.duration : undefined,
    rate: snap.time && snap.time.rate !== 1 ? snap.time.rate : undefined,
    at: snap.time?.at,
    title: snap.title || undefined,
    artist: snap.artist || undefined,
    mic: snap.mic || undefined,
    micMuted: snap.mic && snap.micMuted ? true : undefined,
    camera: snap.camera || undefined,
    cameraOff: snap.camera && snap.cameraOff ? true : undefined,
  }
  if (!snap.pip) next.autoPip = undefined
  // Playing again after the user closed the controller brings it back (MD-09).
  if (snap.playing && !base.playing) next.dismissed = undefined
  return clean(next)
}

/**
 * Sidebar tray membership (MD-09, MD-10, MD-08):
 * - never for a tab on screen, a muted tab, a video in picture-in-picture or one closed with ×;
 * - joins when its media plays (or the tab is audible, or in a call, MD-14) while the tab is in the background;
 * - stays while paused there, so it can be resumed, until the media ends;
 * - media Orbit can't control leaves as soon as the tab goes quiet.
 */
export function settleTray(
  media: TabMedia,
  tab: Pick<Tab, 'muted' | 'audible'>,
  displayed: boolean,
  now: number,
): TabMedia {
  let tray: boolean
  if (displayed || tab.muted || media.pip || media.dismissed) tray = false
  else if (media.playing || tab.audible || media.mic || media.camera) tray = true
  else if (media.ended || !media.controllable) tray = false
  else tray = media.tray
  if (tray === media.tray) return media
  return { ...media, tray, since: tray ? now : media.since }
}

/** Drops undefined keys so records compare and serialize the same way. */
function clean(m: TabMedia): TabMedia {
  for (const key of Object.keys(m) as (keyof TabMedia)[]) if (m[key] === undefined) delete m[key]
  return m
}

/** True when two media records show the same thing. */
export function sameMedia(a: TabMedia | undefined, b: TabMedia | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof TabMedia>
  for (const key of keys) if (a[key] !== b[key]) return false
  return true
}

/**
 * Leaving this tab should open picture-in-picture (MD-01, MD-08): a playing, unmuted video, the
 * tab not muted, automatic PiP on globally and for the site, and not already in PiP.
 */
export function shouldAutoPip(
  settings: Settings,
  tab: Pick<Tab, 'muted' | 'url' | 'media'>,
  pipCandidate: boolean,
  now: number,
): boolean {
  const m = tab.media
  if (!m || tab.muted || m.pip || !pipCandidate) return false
  return autoPipAllowed(settings, tab.url, now)
}

/**
 * Media keeps a tab alive (MD-12, TB-16, TD-02): playing (muted or not), in picture-in-picture,
 * or using the camera or microphone. Such tabs never sleep, auto-archive or clear.
 */
export function isMediaBusy(tab: Pick<Tab, 'audible' | 'media'> | undefined): boolean {
  if (!tab) return false
  if (tab.audible) return true
  const m = tab.media
  return !!m && (m.playing || m.active || m.pip || !!m.mic || !!m.camera)
}

/** Anything playing anywhere (updates wait for it, MD-12). */
export function isAnyMediaPlaying(state: OrbitState): boolean {
  for (const tab of Object.values(state.tabs)) if (tab.audible || tab.media?.playing || tab.media?.pip) return true
  return false
}

/**
 * Tabs in a window's sidebar media tray, newest first (MD-10). A private window lists only its own
 * tabs, and no other window lists a private one (`windowMayShow`).
 */
export function trayTabIds(state: OrbitState, windowId: WindowId): TabId[] {
  const tabs: Tab[] = []
  for (const tab of Object.values(state.tabs)) {
    if (tab.media?.tray && windowMayShow(state, windowId, tab.id)) tabs.push(tab)
  }
  tabs.sort((a, b) => (b.media?.since ?? 0) - (a.media?.since ?? 0) || (a.id < b.id ? -1 : 1))
  return tabs.map((t) => t.id)
}

/** The controller's title: the track name from the page's Media Session, else the tab's title. */
export function mediaTitle(tab: Pick<Tab, 'title' | 'customTitle' | 'url' | 'media'>): string {
  return tab.media?.title || tab.customTitle || tab.title || tab.url
}

/** The controller's second line: the artist, else the site. */
export function mediaSubtitle(tab: Pick<Tab, 'url' | 'media'>): string {
  return tab.media?.artist || siteOf(tab.url)
}

/** A call is going on in the tab: it uses the camera or microphone (MD-13, MD-14). */
export function inCall(tab: Pick<Tab, 'media'> | undefined): boolean {
  return !!tab?.media && (!!tab.media.mic || !!tab.media.camera)
}
