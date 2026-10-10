import { X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { LibraryShow } from '../../../shared/commands/archive'
import { invoke, isMac, perfMark } from '../api'
import { useWindow } from '../store'
import { paletteVars, prefersReducedMotion, usePalette } from '../theme'
import { LibraryToasts } from './LibraryToasts'
import { LIBRARY_SECTIONS, sectionFor } from './sections'
import './library.css'

/** FL-24: the Library opens with a cross-fade and a slight scale, and fades out when it closes. */
const ENTER_MS = 220
const EXIT_MS = 150
const EASE_OUT = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

/**
 * The Library (AR-02, DL-09): a full view over the page area, with the section list on the left and
 * the chosen section on the right. Main shows and hides this view (`library:show`, `library:hide`);
 * Esc and ⌘W close it, and the page underneath comes back. ⌘Z / ⌘⇧Z undo and redo sidebar changes.
 */
export function LibraryApp() {
  const win = useWindow()
  const palette = usePalette(win?.spaceId)
  const [show, setShow] = useState<LibraryShow | null>(null)
  const [open, setOpen] = useState(false)
  const [sectionId, setSectionId] = useState<string | undefined>()
  const rootRef = useRef<HTMLDivElement>(null)
  const exit = useRef<Animation | undefined>(undefined)

  useEffect(() => {
    let heard = false
    let nonce = -1
    const apply = (next: LibraryShow) => {
      if (next.nonce <= nonce) return
      nonce = next.nonce
      setShow(next)
      setSectionId(next.section)
      setOpen(true)
    }
    const offShow = window.orbit.on('library:show', (payload) => {
      heard = true
      apply(payload as LibraryShow)
    })
    const offHide = window.orbit.on('library:hide', () => {
      heard = true
      setOpen(false)
    })
    // The first open can arrive before this page has loaded: ask what to show.
    void invoke('library.status', {}).then((status) => {
      if (!heard && status.open) apply({ ...status, entering: true })
    })
    return () => {
      offShow()
      offHide()
    }
  }, [])

  // Motion (FL-24), and a mark once the opened Library is on screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs for each open and each close
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el || !show) return
    if (open) {
      exit.current?.cancel()
      exit.current = undefined
      if (show.entering) {
        const reduce = prefersReducedMotion()
        el.animate(
          reduce
            ? [{ opacity: 0 }, { opacity: 1 }]
            : [
                { opacity: 0, transform: 'scale(0.98)' },
                { opacity: 1, transform: 'scale(1)' },
              ],
          { duration: reduce ? 120 : ENTER_MS, easing: EASE_OUT },
        )
      }
      requestAnimationFrame(() => perfMark('library:shown'))
    } else {
      exit.current = el.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(0.99)' }], {
        duration: EXIT_MS,
        easing: 'ease-in',
        fill: 'forwards',
      })
    }
  }, [open, show?.nonce])

  // Esc closes the Library when nothing inside used it (a search field clears first). Outside text
  // fields, ⌘Z / ⌘⇧Z (Ctrl on Windows and Linux) undo and redo sidebar changes, as from the sidebar
  // or a page (TB-18): a Restore Data just done here, say.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return
      if (e.key === 'Escape') {
        e.preventDefault()
        void invoke('library.close', {})
        return
      }
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      if (!mod || e.altKey || e.key.toLowerCase() !== 'z') return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      e.preventDefault()
      void invoke(e.shiftKey ? 'tabs.redo' : 'tabs.undo', {})
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const section = sectionFor(sectionId)
  const choose = (id: string) => {
    if (id === section?.id) return
    setSectionId(id)
    void invoke('library.setSection', { section: id })
  }

  if (!show) return null
  const Section = section?.component
  return (
    <div
      ref={rootRef}
      className="library"
      style={paletteVars(palette)}
      data-testid="library"
      data-open={open ? 'true' : 'false'}
      data-dark={palette?.dark ? 'true' : 'false'}
      aria-hidden={!open}
    >
      <nav className="library__nav" aria-label="Library">
        <div className="library__nav-title">Library</div>
        <ul className="library__nav-list">
          {LIBRARY_SECTIONS.map((s) => {
            const Icon = s.icon
            const active = s.id === section?.id
            return (
              <li key={s.id}>
                <button
                  type="button"
                  className={`library__nav-item${active ? ' is-active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  data-testid="library-nav-item"
                  data-section-id={s.id}
                  title={s.label}
                  onClick={() => choose(s.id)}
                  onContextMenu={(e) => {
                    if (!s.onContextMenu) return
                    e.preventDefault()
                    s.onContextMenu(Math.round(e.clientX), Math.round(e.clientY))
                  }}
                >
                  <Icon size={16} strokeWidth={1.8} />
                  <span className="library__nav-label">{s.label}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </nav>
      <main
        key={section?.id ?? 'none'}
        className="library__content"
        data-testid="library-section"
        data-section-id={section?.id ?? ''}
      >
        {Section ? <Section show={show} /> : <p className="library__empty">Nothing here yet.</p>}
      </main>
      <button
        type="button"
        className="icon-button library__close"
        aria-label="Close Library"
        title="Close (Esc)"
        data-testid="library-close"
        onClick={() => void invoke('library.close', {})}
      >
        <X size={16} />
      </button>
      <LibraryToasts />
    </div>
  )
}
