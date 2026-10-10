import { useEffect, useState } from 'react'
import type { CommandName } from '../../../shared/rpc'
import { invoke } from '../api'

interface Toast {
  id: number
  message: string
  /** A button that runs a command, e.g. "Go to Space" after a restore to another Space (AR-05). */
  action?: { label: string; command: CommandName; args?: unknown }
}

let nextId = 1

/** Short confirmations from the main process (e.g. "Copied URL"), shown at the bottom of the sidebar. */
export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  useEffect(
    () =>
      window.orbit.on('toast', (payload) => {
        const { message, action } = payload as { message: string; action?: Toast['action'] }
        const id = nextId++
        setToasts((list) => [...list.slice(-2), { id, message, ...(action ? { action } : {}) }])
        // One with a button stays long enough to use it (FL-22: about 3–4 s).
        setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), action ? 4000 : 2200)
      }),
    [],
  )
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast${t.action ? ' has-action' : ''}`} data-testid="toast">
          {t.message}
          {t.action && (
            <button
              type="button"
              className="toast__action"
              data-testid="toast-action"
              onClick={() => {
                const action = t.action
                if (action) void invoke(action.command, action.args as never)
                setToasts((list) => list.filter((x) => x.id !== t.id))
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
