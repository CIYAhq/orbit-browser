import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/shared/defaults'
import {
  type AgentSnapshot,
  applySitePip,
  autoPipAllowed,
  currentPosition,
  emptyMedia,
  endOfDay,
  formatClock,
  isAnyMediaPlaying,
  isMediaBusy,
  mediaFromSnapshot,
  mediaSubtitle,
  mediaTitle,
  normalizeMediaSettings,
  sameMedia,
  settleTray,
  shouldAutoPip,
  siteOf,
  sitePipMode,
  trayTabIds,
} from '../../src/shared/media'
import type { OrbitState, Settings, Tab, TabMedia } from '../../src/shared/state'

const snap = (over: Partial<AgentSnapshot> = {}): AgentSnapshot => ({
  v: 1,
  playing: true,
  active: true,
  controllable: true,
  video: false,
  pip: false,
  player: false,
  aspect: 0,
  pipCandidate: false,
  time: null,
  title: '',
  artist: '',
  seekable: true,
  ended: false,
  pipEnd: null,
  mic: false,
  micMuted: false,
  camera: false,
  cameraOff: false,
  ...over,
})

const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over })
const quiet = { muted: false, audible: false }
const NOW = new Date(2026, 9, 9, 15, 30).getTime()

function tab(id: string, media?: TabMedia, over: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: 's-1',
    profileId: 'p-default',
    url: 'https://music.example.com/listen',
    title: `Page ${id}`,
    createdAt: 0,
    lastActiveAt: 0,
    loading: false,
    audible: false,
    muted: false,
    canGoBack: false,
    canGoForward: false,
    asleep: false,
    media,
    ...over,
  }
}

describe('media records from page reports', () => {
  it('copies what the page reports and drops empty fields', () => {
    const m = mediaFromSnapshot(undefined, snap({ title: 'Song', artist: '' }))
    expect(m).toMatchObject({ playing: true, controllable: true, title: 'Song', tray: false })
    expect('artist' in m).toBe(false)
    expect('mic' in m).toBe(false)
  })

  it('a controller closed with × comes back when the media plays again (MD-09)', () => {
    const closed = { ...mediaFromSnapshot(undefined, snap({ playing: false })), dismissed: true }
    expect(mediaFromSnapshot(closed, snap({ playing: false })).dismissed).toBe(true)
    expect(mediaFromSnapshot(closed, snap({ playing: true })).dismissed).toBeUndefined()
  })

  it('forgets "opened automatically" once picture-in-picture ends', () => {
    const inPip = { ...mediaFromSnapshot(undefined, snap({ pip: true })), autoPip: true }
    expect(mediaFromSnapshot(inPip, snap({ pip: false })).autoPip).toBeUndefined()
  })

  it('[MD-04] keeps where playback is, how long it is, its speed and whether it is live', () => {
    const time = { position: 12.34567, duration: 59.8, rate: 1.5, paused: false, live: false, at: 1000 }
    const m = mediaFromSnapshot(undefined, snap({ video: true, time }))
    expect(m).toMatchObject({ position: 12.346, duration: 59.8, rate: 1.5, at: 1000 })
    expect('paused' in m).toBe(false)
    expect('live' in m).toBe(false)
    const live = mediaFromSnapshot(
      m,
      snap({ time: { ...time, rate: 1, live: true, duration: Number.POSITIVE_INFINITY } }),
    )
    expect(live.live).toBe(true)
    expect('duration' in live).toBe(false)
    expect('rate' in live).toBe(false)
    expect(mediaFromSnapshot(m, snap({ time: { ...time, paused: true } })).paused).toBe(true)
  })

  it('compares records by value', () => {
    const a = mediaFromSnapshot(undefined, snap())
    expect(sameMedia(a, { ...a })).toBe(true)
    expect(sameMedia(a, { ...a, playing: false })).toBe(false)
    expect(sameMedia(undefined, a)).toBe(false)
  })
})

describe('tray membership (MD-08, MD-09, MD-10, MD-14)', () => {
  const playing = mediaFromSnapshot(undefined, snap())

  it('joins when media plays in a background tab, never for the tab on screen', () => {
    expect(settleTray(playing, quiet, true, NOW).tray).toBe(false)
    const joined = settleTray(playing, quiet, false, NOW)
    expect(joined).toMatchObject({ tray: true, since: NOW })
  })

  it('stays while paused in the background so it can resume, and leaves when the media ends', () => {
    const inTray = settleTray(playing, quiet, false, NOW)
    const paused = settleTray({ ...inTray, playing: false }, quiet, false, NOW + 5)
    expect(paused.tray).toBe(true)
    expect(paused.since).toBe(NOW)
    expect(settleTray({ ...paused, ended: true }, quiet, false, NOW + 6).tray).toBe(false)
  })

  it('a tab paused before it was left does not join', () => {
    expect(settleTray({ ...playing, playing: false }, quiet, false, NOW).tray).toBe(false)
  })

  it('muted tabs, videos in picture-in-picture and closed controllers stay out', () => {
    expect(settleTray(playing, { muted: true, audible: false }, false, NOW).tray).toBe(false)
    expect(settleTray({ ...playing, pip: true }, quiet, false, NOW).tray).toBe(false)
    expect(settleTray({ ...playing, dismissed: true }, quiet, false, NOW).tray).toBe(false)
  })

  it('audio Orbit cannot control shows while the tab is audible, even very quietly', () => {
    const webAudio = { ...emptyMedia(), controllable: false }
    expect(settleTray(webAudio, { muted: false, audible: true }, false, NOW).tray).toBe(true)
    const inTray = settleTray(webAudio, { muted: false, audible: true }, false, NOW)
    expect(settleTray(inTray, quiet, false, NOW).tray).toBe(false)
  })

  it('a call in a background tab shows its controller (MD-14)', () => {
    const call = { ...emptyMedia(), mic: true }
    expect(settleTray(call, quiet, false, NOW).tray).toBe(true)
  })

  it('returns the same record when nothing changes', () => {
    const inTray = settleTray(playing, quiet, false, NOW)
    expect(settleTray(inTray, quiet, false, NOW + 10)).toBe(inTray)
  })

  it('lists tray tabs newest first', () => {
    const at = (since: number): TabMedia => ({ ...playing, tray: true, since })
    const state = {
      tabs: {
        't-a': tab('t-a', at(10)),
        't-b': tab('t-b', at(30)),
        't-c': tab('t-c', { ...playing, tray: false }),
        't-d': tab('t-d', at(20)),
        't-e': tab('t-e'),
      },
      windows: { 'w-1': { id: 'w-1', kind: 'normal', spaceId: 's-1' } },
      spaces: { 's-1': { id: 's-1', profileId: 'p-default' } },
    } as unknown as OrbitState
    expect(trayTabIds(state, 'w-1')).toEqual(['t-b', 't-d', 't-a'])
  })

  it('a window lists only tabs it may show: no private tab in a normal window, only its own in a private one', () => {
    const at = (since: number): TabMedia => ({ ...playing, tray: true, since })
    const state = {
      tabs: {
        't-a': tab('t-a', at(10)),
        't-p': tab('t-p', at(30), { spaceId: 's-p', profileId: 'private-1' }),
        't-q': tab('t-q', at(20), { spaceId: 's-q', profileId: 'private-2' }),
      },
      windows: {
        'w-1': { id: 'w-1', kind: 'normal', spaceId: 's-1' },
        'w-p': { id: 'w-p', kind: 'private', spaceId: 's-p' },
      },
      spaces: {
        's-1': { id: 's-1', profileId: 'p-default' },
        's-p': { id: 's-p', profileId: 'private-1' },
        's-q': { id: 's-q', profileId: 'private-2' },
      },
    } as unknown as OrbitState
    expect(trayTabIds(state, 'w-1')).toEqual(['t-a'])
    expect(trayTabIds(state, 'w-p')).toEqual(['t-p'])
  })

  it('titles come from the Media Session, then the tab', () => {
    expect(mediaTitle(tab('t-a', { ...playing, title: 'Song' }))).toBe('Song')
    expect(mediaTitle(tab('t-a', playing, { customTitle: 'Mine' }))).toBe('Mine')
    expect(mediaTitle(tab('t-a', playing))).toBe('Page t-a')
    expect(mediaSubtitle(tab('t-a', { ...playing, artist: 'Band' }))).toBe('Band')
    expect(mediaSubtitle(tab('t-a', playing))).toBe('music.example.com')
  })
})

describe('automatic picture-in-picture (MD-01, MD-08)', () => {
  const video = mediaFromSnapshot(undefined, snap({ video: true, pipCandidate: true }))

  it('opens for a playing, unmuted video when allowed', () => {
    expect(shouldAutoPip(settings(), tab('t-a', video), true, NOW)).toBe(true)
  })

  it('not for paused or muted videos, muted tabs, PiP already open, or the global switch off', () => {
    expect(shouldAutoPip(settings(), tab('t-a', video), false, NOW)).toBe(false)
    expect(shouldAutoPip(settings(), tab('t-a', video, { muted: true }), true, NOW)).toBe(false)
    expect(shouldAutoPip(settings(), tab('t-a', { ...video, pip: true }), true, NOW)).toBe(false)
    expect(shouldAutoPip(settings({ autoPip: false }), tab('t-a', video), true, NOW)).toBe(false)
    expect(shouldAutoPip(settings(), tab('t-a'), true, NOW)).toBe(false)
  })

  it('per-site choices: always off, off for today (until local midnight), back on', () => {
    const s = settings()
    const url = 'https://www.video.example.org/watch?v=1'
    expect(siteOf(url)).toBe('video.example.org')
    expect(sitePipMode(s, url, NOW)).toBe('on')

    applySitePip(s, url, 'today', NOW)
    expect(sitePipMode(s, url, NOW)).toBe('today')
    expect(autoPipAllowed(s, url, NOW)).toBe(false)
    expect(sitePipMode(s, url, endOfDay(NOW))).toBe('on')
    expect(endOfDay(NOW)).toBe(new Date(2026, 9, 10, 0, 0).getTime())

    applySitePip(s, url, 'always', NOW)
    expect(s.pipOffSites).toEqual(['video.example.org'])
    expect(s.pipSnoozed).toEqual({})
    expect(sitePipMode(s, 'https://video.example.org/other', NOW)).toBe('always')
    expect(autoPipAllowed(s, 'https://another.example.org/', NOW)).toBe(true)

    applySitePip(s, url, 'on', NOW)
    expect(sitePipMode(s, url, NOW)).toBe('on')
    expect(s.pipOffSites).toEqual([])
  })

  it('pages without a web origin have no site choice', () => {
    expect(siteOf('about:blank')).toBe('')
    expect(siteOf('file:///tmp/a.html')).toBe('')
    const s = settings()
    applySitePip(s, 'about:blank', 'always', NOW)
    expect(s.pipOffSites ?? []).toEqual([])
    expect(s.pipSnoozed ?? {}).toEqual({})
  })
})

describe('media and the tab lifecycle (MD-12)', () => {
  it('playing, muted-playing, picture-in-picture and camera/microphone tabs are busy', () => {
    const base = emptyMedia()
    expect(isMediaBusy(tab('t-a'))).toBe(false)
    expect(isMediaBusy(tab('t-a', base))).toBe(false)
    expect(isMediaBusy(tab('t-a', undefined, { audible: true }))).toBe(true)
    expect(isMediaBusy(tab('t-a', { ...base, playing: true }))).toBe(true)
    expect(isMediaBusy(tab('t-a', { ...base, active: true }))).toBe(true)
    expect(isMediaBusy(tab('t-a', { ...base, pip: true }))).toBe(true)
    expect(isMediaBusy(tab('t-a', { ...base, camera: true }))).toBe(true)
    expect(isMediaBusy(tab('t-a', { ...base, tray: true }))).toBe(false)
    expect(isMediaBusy(undefined)).toBe(false)
  })

  it('knows when anything plays (updates wait)', () => {
    const state = { tabs: { 't-a': tab('t-a'), 't-b': tab('t-b', { ...emptyMedia(), playing: true }) } }
    expect(isAnyMediaPlaying(state as unknown as OrbitState)).toBe(true)
    expect(isAnyMediaPlaying({ tabs: { 't-a': tab('t-a') } } as unknown as OrbitState)).toBe(false)
  })
})

describe('the floating player clock (MD-04)', () => {
  const at = 10_000

  it('[MD-04] moves on with the clock while playing, at the playback speed, and stops at the end', () => {
    const m = { position: 30, duration: 60, at }
    expect(currentPosition(m, at)).toBe(30)
    expect(currentPosition(m, at + 2000)).toBe(32)
    expect(currentPosition({ ...m, rate: 2 }, at + 2000)).toBe(34)
    expect(currentPosition(m, at + 600_000)).toBe(60)
    expect(currentPosition({ ...m, paused: true }, at + 2000)).toBe(30)
    // Live streams have no end; nothing reported yet means the start.
    expect(currentPosition({ position: 30, at }, at + 600_000)).toBe(630)
    expect(currentPosition({}, at)).toBe(0)
  })

  it('[MD-04] reads like a clock: 0:05, 1:05, 12:00, 1:02:03', () => {
    expect(formatClock(5.9)).toBe('0:05')
    expect(formatClock(65)).toBe('1:05')
    expect(formatClock(720)).toBe('12:00')
    expect(formatClock(3723)).toBe('1:02:03')
    expect(formatClock(-3)).toBe('0:00')
    expect(formatClock(Number.NaN)).toBe('0:00')
  })
})

describe('media settings read back from disk (MD-06, MD-08)', () => {
  it('[MD-08][MD-06] cleans site lists, drops snoozes that ran out and fixes the player placement', () => {
    const s = settings({
      pipOffSites: ['a.example', 'a.example', '', 7 as unknown as string, 'b.example'],
      pipSnoozed: { 'old.example': NOW - 1, 'today.example': NOW + 3600_000, 'bad.example': 'x' as unknown as number },
      pipPlacement: { corner: 'nowhere', size: 9 } as unknown as Settings['pipPlacement'],
    })
    normalizeMediaSettings(s, NOW)
    expect(s.pipOffSites).toEqual(['a.example', 'b.example'])
    expect(s.pipSnoozed).toEqual({ 'today.example': NOW + 3600_000 })
    expect(s.pipPlacement).toEqual({ corner: 'bottom-right', size: 200 })

    const broken = settings({
      pipOffSites: 'x' as unknown as string[],
      pipSnoozed: [] as unknown as Record<string, number>,
      pipPlacement: undefined,
    })
    normalizeMediaSettings(broken, NOW)
    expect(broken.pipOffSites).toEqual([])
    expect(broken.pipSnoozed).toEqual({})
    expect(broken.pipPlacement).toEqual({ corner: 'bottom-right', size: 320 })
  })
})
