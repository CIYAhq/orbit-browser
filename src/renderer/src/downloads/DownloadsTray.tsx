import { ArrowDownToLine, Check, CircleAlert, Pause, Play, RotateCw, ShieldAlert, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { memo, type ReactNode, useEffect, useRef, useState } from 'react'
import type { DownloadStarted } from '../../../shared/commands/downloads'
import { isPrivateWindow } from '../../../shared/private'
import type { Download, OrbitState, ProfileId, WindowState } from '../../../shared/state'
import { invoke } from '../api'
import { SNAPPY, tween, useReducedMotion } from '../motion'
import { useOrbit, useOrbitShallow } from '../store'
import { dragOut } from './file-ui'
import { flyToLibrary } from './flight'
import { formatBytes, formatProgress, formatTimeLeft, percentDone, secondsLeft, smoothSpeed, splitName } from './format'
import './downloads.css'

const FADE = tween('quick')
/** Hovering this long opens the list of downloads; leaving it this long closes it. */
const OPEN_DELAY_MS = 150
const CLOSE_DELAY_MS = 250

/**
 * The downloads a window's sidebar shows, newest first (DL-16): a private window shows its own
 * session's only; another window all but a private session's, unless it shows that profile.
 */
function shownIds(s: OrbitState, profileId: ProfileId | undefined, privateWindow: boolean): string[] {
  // Started in the same millisecond: the later one (added last) first.
  return Object.values(s.downloads)
    .reverse()
    .filter((d) => d.profileId === profileId || (!privateWindow && !d.private))
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((d) => d.id)
}

/**
 * The sidebar's downloads row (DL-03), just above the bottom bar: the newest download with its
 * progress, bytes and time left, and a "+N" for the others; hovering (or clicking "+N") lists them
 * all. A finished download shows "done" for a few seconds, opens on click and drags out as the file
 * (DL-06); a failed one offers Resume or Retry; one held back as possibly harmful waits for Keep or
 * Discard (DL-12). Right-click: the download's menu (DL-04, DL-08, DL-15). With no downloads it
 * takes no room at all. Also plays the start animation (DL-02).
 */
export const DownloadsTray = memo(function DownloadsTray({ win }: { win: WindowState }) {
  const profileId = useOrbit((s) => s.spaces[win.spaceId]?.profileId)
  const privateWindow = useOrbit((s) => isPrivateWindow(s, win.id))
  const ids = useOrbitShallow((s) => shownIds(s, profileId, privateWindow))
  const reduce = useReducedMotion()
  const [hovered, setHovered] = useState(false)
  const [pinned, setPinned] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(
    () => window.orbit.on('downloads.started', (payload) => flyToLibrary((payload as DownloadStarted).filename)),
    [],
  )
  useEffect(() => () => clearTimeout(timer.current), [])
  const several = ids.length > 1
  useEffect(() => {
    if (!several) {
      setPinned(false)
      setHovered(false)
    }
  }, [several])

  const hover = (on: boolean) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setHovered(on), on ? OPEN_DELAY_MS : CLOSE_DELAY_MS)
  }
  const open = several && (hovered || pinned)
  // "+N" opens the list until clicked again (or closes it when hovering opened it).
  const toggle = () => {
    clearTimeout(timer.current)
    if (open) {
      setPinned(false)
      setHovered(false)
    } else {
      setPinned(true)
    }
  }
  const shown = open ? ids : ids.slice(0, 1)
  const variants = reduce
    ? {
        hidden: { opacity: 0, transition: FADE },
        shown: { opacity: 1, transition: FADE },
        exit: { opacity: 0, transition: FADE },
      }
    : {
        hidden: { opacity: 0, height: 0, y: 12 },
        shown: { opacity: 1, height: 'auto', y: 0, transition: SNAPPY },
        exit: { opacity: 0, height: 0, y: 12, transition: SNAPPY },
      }
  return (
    <section
      className={`downloads-tray${open ? ' is-open' : ''}`}
      data-testid="downloads-tray"
      data-count={ids.length}
      aria-label="Downloads"
      onPointerEnter={() => several && hover(true)}
      onPointerLeave={() => hover(false)}
    >
      <AnimatePresence initial={false}>
        {shown.map((id, index) => (
          <motion.div
            key={id}
            className="downloads-tray__slot"
            variants={variants}
            initial="hidden"
            animate="shown"
            exit="exit"
          >
            <DownloadRow id={id} more={index === 0 && several ? ids.length - 1 : 0} open={open} onMore={toggle} />
          </motion.div>
        ))}
      </AnimatePresence>
    </section>
  )
})

/** A download's speed, smoothed over the samples so far (a steadier time left). */
function useSmoothedSpeed(d: Download | undefined): number | undefined {
  const last = useRef<{ bytes: number; speed?: number }>({ bytes: -1 })
  if (d && d.state === 'progressing' && d.receivedBytes !== last.current.bytes) {
    const speed = d.speed !== undefined ? smoothSpeed(last.current.speed, d.speed) : last.current.speed
    last.current = { bytes: d.receivedBytes, ...(speed !== undefined ? { speed } : {}) }
  }
  return d?.state === 'progressing' ? last.current.speed : undefined
}

const DownloadRow = memo(function DownloadRow({
  id,
  more,
  open,
  onMore,
}: {
  id: string
  more: number
  open: boolean
  onMore: () => void
}) {
  const d = useOrbit((s) => s.downloads[id])
  const speed = useSmoothedSpeed(d)
  if (!d) return null
  const { state } = d
  const held = state === 'completed' && !!d.danger
  const done = state === 'completed' && !held
  const failed = state === 'interrupted'
  const pct = percentDone(d.receivedBytes, d.totalBytes)
  const left = state === 'progressing' ? secondsLeft(d.receivedBytes, d.totalBytes, speed) : undefined
  const meta = held
    ? 'Can harm your computer'
    : done
      ? `Done · ${formatBytes(d.totalBytes || d.receivedBytes)}`
      : state === 'paused'
        ? `Paused · ${formatProgress(d.receivedBytes, d.totalBytes)}`
        : failed
          ? d.canResume
            ? `Failed · ${formatProgress(d.receivedBytes, d.totalBytes)}`
            : 'Failed'
          : `${formatProgress(d.receivedBytes, d.totalBytes)}${left !== undefined ? ` · ${formatTimeLeft(left)}` : ''}`
  const name = splitName(d.filename)
  const icon = held ? (
    <ShieldAlert size={14} />
  ) : done ? (
    <Check size={14} />
  ) : failed ? (
    <CircleAlert size={14} />
  ) : state === 'paused' ? (
    <Pause size={13} />
  ) : (
    <ArrowDownToLine size={14} />
  )
  const body = (
    <>
      <span className="dl-row__icon">{icon}</span>
      <span className="dl-row__text">
        <span className="dl-row__name" data-testid="download-name">
          {name.head && <span className="dl-row__head">{name.head}</span>}
          <span className="dl-row__tail">{name.tail}</span>
        </span>
        <span className="dl-row__meta" data-testid="download-meta">
          {meta}
        </span>
      </span>
    </>
  )
  return (
    <div
      className={`dl-row is-${state}${held ? ' is-held' : ''}`}
      data-testid="download-row"
      data-id={id}
      data-state={state}
      title={d.filename}
      onContextMenu={(e) => {
        e.preventDefault()
        void invoke('downloads.menu', { id })
      }}
    >
      {done ? (
        <button
          type="button"
          className="dl-row__main"
          data-testid="download-open"
          aria-label={`Open ${d.filename}`}
          draggable
          onDragStart={(e) => void dragOut(e, id)}
          onClick={() => void invoke('downloads.open', { id })}
        >
          {body}
        </button>
      ) : (
        <div className="dl-row__main">{body}</div>
      )}
      <div className="dl-row__buttons">
        {more > 0 && (
          <button
            type="button"
            className="dl-row__more"
            data-testid="downloads-more"
            aria-expanded={open}
            aria-label={`${more} more ${more === 1 ? 'download' : 'downloads'}`}
            onClick={onMore}
          >
            +{more}
          </button>
        )}
        {held && (
          <>
            <button
              type="button"
              className="dl-row__choice"
              data-testid="download-keep"
              onClick={() => void invoke('downloads.keep', { id })}
            >
              Keep
            </button>
            <button
              type="button"
              className="dl-row__choice"
              data-testid="download-discard"
              onClick={() => void invoke('downloads.discard', { id })}
            >
              Discard
            </button>
          </>
        )}
        {state === 'paused' && (
          <RowButton label="Resume" testId="download-resume" onClick={() => void invoke('downloads.resume', { id })}>
            <Play size={13} />
          </RowButton>
        )}
        {failed &&
          (d.canResume ? (
            <RowButton
              label="Resume"
              testId="download-resume"
              onClick={() =>
                void invoke('downloads.resume', { id }).then((ok) => {
                  if (!ok) void invoke('downloads.retry', { id })
                })
              }
            >
              <Play size={13} />
            </RowButton>
          ) : (
            <RowButton label="Retry" testId="download-retry" onClick={() => void invoke('downloads.retry', { id })}>
              <RotateCw size={13} />
            </RowButton>
          ))}
        {(state === 'progressing' || state === 'paused') && (
          <RowButton label="Cancel" testId="download-cancel" onClick={() => void invoke('downloads.cancel', { id })}>
            <X size={14} />
          </RowButton>
        )}
        {failed && (
          <RowButton label="Dismiss" testId="download-dismiss" onClick={() => void invoke('downloads.dismiss', { id })}>
            <X size={14} />
          </RowButton>
        )}
      </div>
      {!done && !held && (
        <div
          className={`dl-row__bar${pct === undefined ? ' is-indeterminate' : ''}`}
          data-testid="download-progress"
          role="progressbar"
          aria-label={`${d.filename} progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          {...(pct !== undefined ? { 'aria-valuenow': Math.round(pct) } : {})}
        >
          <span className="dl-row__fill" style={pct !== undefined ? { width: `${pct}%` } : undefined} />
        </div>
      )}
    </div>
  )
})

function RowButton({
  label,
  testId,
  onClick,
  children,
}: {
  label: string
  testId: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="dl-row__btn"
      data-testid={testId}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {children}
    </button>
  )
}
