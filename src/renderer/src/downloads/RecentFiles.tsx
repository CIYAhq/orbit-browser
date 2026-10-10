import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LibraryFile } from '../../../shared/commands/downloads'
import { invoke } from '../api'
import { useWindow } from '../store'
import { usePalette } from '../theme'
import { dragOut, FileThumb } from './file-ui'
import { formatBytes } from './format'
import './downloads-library.css'

/** Hovering the Library button this long shows the recent files; leaving them this long hides them. */
export const RECENT_OPEN_MS = 300
export const RECENT_CLOSE_MS = 200
/** How many recent files show. */
const RECENT_LIMIT = 8

const timeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' })

/** "now", "5 min. ago", "yesterday": how long ago a file came. */
function ago(at: number, now: number): string {
  const s = Math.round((at - now) / 1000)
  if (s > -60) return timeFormat.format(0, 'second')
  if (s > -3600) return timeFormat.format(Math.round(s / 60), 'minute')
  if (s > -86_400) return timeFormat.format(Math.round(s / 3600), 'hour')
  return timeFormat.format(Math.round(s / 86_400), 'day')
}

export interface RecentFilesTrigger {
  /** The pointer came onto the Library button. */
  enter: () => void
  /** The pointer left it. */
  leave: () => void
  /** Hides the popover at once (the button was clicked). */
  close: () => void
  /** Right-click on the button: what the popover shows (DL-05). */
  menu: (e: MouseEvent) => void
  /** The popover, when it shows (render it next to the button). */
  popover: ReactNode
}

/**
 * Recent files on hover over the Library button (DL-05): after a short hover, a popover above the
 * button lists the newest downloads (and screenshots, as the button's right-click menu chose), each
 * with a picture or its kind's icon. A click opens the file; dragging one drops the file itself
 * (DL-06). The popover stays while the pointer is on it and goes a moment after it leaves.
 */
export function useRecentFiles(anchor: () => HTMLElement | null): RecentFilesTrigger {
  const [files, setFiles] = useState<LibraryFile[] | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const asked = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])

  const close = () => {
    clearTimeout(timer.current)
    asked.current++
    setFiles(null)
  }
  const show = () => {
    const ask = ++asked.current
    void invoke('downloads.recent', { limit: RECENT_LIMIT }).then((list) => {
      if (ask === asked.current) setFiles(list.length > 0 ? list : null)
    })
  }
  const enter = () => {
    clearTimeout(timer.current)
    if (!files) timer.current = setTimeout(show, RECENT_OPEN_MS)
  }
  const leave = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(close, files ? RECENT_CLOSE_MS : 0)
  }
  const menu = (e: MouseEvent) => {
    e.preventDefault()
    close()
    void invoke('downloads.libraryMenu', {})
  }

  const button = anchor()
  const popover =
    files && button
      ? createPortal(
          <RecentFilesPopover files={files} button={button} onEnter={enter} onLeave={leave} onDone={close} />,
          document.body,
        )
      : null
  return { enter, leave, close, menu, popover }
}

function RecentFilesPopover({
  files,
  button,
  onEnter,
  onLeave,
  onDone,
}: {
  files: LibraryFile[]
  button: HTMLElement
  onEnter: () => void
  onLeave: () => void
  onDone: () => void
}) {
  const win = useWindow()
  const dark = usePalette(win?.spaceId)?.dark
  const rect = button.getBoundingClientRect()
  // Above the button, inside the sidebar (the page is beside it).
  const sidebar = button.closest('[data-testid="sidebar"]')?.getBoundingClientRect()
  const left = Math.round((sidebar?.left ?? 0) + 8)
  const width = Math.round(Math.max(180, Math.min(300, (sidebar?.width ?? 260) - 16)))
  const bottom = Math.round(window.innerHeight - rect.top + 6)
  const now = Date.now()
  return (
    <div
      className="dl-recent"
      data-testid="recent-files"
      data-dark={dark ? 'true' : 'false'}
      role="menu"
      aria-label="Recent files"
      style={{ left, width, bottom }}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
    >
      <div className="dl-recent__title">Recent</div>
      {files.map((f) => (
        <button
          key={f.id}
          type="button"
          role="menuitem"
          className="dl-recent__item"
          data-testid="recent-file"
          data-id={f.id}
          data-source={f.source}
          title={f.name}
          draggable
          onDragStart={(e) => void dragOut(e, f.id).finally(onDone)}
          onClick={() => {
            onDone()
            void invoke('downloads.open', { id: f.id })
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            void invoke('downloads.menu', { id: f.id })
          }}
        >
          <span className="dl-recent__thumb">
            <FileThumb name={f.name} url={f.url} size={28} />
          </span>
          <span className="dl-recent__text">
            <span className="dl-recent__name">{f.name}</span>
            <span className="dl-recent__meta">
              {f.source === 'screenshot' ? 'Screenshot' : formatBytes(f.size)} · {ago(f.at, now)}
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}
