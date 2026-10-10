import { useEffect, useRef, useState } from 'react'

export interface LibraryToast {
  id: number
  message: string
  action?: { label: string; run: () => void }
}

type Listener = (toast: LibraryToast) => void
const listeners = new Set<Listener>()
let nextId = 1

/** Shows a short message at the bottom of the Library, with an optional action (FL-22). */
export function libraryToast(message: string, action?: LibraryToast['action']): void {
  const toast = { id: nextId++, message, ...(action ? { action } : {}) }
  for (const fn of listeners) fn(toast)
}

/** How long a toast stays, and how long after the pointer leaves it (FL-22). */
const STAY_MS = 3500
const AFTER_HOVER_MS = 1000

/** The Library's own toasts: over its card, so they show where the Library is. Main can send one too. */
export function LibraryToasts() {
  const [toasts, setToasts] = useState<LibraryToast[]>([])
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const hovered = useRef<number | null>(null)
  const dismiss = (id: number) => {
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    setToasts((list) => list.filter((t) => t.id !== id))
  }
  const schedule = useRef((id: number, ms: number) => {
    clearTimeout(timers.current.get(id))
    timers.current.set(
      id,
      setTimeout(() => {
        if (hovered.current === id) return
        timers.current.delete(id)
        setToasts((list) => list.filter((t) => t.id !== id))
      }, ms),
    )
  }).current

  useEffect(() => {
    const all = timers.current
    const onToast: Listener = (toast) => {
      setToasts((list) => [...list.slice(-2), toast])
      schedule(toast.id, STAY_MS)
    }
    listeners.add(onToast)
    const off = window.orbit.on('library:toast', (payload) => {
      const message = (payload as { message?: unknown }).message
      if (typeof message === 'string') libraryToast(message)
    })
    return () => {
      listeners.delete(onToast)
      off()
      for (const t of all.values()) clearTimeout(t)
    }
  }, [schedule])

  return (
    <div className="library-toasts" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`library-toast${t.action ? ' is-clickable' : ''}`}
          data-testid="library-toast"
          role="status"
          onClick={() => {
            // The whole toast is clickable (FL-22): it runs its action.
            if (!t.action) return
            t.action.run()
            dismiss(t.id)
          }}
          onKeyDown={undefined}
          onPointerEnter={() => {
            hovered.current = t.id
            clearTimeout(timers.current.get(t.id))
          }}
          onPointerLeave={() => {
            hovered.current = null
            schedule(t.id, AFTER_HOVER_MS)
          }}
        >
          <span className="library-toast__text">{t.message}</span>
          {t.action && (
            <button
              type="button"
              className="library-toast__action"
              data-testid="library-toast-action"
              onClick={(e) => {
                e.stopPropagation()
                t.action?.run()
                dismiss(t.id)
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
