/**
 * Orbit's media page script (media lane). It runs in an isolated world, so the page can't see or
 * change it, and only in tabs that started playing media (installed by MediaManager on
 * `media-started-playing` / audible). It watches the page's media elements with capture-phase
 * listeners (no timers, no polling) and reports changes through a long-poll: the main process
 * calls `__orbitMedia.next(v)`, which resolves with a fresh report when something changed after
 * report `v`. Commands (play, pause, seek, picture-in-picture, call toggles) run here too.
 *
 * Reports follow `AgentSnapshot` in src/shared/media.ts.
 */

/** Isolated world for the media script (the tabs runtime uses 999, the fullscreen fix 1001). */
export const MEDIA_WORLD = 1010

/** Installs the script once per document; returns the first report either way. */
export const AGENT_SOURCE = `(() => {
  const w = window
  if (w.__orbitMedia) return w.__orbitMedia.state()
  let version = 1
  let waiter = null
  let timer = 0
  let lastPlayed = null
  let pausedByOrbit = []
  let orbitExit = false
  let pipEnd = null
  let pipEnds = 0
  const watchedTracks = new WeakSet()

  const list = () => Array.from(document.querySelectorAll('video, audio'))
  const running = (m) => !m.paused && !m.ended
  const unmuted = (m) => !m.muted && m.volume > 0
  const frames = (m) => m.tagName === 'VIDEO' && m.videoWidth > 0 && m.videoHeight > 0
  const area = (m) => {
    const r = m.getBoundingClientRect()
    return r.width * r.height
  }
  const seekable = (m) => Number.isFinite(m.duration) && m.duration > 0 && m.seekable.length > 0
  const seekEnd = (m) => Math.min(m.duration, m.seekable.end(m.seekable.length - 1))

  // The media the controls act on: playing first, then audible, then the last one played,
  // then the largest video.
  function main() {
    let best = null
    let bestScore = -1
    for (const m of list()) {
      const started = running(m) || m === lastPlayed || (m.currentTime > 0 && !m.ended)
      if (!started) continue
      let s = 0
      if (running(m)) s += 8
      if (unmuted(m)) s += 4
      if (m === lastPlayed) s += 2
      if (frames(m)) s += 1 + (Math.min(area(m), 4e6) / 4e6) * 0.9
      if (s > bestScore) {
        best = m
        bestScore = s
      }
    }
    return best
  }

  // The page's main video for automatic picture-in-picture (MD-01): the largest playing, unmuted,
  // visible video. Muted decorative loops and hidden players don't count. In a call (the page
  // uses the camera or microphone), the largest participant video counts even when muted (call
  // apps often play voices through separate audio elements), never the self view (MD-13).
  function pipVideo() {
    const inCall = localTracks().length > 0
    let best = null
    let bestArea = 64 * 36 - 1
    for (const m of list()) {
      if (m.tagName !== 'VIDEO' || !running(m) || !frames(m) || m.disablePictureInPicture) continue
      if (!unmuted(m) && !(inCall && remoteVideo(m))) continue
      const a = area(m)
      if (a > bestArea) {
        best = m
        bestArea = a
      }
    }
    return best
  }

  // A video showing a stream from elsewhere (a call participant), not this device's camera.
  function remoteVideo(m) {
    const s = m.srcObject
    if (!s || typeof s.getVideoTracks !== 'function') return false
    const tracks = s.getVideoTracks()
    return tracks.length > 0 && tracks.every((t) => {
      let device = ''
      try {
        device = t.getSettings().deviceId || ''
      } catch {}
      return !inputs.has(device)
    })
  }

  // The system's camera and microphone inputs. A page's own canvas or Web Audio streams have
  // device ids too, so a track counts as the camera or microphone only if its device is one of these.
  let inputs = new Set()
  const askedAbout = new Set()
  let enumerating = false
  function refreshInputs() {
    if (enumerating || !navigator.mediaDevices) return
    enumerating = true
    navigator.mediaDevices.enumerateDevices().then(
      (list) => {
        enumerating = false
        const ids = list.filter((d) => d.kind === 'audioinput' || d.kind === 'videoinput').map((d) => d.deviceId)
        inputs = new Set(ids.filter(Boolean))
        bump()
      },
      () => {
        enumerating = false
      },
    )
  }
  if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', refreshInputs)

  // Live camera and microphone tracks the page shows (a call's self view), best effort (MD-11).
  function localTracks() {
    const out = []
    let ask = false
    for (const m of list()) {
      const s = m.srcObject
      if (!s || typeof s.getTracks !== 'function') continue
      for (const t of s.getTracks()) {
        if (t.readyState !== 'live') continue
        let device = ''
        try {
          device = t.getSettings().deviceId || ''
        } catch {}
        if (!device) continue
        if (!inputs.has(device)) {
          // Look the device up once (a canvas or Web Audio stream never matches).
          if (!askedAbout.has(device)) {
            askedAbout.add(device)
            ask = true
          }
          continue
        }
        if (!watchedTracks.has(t)) {
          watchedTracks.add(t)
          t.addEventListener('ended', bump)
        }
        if (!out.includes(t)) out.push(t)
      }
    }
    if (ask) refreshInputs()
    return out
  }

  function state() {
    const m = main()
    let playing = false
    let active = false
    for (const x of list()) {
      if (!running(x)) continue
      active = true
      if (unmuted(x)) playing = true
    }
    let title = ''
    let artist = ''
    try {
      const md = navigator.mediaSession && navigator.mediaSession.metadata
      if (md) {
        title = String(md.title || '').slice(0, 200)
        artist = String(md.artist || '').slice(0, 200)
      }
    } catch {}
    const tracks = localTracks()
    const mics = tracks.filter((t) => t.kind === 'audio')
    const cams = tracks.filter((t) => t.kind === 'video')
    return {
      v: version,
      playing,
      active,
      controllable: !!m,
      video: !!(m && frames(m)),
      pip: !!document.pictureInPictureElement,
      pipCandidate: !!pipVideo(),
      title,
      artist,
      seekable: !!(m && seekable(m)),
      ended: !!(m && m.ended),
      pipEnd,
      mic: mics.length > 0,
      micMuted: mics.length > 0 && mics.every((t) => !t.enabled),
      camera: cams.length > 0,
      cameraOff: cams.length > 0 && cams.every((t) => !t.enabled),
    }
  }

  function bump() {
    version++
    if (waiter && !timer) timer = setTimeout(flush, 40)
  }
  function flush() {
    timer = 0
    const resolve = waiter
    waiter = null
    if (resolve) resolve(state())
  }

  for (const type of ['play', 'playing', 'pause', 'ended', 'emptied', 'loadedmetadata', 'durationchange', 'volumechange', 'resize', 'enterpictureinpicture']) {
    document.addEventListener(
      type,
      (e) => {
        if (type === 'play' && e.target instanceof HTMLMediaElement) lastPlayed = e.target
        bump()
        // Track details (Media Session) often follow a track change by a moment.
        if (type === 'loadedmetadata' || type === 'play') setTimeout(bump, 1000)
      },
      true,
    )
  }

  // A finished video leaves picture-in-picture and doesn't replay (MD-07).
  document.addEventListener(
    'ended',
    (e) => {
      if (e.target === document.pictureInPictureElement && !e.target.loop) exitPip()
    },
    true,
  )

  function endPip(reason) {
    pipEnd = { n: ++pipEnds, reason }
    bump()
  }

  // How picture-in-picture ended (MD-07). The engine's × pauses a file-backed video right after
  // leaving and its "Back to tab" doesn't, which tells the two apart. × keeps the media playing
  // as audio (it then shows in the sidebar). A live stream can't tell them apart: treated as ×.
  document.addEventListener(
    'leavepictureinpicture',
    (e) => {
      const v = e.target
      if (orbitExit) {
        orbitExit = false
        endPip('orbit')
        return
      }
      if (v.ended) return endPip('ended')
      if (v.paused || v.srcObject) return endPip('close')
      let done = false
      const onPause = () => {
        if (done) return
        done = true
        clearTimeout(timeout)
        v.play().catch(() => {})
        endPip('close')
      }
      const timeout = setTimeout(() => {
        if (done) return
        done = true
        v.removeEventListener('pause', onPause)
        endPip('back')
      }, 300)
      v.addEventListener('pause', onPause, { once: true })
    },
    true,
  )

  async function exitPip() {
    if (!document.pictureInPictureElement) return false
    orbitExit = true
    try {
      await document.exitPictureInPicture()
    } catch {
      orbitExit = false
    }
    return false
  }

  // auto: only the page's main playing, unmuted video (MD-01); otherwise any video with frames (MD-02).
  async function pip(on, auto) {
    if (!on) return exitPip()
    const m = main()
    const v = pipVideo() || (!auto && m && frames(m) && !m.disablePictureInPicture ? m : null)
    if (!v) return false
    if (document.pictureInPictureElement === v) return true
    try {
      await v.requestPictureInPicture()
      return true
    } catch {
      return false
    }
  }

  function control(action, seconds) {
    const all = list()
    if (action === 'pause' || (action === 'toggle' && all.some(running))) {
      pausedByOrbit = all.filter(running)
      for (const x of pausedByOrbit) x.pause()
      return pausedByOrbit.length > 0
    }
    const m = main()
    if (action === 'play' || action === 'toggle') {
      const again = pausedByOrbit.filter((x) => x.isConnected)
      pausedByOrbit = []
      const targets = again.length > 0 ? again : m ? [m] : []
      for (const x of targets) x.play().catch(() => {})
      return targets.length > 0
    }
    if (!m) return false
    if (action === 'seek' && seekable(m)) {
      m.currentTime = Math.min(Math.max(m.currentTime + (Number(seconds) || 0), 0), seekEnd(m))
      return true
    }
    // Next: play to the end of the track, so the page moves on to its next one.
    if (action === 'next' && seekable(m)) {
      m.currentTime = seekEnd(m)
      return true
    }
    if (action === 'previous' && seekable(m)) {
      m.currentTime = 0
      if (m.paused) m.play().catch(() => {})
      return true
    }
    return false
  }

  // Call controls (MD-14): turn the page's own camera or microphone tracks off or on again.
  function call(action) {
    const kind = action === 'mic' ? 'audio' : action === 'camera' ? 'video' : ''
    const tracks = localTracks().filter((t) => t.kind === kind)
    if (tracks.length === 0) return false
    const enable = tracks.every((t) => !t.enabled)
    for (const t of tracks) t.enabled = enable
    bump()
    return true
  }

  w.__orbitMedia = {
    state,
    refresh: bump,
    next(v) {
      if (v !== version) return state()
      // One waiting report per document: an older loop (say, from before a restart) ends.
      if (waiter) waiter(null)
      return new Promise((resolve) => {
        waiter = resolve
      })
    },
    control,
    pip,
    call,
  }
  return state()
})()`
