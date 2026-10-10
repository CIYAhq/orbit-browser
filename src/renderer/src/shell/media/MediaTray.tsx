import { Mic, MicOff, Pause, PictureInPicture2, Play, SkipBack, SkipForward, Video, VideoOff, X } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  type CSSProperties,
  memo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { inCall, mediaSubtitle, mediaTitle, trayTabIds } from '../../../../shared/media'
import type { TabId } from '../../../../shared/state'
import { invoke } from '../../api'
import { useOrbit, useOrbitShallow } from '../../store'
import { Favicon } from '../../ui/Favicon'
import { QUICK_EASE, SNAPPY } from '../sidebar/motion-tokens'
import './media.css'

/**
 * Controllers whose video was just sent to the floating player: the player grows out of the
 * controller (MD-10, MD-16), so the controller gives way at once instead of sliding down.
 */
const toPlayer = new Set<TabId>()

const FADE = { duration: 0.12, ease: QUICK_EASE }

/**
 * The sidebar media tray (MD-09, MD-10, MD-14; sidebar.md SB-10): one controller per tab playing
 * in the background, newest on top, just above the bottom bar. It slides up when a playing tab is
 * left and down when it goes (FL-32, MD-16); with reduced motion it only fades.
 */
export const MediaTray = memo(function MediaTray() {
  const ids = useOrbitShallow(trayTabIds)
  const reduce = useReducedMotion()
  const variants = reduce
    ? {
        hidden: { opacity: 0, transition: FADE },
        shown: { opacity: 1, transition: FADE },
        exit: { opacity: 0, transition: FADE },
      }
    : {
        hidden: { opacity: 0, height: 0, y: 16 },
        shown: { opacity: 1, height: 'auto', y: 0, transition: SNAPPY },
        exit: (id: TabId) =>
          toPlayer.has(id)
            ? // Gone at once where the player takes over, then the tray closes the gap.
              { opacity: 0, height: 0, transition: { opacity: { duration: 0.06 }, height: { ...SNAPPY, delay: 0.08 } } }
            : { opacity: 0, height: 0, y: 16, transition: SNAPPY },
      }
  return (
    <section className="media-tray" data-testid="media-tray" aria-label="Media">
      <AnimatePresence initial={false}>
        {ids.map((id) => (
          <motion.div
            key={id}
            className="media-tray__slot"
            custom={id}
            variants={variants}
            initial="hidden"
            animate="shown"
            exit="exit"
          >
            <MediaController tabId={id} />
          </motion.div>
        ))}
      </AnimatePresence>
    </section>
  )
})

/** One background tab's controls: source (click to go there), play/pause, next, PiP, close. */
const MediaController = memo(function MediaController({ tabId }: { tabId: TabId }) {
  const tab = useOrbit((s) => s.tabs[tabId])
  const media = tab?.media
  // Controls answer at once: the icon flips on click, before the page confirms (MD-16).
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const confirmed = media?.playing
  useEffect(() => {
    if (confirmed !== undefined) setOptimistic(null)
  }, [confirmed])
  if (!tab || !media) return null
  const playing = optimistic ?? media.playing
  const call = inCall(tab)
  const toggle = () => {
    setOptimistic(!playing)
    void invoke('media.control', { tabId, action: playing ? 'pause' : 'play' })
  }
  return (
    <div
      className={`media-ctl${playing ? ' is-playing' : ''}${call ? ' is-call' : ''}`}
      data-testid="media-controller"
      data-tab-id={tabId}
      data-playing={playing ? 'true' : 'false'}
      onContextMenu={(e) => {
        e.preventDefault()
        void invoke('media.menu', { tabId })
      }}
    >
      <button
        type="button"
        className="media-ctl__source"
        data-testid="media-source"
        title="Go to tab"
        onClick={() => void invoke('media.focus', { tabId })}
      >
        <span className="media-ctl__icon">
          {tab.icon ? <span className="media-ctl__emoji">{tab.icon}</span> : <Favicon src={tab.favicon} size={16} />}
        </span>
        <span className="media-ctl__text">
          <Marquee text={mediaTitle(tab)} />
          <span className="media-ctl__sub">{mediaSubtitle(tab)}</span>
        </span>
      </button>
      <div className="media-ctl__buttons">
        {call && (
          <>
            {media.mic && (
              <CtlButton
                label={media.micMuted ? 'Turn microphone on' : 'Turn microphone off'}
                testId="media-mic"
                active={media.micMuted}
                onClick={() => void invoke('media.call', { tabId, action: 'mic' })}
              >
                {media.micMuted ? <MicOff size={14} /> : <Mic size={14} />}
              </CtlButton>
            )}
            {media.camera && (
              <CtlButton
                label={media.cameraOff ? 'Turn camera on' : 'Turn camera off'}
                testId="media-camera"
                active={media.cameraOff}
                onClick={() => void invoke('media.call', { tabId, action: 'camera' })}
              >
                {media.cameraOff ? <VideoOff size={14} /> : <Video size={14} />}
              </CtlButton>
            )}
          </>
        )}
        {media.controllable && !call && media.seekable && media.title && (
          <CtlButton
            label="Previous"
            testId="media-previous"
            className="media-ctl__hover"
            onClick={() => void invoke('media.control', { tabId, action: 'previous' })}
          >
            <SkipBack size={13} fill="currentColor" />
          </CtlButton>
        )}
        {media.controllable && (
          <CtlButton label={playing ? 'Pause' : 'Play'} testId="media-play" onClick={toggle}>
            {playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
          </CtlButton>
        )}
        {media.controllable && !call && media.seekable && (
          <CtlButton
            label="Next"
            testId="media-next"
            onClick={() => void invoke('media.control', { tabId, action: 'next' })}
          >
            <SkipForward size={13} fill="currentColor" />
          </CtlButton>
        )}
        {media.video && !call && (
          <CtlButton
            label="Picture in Picture"
            testId="media-pip"
            onClick={(e) => {
              // "Back to PiP" (MD-10): the player grows out of this controller (MD-16).
              const r = (e.currentTarget.closest('.media-ctl') ?? e.currentTarget).getBoundingClientRect()
              toPlayer.add(tabId)
              setTimeout(() => toPlayer.delete(tabId), 1000)
              void invoke('media.pip', { tabId, on: true, from: { x: r.x, y: r.y, width: r.width, height: r.height } })
            }}
          >
            <PictureInPicture2 size={14} />
          </CtlButton>
        )}
        <CtlButton
          label={media.controllable ? 'Pause and close' : 'Close'}
          testId="media-close"
          className="media-ctl__hover"
          onClick={() => void invoke('media.dismiss', { tabId })}
        >
          <X size={13} strokeWidth={2.2} />
        </CtlButton>
      </div>
    </div>
  )
})

function CtlButton({
  label,
  testId,
  className,
  active,
  onClick,
  children,
}: {
  label: string
  testId: string
  className?: string
  active?: boolean
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className={`media-ctl__btn${className ? ` ${className}` : ''}${active ? ' is-on' : ''}`}
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/** A title that slowly scrolls back and forth when it doesn't fit (MD-09); still with reduced motion. */
function Marquee({ text }: { text: string }) {
  const boxRef = useRef<HTMLSpanElement>(null)
  const innerRef = useRef<HTMLSpanElement>(null)
  const [shift, setShift] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the text changes
  useLayoutEffect(() => {
    const box = boxRef.current
    const inner = innerRef.current
    if (!box || !inner) return
    const measure = () => setShift(Math.max(0, Math.ceil(inner.scrollWidth - box.clientWidth)))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    return () => observer.disconnect()
  }, [text])
  const style =
    shift > 0
      ? ({ '--marquee-shift': `-${shift}px`, '--marquee-time': `${Math.max(6, shift / 18 + 4)}s` } as CSSProperties)
      : undefined
  return (
    <span
      ref={boxRef}
      className={`media-ctl__title${shift > 0 ? ' is-scrolling' : ''}`}
      data-testid="media-title"
      title={text}
    >
      <span ref={innerRef} className="media-ctl__title-inner" style={style}>
        {text}
      </span>
    </span>
  )
}
