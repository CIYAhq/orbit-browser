import { useEffect, useState } from 'react'

interface Toast {
  id: number
  message: string
}

let nextId = 1

/** Short confirmations from the main process (e.g. "Copied URL"), shown at the bottom of the sidebar. */
export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  useEffect(
    () =>
      window.orbit.on('toast', (payload) => {
        const { message } = payload as { message: string }
        const id = nextId++
        setToasts((list) => [...list.slice(-2), { id, message }])
        setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 2200)
      }),
    [],
  )
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast" data-testid="toast">
          {t.message}
        </div>
      ))}
    </div>
  )
}
