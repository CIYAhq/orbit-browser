import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { invoke } from '../api'
import { useOrbit } from '../store'
import { useKeymap } from './live'
import { sheetGroups } from './sheet'
import './sheet.css'

const close = () => invoke('overlay.close', {})

/**
 * Help → Keyboard Shortcuts (OB-12): a compact sheet of the essential shortcuts over the window,
 * in the overlay, with the keys they have now (KS-18). Esc, ✕ or a click outside closes it; the
 * link at the bottom opens Settings → Shortcuts for the full, editable list.
 */
export function ShortcutSheet({ dark = false }: { dark?: boolean }) {
  useKeymap()
  const lastTabOnCmd9 = useOrbit((s) => s.settings.lastTabOnCmd9)
  const groups = sheetGroups(window.orbit.platform, { lastTabOnCmd9 })
  const sheet = useRef<HTMLDivElement>(null)

  // The overlay has the keyboard while the sheet is up (KS-19): Esc closes it wherever focus is.
  useEffect(() => {
    sheet.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      void close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="ks-sheet-layer">
      <div
        ref={sheet}
        className={`ks-sheet${dark ? ' ks-sheet--dark' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ks-sheet-title"
        tabIndex={-1}
        data-testid="shortcut-sheet"
      >
        <header className="ks-sheet__head">
          <h2 id="ks-sheet-title">Keyboard Shortcuts</h2>
          <button
            type="button"
            className="ks-sheet__close"
            aria-label="Close"
            data-testid="shortcut-sheet-close"
            onClick={() => void close()}
          >
            <X size={14} />
          </button>
        </header>
        <div className="ks-sheet__groups">
          {groups.map((group) => (
            <section key={group.title} className="ks-sheet__group" data-testid="shortcut-sheet-group">
              <h3>{group.title}</h3>
              <dl>
                {group.rows.map((row) => (
                  <div key={row.title} className="ks-sheet__row" data-testid="shortcut-sheet-row">
                    <dt>{row.title}</dt>
                    <dd>
                      {row.keys ? (
                        <kbd data-testid="shortcut-sheet-keys">{row.keys}</kbd>
                      ) : (
                        <span className="ks-sheet__none">None</span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <footer className="ks-sheet__foot">
          <button
            type="button"
            className="ks-sheet__link"
            data-testid="shortcut-sheet-settings"
            onClick={() => {
              void invoke('settings.open', { section: 'shortcuts' })
              void close()
            }}
          >
            All shortcuts, and changing them: Settings → Shortcuts
          </button>
        </footer>
      </div>
    </div>
  )
}
