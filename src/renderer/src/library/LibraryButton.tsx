import { LibraryBig } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { invoke } from '../api'
import { useRecentFiles } from '../downloads/RecentFiles'
import { useShortcutLabel } from '../keys/live'
import './library-button.css'

/**
 * The Library button at the left of the sidebar's bottom bar (SB-09, AR-02): opens the Library, or
 * closes it when it is open (shown pressed). A hover gets its view ready, so the first open is quick.
 * Hovering a moment longer shows the recent files, and right-click chooses what they are (DL-05,
 * downloads lane).
 */
export function LibraryButton() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const recent = useRecentFiles(() => ref.current)
  // The tooltip follows a remapped shortcut (KS-18).
  const shortcut = useShortcutLabel('app.library')
  useEffect(() => {
    let heard = false
    const off = window.orbit.on('library.state', (payload) => {
      heard = true
      setOpen(!!(payload as { open?: boolean }).open)
    })
    void invoke('library.status', {}).then((s) => {
      if (!heard) setOpen(s.open)
    })
    return off
  }, [])
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`icon-button spacebar__library${open ? ' is-open' : ''}`}
        aria-label="Library"
        aria-pressed={open}
        title={shortcut ? `Library (${shortcut})` : 'Library'}
        data-testid="library-button"
        onPointerEnter={() => {
          void invoke('library.prepare', {})
          recent.enter()
        }}
        onPointerLeave={recent.leave}
        onContextMenu={recent.menu}
        onClick={() => {
          recent.close()
          void invoke('library.toggle', {})
        }}
      >
        <LibraryBig size={17} />
      </button>
      {recent.popover}
    </>
  )
}
