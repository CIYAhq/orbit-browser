import { useEffect, useState } from 'react'
import { invoke } from '../../api'
import { sidebarUndoKey } from '../sidebar/undo-keys'

const SHOW_MS = 8000

const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))

/**
 * "Deleted “Name” · Undo" after a Space is deleted (SP-12). Sidebar undo's key (⌘Z, Ctrl+Z, or
 * the one Settings gave it) in the sidebar does the same while the note is showing.
 */
export function UndoToast() {
  const [entry, setEntry] = useState<{ name: string; key: number } | null>(null)

  useEffect(
    () =>
      window.orbit.on('spaces:deleted', (payload) => {
        setEntry({ name: (payload as { name: string }).name, key: Date.now() })
      }),
    [],
  )

  useEffect(() => {
    if (!entry) return
    const timer = setTimeout(() => setEntry(null), SHOW_MS)
    const onKey = (e: KeyboardEvent) => {
      // Sidebar undo's keys, as the keymap has them (KS-05).
      const undo = sidebarUndoKey(e)
      if (!undo || undo.redo || (undo.outsideText && editable(e.target))) return
      e.preventDefault()
      e.stopPropagation()
      void invoke('spaces.undoDelete', {})
      setEntry(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [entry])

  if (!entry) return null
  return (
    <div className="space-undo" role="status" data-testid="space-undo" key={entry.key}>
      <span className="space-undo__text">Deleted “{entry.name}”</span>
      <button
        type="button"
        className="space-undo__button"
        data-testid="space-undo-button"
        onClick={() => {
          void invoke('spaces.undoDelete', {})
          setEntry(null)
        }}
      >
        Undo
      </button>
    </div>
  )
}
