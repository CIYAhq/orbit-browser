import { LibraryBig } from 'lucide-react'
import { useEffect, useState } from 'react'
import { invoke } from '../api'
import { useShortcutLabel } from '../keys/live'
import './library-button.css'

/**
 * The Library button at the left of the sidebar's bottom bar (SB-09, AR-02): opens the Library, or
 * closes it when it is open (shown pressed). A hover gets its view ready, so the first open is quick.
 */
export function LibraryButton() {
  const [open, setOpen] = useState(false)
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
    <button
      type="button"
      className={`icon-button spacebar__library${open ? ' is-open' : ''}`}
      aria-label="Library"
      aria-pressed={open}
      title={shortcut ? `Library (${shortcut})` : 'Library'}
      data-testid="library-button"
      onPointerEnter={() => void invoke('library.prepare', {})}
      onClick={() => void invoke('library.toggle', {})}
    >
      <LibraryBig size={17} />
    </button>
  )
}
