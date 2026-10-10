import { LibraryBig } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ACTIONS_BY_ID, formatAccelerator, shortcutsFor } from '../../../shared/actions'
import { invoke } from '../api'
import './library-button.css'

const action = ACTIONS_BY_ID['app.library']
const accel = action ? shortcutsFor(action, window.orbit.platform)[0] : undefined
const TITLE = accel ? `Library (${formatAccelerator(accel, window.orbit.platform)})` : 'Library'

/**
 * The Library button at the left of the sidebar's bottom bar (SB-09, AR-02): opens the Library, or
 * closes it when it is open (shown pressed). A hover gets its view ready, so the first open is quick.
 */
export function LibraryButton() {
  const [open, setOpen] = useState(false)
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
      title={TITLE}
      data-testid="library-button"
      onPointerEnter={() => void invoke('library.prepare', {})}
      onClick={() => void invoke('library.toggle', {})}
    >
      <LibraryBig size={17} />
    </button>
  )
}
