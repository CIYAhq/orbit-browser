import {
  Ellipsis,
  Mic,
  MicOff,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  SquareArrowOutUpLeft,
  Video,
  VideoOff,
  X,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { currentPosition, formatClock, inCall } from '../../../shared/media'
import type { OrbitState, PipCorner, TabId, TabMedia } from '../../../shared/state'
import { invoke, orbit } from '../api'
import { useOrbit } from '../store'
import './pip.css'

/** Seconds per ← / → press when the player has focus (MD-05); the buttons skip 15 s (MD-04). */
const KEY_STEP = 5
const BUTTON_STEP = 15
/** A press becomes a move once the pointer travels this far (px). */
const DRAG_SLOP = 3
const CORNERS: PipCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']

function playerTab(s: OrbitState): TabId | null {
  for (const id in s.tabs) if (s.tabs[id]?.media?.player) return id
  return null
}

/**
 * The floating player's controls (media.md MD-03 to MD-06, MD-13), in a transparent view over the
 * borrowed page. With the pointer away only the video shows; hovering reveals the controls over a
 * soft gradient. Moving, resizing and hover-scrolling are reported to the main process, which
 * moves the window (it snaps to a corner on release).
 */
export function PipApp() {
  const tabId = useOrbit(playerTab)
  const tab = useOrbit((s) => (tabId ? s.tabs[tabId] : undefined))
  const media = tab?.media
  const [hover, setHover] = useState(false)
  // Play/pause answers at once; the page's next report (a new `at`) has the final say.
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const reported = media?.at
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on every new report from the page
  useEffect(() => setOptimistic(null), [reported])
  const drag = useRef<{ kind: 'move' | PipCorner; x: number; y: number; started: boolean } | null>(null)

  // The player appeared under a resting pointer and moved away from it (the enter motion): the
  // main process says so, as no pointer event may come (MD-03: video only until hovered).
  useEffect(() => {
    const away = () => {
      if (!drag.current) setHover(false)
    }
    window.addEventListener('orbit-pip-pointer-away', away)
    return () => window.removeEventListener('orbit-pip-pointer-away', away)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!tabId || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === ' ' || e.key === 'k') {
        e.preventDefault()
        void invoke('media.control', { tabId, action: 'toggle' })
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        void invoke('media.control', {
          tabId,
          action: 'seek',
          seconds: e.key === 'ArrowLeft' ? -KEY_STEP : KEY_STEP,
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tabId])

  if (!tabId || !tab || !media) return <div className="pip" data-testid="pip-empty" />

  const call = inCall(tab)
  const playing = optimistic ?? !media.paused
  const control = (action: 'play' | 'pause' | 'seek' | 'next' | 'previous', seconds?: number) =>
    void invoke('media.control', { tabId, action, seconds })
  const toggle = () => {
    setOptimistic(!playing)
    control(playing ? 'pause' : 'play')
  }

  const send = (phase: 'start' | 'move' | 'end', kind: 'move' | PipCorner, x: number, y: number) =>
    orbit.send('media.pipGesture', { phase, kind, x, y, t: Date.now() })

  const onPointerDown = (e: React.PointerEvent<HTMLElement>, kind: 'move' | PipCorner) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { kind, x: e.screenX, y: e.screenY, started: kind !== 'move' }
    if (kind !== 'move') send('start', kind, e.screenX, e.screenY)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d) return
    if (!d.started) {
      if (Math.hypot(e.screenX - d.x, e.screenY - d.y) < DRAG_SLOP) return
      d.started = true
      send('start', d.kind, d.x, d.y)
    }
    send('move', d.kind, e.screenX, e.screenY)
  }
  const onPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current
    drag.current = null
    if (d?.started) send('end', d.kind, e.screenX, e.screenY)
  }

  const onWheel = (e: React.WheelEvent<HTMLElement>) => {
    // The engine may end a scroll with an empty wheel event: nothing to move (or to interrupt).
    if (!e.deltaX && !e.deltaY) return
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 160 : 1
    // ⌘ + scroll, or a pinch (which arrives as a wheel with Ctrl), zooms into the video (MD-06).
    if (e.ctrlKey || e.metaKey) {
      void invoke('media.pipZoom', { factor: Math.exp((-e.deltaY * unit) / 200), x: e.clientX, y: e.clientY })
      return
    }
    // A two-finger scroll over the player slides it around (MD-06).
    orbit.send('media.pipGesture', { phase: 'wheel', x: e.deltaX * unit, y: e.deltaY * unit })
  }

  const live = !!media.live
  const duration = media.duration ?? 0

  return (
    <div
      className={`pip${hover ? ' is-hover' : ''}${call ? ' is-call' : ''}`}
      data-testid="pip"
      data-tab-id={tabId}
      data-playing={playing ? 'true' : 'false'}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => {
        if (!drag.current) setHover(false)
      }}
      onPointerDown={(e) => onPointerDown(e, 'move')}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={onPointerUp}
      onWheel={onWheel}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('button, .pip__progress')) return
        void invoke('media.pipBack', {})
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        void invoke('media.pipMenu', { x: e.clientX, y: e.clientY })
      }}
    >
      <div className="pip__shade" />
      <div className="pip__top">
        <PipButton
          label={call ? 'Back to call tab' : 'Back to tab'}
          testId="pip-back"
          onClick={() => void invoke('media.pipBack', {})}
        >
          <SquareArrowOutUpLeft size={15} />
        </PipButton>
        <span className="pip__spacer" />
        <PipButton
          label="More"
          testId="pip-more"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            void invoke('media.pipMenu', { x: r.left, y: r.bottom + 4 })
          }}
        >
          <Ellipsis size={16} />
        </PipButton>
        <PipButton label="Close" testId="pip-close" onClick={() => void invoke('media.pipClose', {})}>
          <X size={16} strokeWidth={2.2} />
        </PipButton>
      </div>
      <div className="pip__middle">
        {call ? (
          <>
            {media.mic && (
              <PipButton
                label={media.micMuted ? 'Turn microphone on' : 'Turn microphone off'}
                testId="pip-mic"
                big
                active={media.micMuted}
                onClick={() => void invoke('media.call', { tabId, action: 'mic' })}
              >
                {media.micMuted ? <MicOff size={18} /> : <Mic size={18} />}
              </PipButton>
            )}
            {media.camera && (
              <PipButton
                label={media.cameraOff ? 'Turn camera on' : 'Turn camera off'}
                testId="pip-camera"
                big
                active={media.cameraOff}
                onClick={() => void invoke('media.call', { tabId, action: 'camera' })}
              >
                {media.cameraOff ? <VideoOff size={18} /> : <Video size={18} />}
              </PipButton>
            )}
          </>
        ) : (
          <>
            {media.title && media.seekable && !live && (
              <PipButton label="Previous" testId="pip-previous" small onClick={() => control('previous')}>
                <SkipBack size={14} fill="currentColor" />
              </PipButton>
            )}
            {media.seekable && !live && (
              <PipButton
                label={`Back ${BUTTON_STEP} seconds`}
                testId="pip-back15"
                onClick={() => control('seek', -BUTTON_STEP)}
              >
                <Skip back />
              </PipButton>
            )}
            <PipButton label={playing ? 'Pause' : 'Play'} testId="pip-play" big onClick={toggle}>
              {playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
            </PipButton>
            {media.seekable && !live && (
              <PipButton
                label={`Forward ${BUTTON_STEP} seconds`}
                testId="pip-forward15"
                onClick={() => control('seek', BUTTON_STEP)}
              >
                <Skip />
              </PipButton>
            )}
            {media.title && media.seekable && !live && (
              <PipButton label="Next" testId="pip-next" small onClick={() => control('next')}>
                <SkipForward size={14} fill="currentColor" />
              </PipButton>
            )}
          </>
        )}
      </div>
      {!call && (
        <div className="pip__bottom">
          {live ? (
            <span className="pip__live" data-testid="pip-live">
              <span className="pip__live-dot" />
              LIVE
            </span>
          ) : (
            <Progress tabId={tabId} media={media} duration={duration} visible={hover} />
          )}
        </div>
      )}
      {CORNERS.map((corner) => (
        <div
          key={corner}
          className={`pip__handle pip__handle--${corner}`}
          data-testid={`pip-resize-${corner}`}
          onPointerDown={(e) => {
            e.stopPropagation()
            onPointerDown(e, corner)
          }}
        />
      ))}
    </div>
  )
}

/** ±15 s: a circular arrow with the step inside. */
function Skip({ back }: { back?: boolean }) {
  return (
    <span className="pip__skip">
      {back ? <RotateCcw size={20} /> : <RotateCw size={20} />}
      <span className="pip__skip-n">{BUTTON_STEP}</span>
    </span>
  )
}

/** Elapsed time, a seekable bar and the length (MD-04). The time runs on while playing. */
function Progress({
  tabId,
  media,
  duration,
  visible,
}: {
  tabId: TabId
  media: TabMedia
  duration: number
  visible: boolean
}) {
  const [now, setNow] = useState(() => Date.now())
  const [scrub, setScrub] = useState<number | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const running = visible && !media.paused
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [running])
  const position = scrub ?? currentPosition(media, now)
  const fraction = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0
  const at = (clientX: number) => {
    const r = barRef.current?.getBoundingClientRect()
    if (!r || r.width <= 0 || duration <= 0) return 0
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * duration
  }
  return (
    <div className="pip__progress-row">
      <span className="pip__time" data-testid="pip-elapsed">
        {formatClock(position)}
      </span>
      <div
        ref={barRef}
        className={`pip__progress${duration > 0 ? '' : ' is-unknown'}`}
        data-testid="pip-progress"
        role="slider"
        aria-label="Position"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(position)}
        tabIndex={-1}
        onPointerDown={(e) => {
          if (duration <= 0 || e.button !== 0) return
          e.stopPropagation()
          e.currentTarget.setPointerCapture(e.pointerId)
          setScrub(at(e.clientX))
        }}
        onPointerMove={(e) => {
          if (scrub === null) return
          e.stopPropagation()
          setScrub(at(e.clientX))
        }}
        onPointerUp={(e) => {
          if (scrub === null) return
          e.stopPropagation()
          const to = at(e.clientX)
          setScrub(null)
          setNow(Date.now())
          void invoke('media.control', { tabId, action: 'seekTo', seconds: to })
        }}
      >
        <div className="pip__progress-fill" style={{ transform: `scaleX(${fraction})` }} />
      </div>
      <span className="pip__time" data-testid="pip-duration">
        {duration > 0 ? formatClock(duration) : ''}
      </span>
    </div>
  )
}

function PipButton({
  label,
  testId,
  big,
  small,
  active,
  onClick,
  children,
}: {
  label: string
  testId: string
  big?: boolean
  small?: boolean
  active?: boolean
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className={`pip__btn${big ? ' pip__btn--big' : ''}${small ? ' pip__btn--small' : ''}${active ? ' is-on' : ''}`}
      aria-label={label}
      title={label}
      data-testid={testId}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
