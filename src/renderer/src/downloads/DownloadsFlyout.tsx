import { FolderOpen, Play, RotateCw, ShieldAlert, X } from 'lucide-react'
import { m, useIsPresent } from 'motion/react'
import { type KeyboardEvent, memo, type ReactNode, useEffect, useRef, useState } from 'react'
import type { DownloadEntry } from '../../../shared/commands/downloads'
import { invoke, isMac } from '../api'
import { POPOVER, SNAPPY } from '../motion'
import { useOrbit, useWindow } from '../store'
import { usePalette } from '../theme'
import { resumeOrRetry, useDownloadsList, useLiveEntry } from './data'
import { dragOut, FileThumb } from './file-ui'
import { percentDone, statusText } from './format'
import './downloads-library.css'

/** How many of the newest downloads the flyout lists. */
const FLYOUT_LIMIT = 12

const close = () => void invoke('overlay.close', {})

const FlyoutRow = memo(function FlyoutRow({ entry, highlighted }: { entry: DownloadEntry; highlighted: boolean }) {
  const d = useLiveEntry(entry)
  const { id, state } = d
  const held = state === 'completed' && !!d.danger && !d.missing
  const openable = state === 'completed' && !d.missing && !d.danger
  const running = state === 'progressing' || state === 'paused'
  const pct = running ? percentDone(d.receivedBytes, d.totalBytes) : undefined
  const open = () => {
    if (!openable) return
    close()
    void invoke('downloads.open', { id })
  }
  return (
    <div
      className={`dl-flyout__row is-${state}${held ? ' is-held' : ''}${d.missing ? ' is-missing' : ''}${
        highlighted ? ' is-highlighted' : ''
      }`}
      role="option"
      aria-selected={highlighted}
      data-testid="flyout-download"
      data-id={id}
      data-state={state}
      title={d.filename}
      draggable={openable}
      onDragStart={(e) => {
        // The flyout makes way once the OS has the file, so the page under it can take the drop.
        void dragOut(e, id).finally(close)
      }}
      onClick={open}
      onContextMenu={(e) => {
        e.preventDefault()
        void invoke('downloads.menu', { id })
      }}
    >
      <span className="dl-flyout__icon">
        {held ? <ShieldAlert size={16} /> : <FileThumb name={d.filename} url={d.fileUrl} size={24} />}
      </span>
      <span className="dl-flyout__text">
        <span className="dl-flyout__name" data-testid="flyout-download-name">
          {d.filename}
        </span>
        <span className="dl-flyout__meta" data-testid="flyout-download-status">
          {statusText(d)}
        </span>
        {running && (
          <span className={`dl-lib-row__bar dl-flyout__bar${pct === undefined ? ' is-indeterminate' : ''}`} aria-hidden>
            <span className="dl-lib-row__fill" style={pct !== undefined ? { width: `${pct}%` } : undefined} />
          </span>
        )}
      </span>
      <span className="dl-flyout__actions">
        {held && (
          <>
            <button
              type="button"
              className="dl-lib-row__text-btn"
              data-testid="flyout-download-keep"
              onClick={(e) => {
                e.stopPropagation()
                void invoke('downloads.keep', { id })
              }}
            >
              Keep
            </button>
            <button
              type="button"
              className="dl-lib-row__text-btn"
              data-testid="flyout-download-discard"
              onClick={(e) => {
                e.stopPropagation()
                void invoke('downloads.discard', { id })
              }}
            >
              Discard
            </button>
          </>
        )}
        {(state === 'paused' || (state === 'interrupted' && d.canResume)) && (
          <FlyoutButton label="Resume" testId="flyout-download-resume" onClick={() => resumeOrRetry(id)}>
            <Play size={14} />
          </FlyoutButton>
        )}
        {state === 'interrupted' && !d.canResume && (
          <FlyoutButton
            label="Retry"
            testId="flyout-download-retry"
            onClick={() => void invoke('downloads.retry', { id })}
          >
            <RotateCw size={14} />
          </FlyoutButton>
        )}
        {running && (
          <FlyoutButton
            label="Cancel"
            testId="flyout-download-cancel"
            onClick={() => void invoke('downloads.cancel', { id })}
          >
            <X size={14} />
          </FlyoutButton>
        )}
        {openable && (
          <FlyoutButton
            label={isMac ? 'Show in Finder' : 'Show in Folder'}
            testId="flyout-download-show"
            onClick={() => void invoke('downloads.showInFolder', { id })}
          >
            <FolderOpen size={14} />
          </FlyoutButton>
        )}
      </span>
    </div>
  )
})

function FlyoutButton({
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
      className="dl-lib-row__btn"
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {children}
    </button>
  )
}

/**
 * The downloads flyout (DL-14): Ctrl+J on Windows and Linux opens it over the window's top left,
 * beside the sidebar. It lists the newest downloads with their progress; a finished one opens on
 * click, shows in its folder, and drags out as the file (DL-06). "Show All" opens the Library's
 * Downloads section. Esc, Ctrl+J again or a click outside closes it.
 */
export function DownloadsFlyout() {
  const win = useWindow()
  const profileId = useOrbit((s) => (win ? s.spaces[win.spaceId]?.profileId : undefined)) ?? ''
  const dark = usePalette(win?.spaceId)?.dark
  const entries = useDownloadsList(profileId, 0, FLYOUT_LIMIT)
  const [highlight, setHighlight] = useState(-1)
  const ref = useRef<HTMLDivElement>(null)
  // One going away (Esc, then Ctrl+J at once) fades out under the new one: it takes no clicks.
  const present = useIsPresent()
  useEffect(() => ref.current?.focus(), [])

  const list = entries ?? []
  const left = win && (win.sidebar.visible || win.sidebar.peeking) ? win.sidebar.width + 8 : 8
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (list.length === 0) return
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setHighlight((h) => Math.max(0, Math.min(list.length - 1, (h < 0 && step < 0 ? list.length : h) + step)))
      return
    }
    if (e.key === 'Enter') {
      const d = list[highlight]
      if (d?.state !== 'completed' || d.missing || d.danger) return
      e.preventDefault()
      close()
      void invoke('downloads.open', { id: d.id })
    }
  }
  return (
    <m.div
      ref={ref}
      className="dl-flyout"
      data-testid={present ? 'downloads-flyout' : undefined}
      data-dark={dark ? 'true' : 'false'}
      role="dialog"
      aria-label="Downloads"
      aria-hidden={present ? undefined : true}
      tabIndex={-1}
      style={{ left, pointerEvents: present ? undefined : 'none' }}
      initial={{ opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: SNAPPY }}
      exit={{ opacity: 0, y: -4, scale: 0.98, transition: POPOVER.out }}
      onKeyDown={onKeyDown}
    >
      <header className="dl-flyout__header">
        <span className="dl-flyout__title">Downloads</span>
        <button
          type="button"
          className="dl-flyout__all"
          data-testid="flyout-show-all"
          onClick={() => {
            close()
            void invoke('library.open', { section: 'downloads' })
          }}
        >
          Show All
        </button>
      </header>
      <div
        className="dl-flyout__list"
        role="listbox"
        aria-label="Recent downloads"
        data-answered={entries ? 'true' : 'false'}
      >
        {list.map((d, i) => (
          <FlyoutRow key={d.id} entry={d} highlighted={i === highlight} />
        ))}
        {entries && list.length === 0 && (
          <p className="dl-flyout__empty" data-testid="flyout-empty">
            No downloads yet
          </p>
        )}
      </div>
    </m.div>
  )
}
