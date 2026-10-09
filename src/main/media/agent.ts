/**
 * Orbit's media page script (media lane). It runs in an isolated world, so the page can't see or
 * change it, and only in tabs that started playing media (installed by MediaManager on
 * `media-started-playing` / audible). It watches the page's media elements with capture-phase
 * listeners (no timers, no polling) and reports changes through a long-poll: the main process
 * calls `__orbitMedia.next(v)`, which resolves with a fresh report when something changed after
 * report `v`. Commands (play, pause, seek, speed, picture-in-picture, call toggles) run here too.
 *
 * Orbit's floating player (MD-03, player.ts) borrows the tab's view. Here the chosen video is
 * lifted into the page's top layer (a manual popover) and drawn at the player's size at the
 * top-left of the page, over a black backdrop; the player window shows just that corner of the
 * view. The page's own layout doesn't change, so returning to the tab is seamless: the main
 * process makes the borrowed view a little taller than the page area, and the page's `resize`
 * when the view is placed back in its window puts the video back before that frame is drawn.
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
  const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi)

  // The media the controls act on: the video in Orbit's player; else playing first, then
  // audible, then the last one played, then the largest video.
  function main() {
    if (lift) return lift.v
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
          t.addEventListener('ended', () => bump())
        }
        if (!out.includes(t)) out.push(t)
      }
    }
    if (ask) refreshInputs()
    return out
  }

  // Playback of a media element, for the floating player's progress (MD-04).
  function timeOf(m) {
    if (!m) return null
    const d = m.duration
    const live = d === Infinity || (!!m.srcObject && !Number.isFinite(d))
    return {
      position: Number.isFinite(m.currentTime) ? m.currentTime : 0,
      duration: Number.isFinite(d) && d > 0 ? d : 0,
      rate: m.playbackRate || 1,
      paused: m.paused || m.ended,
      live,
      at: Date.now(),
    }
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
      pip: !!document.pictureInPictureElement || !!lift,
      player: !!lift,
      aspect: lift && frames(lift.v) ? lift.v.videoWidth / lift.v.videoHeight : 0,
      pipCandidate: !!pipVideo(),
      title,
      artist,
      seekable: !!(m && seekable(m)),
      ended: !!(m && m.ended),
      time: timeOf(m),
      pipEnd,
      mic: mics.length > 0,
      micMuted: mics.length > 0 && mics.every((t) => !t.enabled),
      camera: cams.length > 0,
      cameraOff: cams.length > 0 && cams.every((t) => !t.enabled),
    }
  }

  function bump(now) {
    version++
    if (!waiter) return
    if (now) {
      clearTimeout(timer)
      flush()
    } else if (!timer) timer = setTimeout(flush, 40)
  }
  function flush() {
    timer = 0
    const resolve = waiter
    waiter = null
    if (resolve) resolve(state())
  }

  const EVENTS = ['play', 'playing', 'pause', 'ended', 'emptied', 'loadedmetadata', 'durationchange', 'volumechange',
    'resize', 'enterpictureinpicture', 'seeked', 'ratechange', 'waiting']
  for (const type of EVENTS) {
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
      // Orbit's player closes first (main hides the window, then puts the video back).
      if (lift && e.target === lift.v && !lift.v.loop) endPip('ended')
    },
    true,
  )

  function endPip(reason) {
    pipEnd = { n: ++pipEnds, reason }
    bump(true)
  }

  // How the engine's own picture-in-picture ended (MD-07). Its × pauses a file-backed video right
  // after leaving and its "Back to tab" doesn't, which tells the two apart. × keeps the media
  // playing as audio (it then shows in the sidebar). A live stream can't tell them apart: treated as ×.
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

  // The engine's own picture-in-picture window, used while the tab stays on screen (MD-02).
  // auto: only the page's main playing, unmuted video (MD-01); otherwise any video with frames.
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

  // ---- Orbit's floating player (MD-03, MD-04, MD-06) ----

  const LIFT = 'data-orbit-pip'
  let lift = null
  let chosen = null
  let removal = null

  // The video to float: the one under a point (a context menu), the page's main playing video
  // (automatic), or else the main video with frames.
  function choose(o) {
    if (o && Number.isFinite(o.x) && Number.isFinite(o.y)) {
      const el = document.elementFromPoint(o.x, o.y)
      const v = el && (el.tagName === 'VIDEO' ? el : el.closest('video'))
      if (v && frames(v)) return v
    }
    const v = pipVideo()
    if (v || (o && o.auto)) return v
    const m = main()
    return m && frames(m) && !m.disablePictureInPicture ? m : null
  }

  // Picks the video and says where it is in the page (CSS px) and its shape; nothing changes yet.
  // A video in the engine's own picture-in-picture window moves over to Orbit's player.
  async function probe(o) {
    const was = document.pictureInPictureElement
    if (was) await exitPip()
    const v = lift ? lift.v : was && was.isConnected && frames(was) ? was : choose(o)
    chosen = v
    if (!v) return { ok: false }
    const r = v.getBoundingClientRect()
    const visible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
    return {
      ok: true,
      aspect: v.videoWidth / v.videoHeight,
      rect: visible ? { x: r.left, y: r.top, width: r.width, height: r.height } : null,
    }
  }

  function css() {
    const l = lift
    const t = l.ms > 0 ? 'width ' + l.ms + 'ms cubic-bezier(0.2,0.9,0.1,1),height ' + l.ms + 'ms cubic-bezier(0.2,0.9,0.1,1)' : 'none'
    const zoom = l.scale > 1 ? 'translate(' + l.tx + 'px,' + l.ty + 'px) scale(' + l.scale + ')' : 'none'
    return 'video[' + LIFT + ']{position:fixed!important;inset:0 auto auto 0!important;left:0!important;top:0!important;' +
      'width:' + l.w + 'px!important;height:' + l.h + 'px!important;min-width:0!important;min-height:0!important;' +
      'max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;' +
      'border-radius:0!important;box-sizing:border-box!important;background:#000!important;object-fit:contain!important;' +
      'object-position:50% 50%!important;opacity:1!important;visibility:visible!important;display:block!important;' +
      'clip-path:none!important;filter:none!important;mask:none!important;overflow:hidden!important;' +
      'transform-origin:0 0!important;transform:' + zoom + '!important;transition:' + t + '!important;' +
      'z-index:2147483647!important;pointer-events:none!important}' +
      'video[' + LIFT + ']::backdrop{background:#000!important}' +
      'video[' + LIFT + ']::-webkit-media-controls{display:none!important}'
  }

  function paint() {
    if (!lift) return
    const text = css()
    if (lift.sheet) lift.sheet.replaceSync(text)
    else if (lift.style) lift.style.textContent = text
  }

  // The video goes to the top layer at size 'from', then grows or shrinks to 'to' over ms
  // (the player window does the same, MD-16). arm: the page's size while it is in the player.
  // Nothing changes on screen until the page has that size: the tab may still be drawn in its
  // window for a frame or two after leaving it, and must look the same there.
  function liftVideo(o) {
    const v = lift ? lift.v : chosen
    if (!v || !v.isConnected) return false
    if (!lift) lift = { v, w: o.from.w, h: o.from.h, ms: 0, scale: 1, tx: 0, ty: 0, armW: 0, armH: 0, shown: false }
    if (o.arm) {
      lift.armW = o.arm.w
      lift.armH = o.arm.h
    }
    lift.w = o.from.w
    lift.h = o.from.h
    lift.ms = 0
    if (!lift.shown && (!lift.armW || armed())) show()
    paint()
    if (o.ms > 0 && (o.to.w !== o.from.w || o.to.h !== o.from.h)) {
      if (lift.shown) v.getBoundingClientRect()
      lift.ms = o.ms
    }
    lift.w = o.to.w
    lift.h = o.to.h
    paint()
    bump(true)
    return true
  }

  const armed = () => Math.abs(innerWidth - lift.armW) <= 2 && Math.abs(innerHeight - lift.armH) <= 2

  function show() {
    const l = lift
    const v = l.v
    l.shown = true
    l.popover = v.getAttribute('popover')
    try {
      l.sheet = new CSSStyleSheet()
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, l.sheet]
    } catch {
      l.sheet = null
      l.style = document.createElement('style')
      document.documentElement.appendChild(l.style)
    }
    v.setAttribute(LIFT, '')
    paint()
    if (v.popover !== 'manual') v.popover = 'manual'
    try {
      if (!v.matches(':popover-open')) v.showPopover()
    } catch {}
    watchRemoval(v)
  }

  // The player was resized (MD-06): the video follows at once; a zoomed crop keeps its place.
  function sizeVideo(wd, ht, ms) {
    if (!lift) return false
    const k = lift.w > 0 ? wd / lift.w : 1
    lift.tx *= k
    lift.ty *= k
    lift.w = wd
    lift.h = ht
    lift.ms = ms || 0
    clampZoom()
    paint()
    return true
  }

  function clampZoom() {
    const l = lift
    l.scale = clamp(l.scale, 1, 4)
    l.tx = clamp(l.tx, l.w * (1 - l.scale), 0)
    l.ty = clamp(l.ty, l.h * (1 - l.scale), 0)
  }

  // Zoom into the video around a point of the player (CSS px), cropping inside the same window (MD-06).
  function zoomVideo(factor, px, py) {
    if (!lift || !(factor > 0)) return 0
    const next = clamp(lift.scale * factor, 1, 4)
    const f = next / lift.scale
    lift.tx = px + f * (lift.tx - px)
    lift.ty = py + f * (lift.ty - py)
    lift.scale = next
    lift.ms = 0
    clampZoom()
    paint()
    return lift.scale
  }

  // Puts the video back in the page.
  function drop() {
    if (!lift) return false
    const l = lift
    lift = null
    chosen = null
    if (removal) removal.disconnect()
    removal = null
    if (!l.shown) {
      bump(true)
      return true
    }
    try {
      if (l.v.matches(':popover-open')) l.v.hidePopover()
    } catch {}
    if (l.popover === null) l.v.removeAttribute('popover')
    else l.v.setAttribute('popover', l.popover)
    l.v.removeAttribute(LIFT)
    if (l.sheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== l.sheet)
    if (l.style) l.style.remove()
    bump(true)
    return true
  }

  // A video removed from the page leaves the top layer at once: the player has to close (MD-07).
  function watchRemoval(v) {
    if (removal) removal.disconnect()
    removal = new MutationObserver(() => {
      if (lift && lift.v === v && !v.isConnected) endPip('gone')
    })
    removal.observe(document, { childList: true, subtree: true })
  }

  // In the player, the page takes the size it was armed with and the video lifts in that frame.
  // Back on screen, the size changes again and the video goes back into the page before that
  // frame is drawn (MD-01: no blank frame).
  window.addEventListener('resize', () => {
    if (!lift || !lift.armW) return
    if (!armed()) drop()
    else if (!lift.shown) show()
  }, true)

  // ---- Controls ----

  function control(action, value) {
    if (lift) return controlOne(lift.v, action, value)
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
    return m ? controlOne(m, action, value) : false
  }

  function controlOne(m, action, value) {
    const n = Number(value) || 0
    if (action === 'toggle') action = running(m) ? 'pause' : 'play'
    if (action === 'pause') {
      m.pause()
      return true
    }
    if (action === 'play') {
      if (m.ended) m.currentTime = 0
      m.play().catch(() => {})
      return true
    }
    if (action === 'rate') {
      if (!(n >= 0.25 && n <= 4)) return false
      m.playbackRate = n
      return true
    }
    if (!seekable(m)) return false
    if (action === 'seek') {
      m.currentTime = clamp(m.currentTime + n, 0, seekEnd(m))
      return true
    }
    if (action === 'seekTo') {
      m.currentTime = clamp(n, 0, seekEnd(m))
      return true
    }
    // Next: play to the end of the track, so the page moves on to its next one.
    if (action === 'next') {
      m.currentTime = seekEnd(m)
      return true
    }
    if (action === 'previous') {
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
    probe,
    lift: liftVideo,
    size: sizeVideo,
    zoom: zoomVideo,
    drop,
    lifted: () => !!lift,
  }
  return state()
})()`
