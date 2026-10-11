import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ToastAction, ToastPayload } from '../../../shared/toast'
import { invoke } from '../api'
import { EASE, POP, SNAPPY, tween, useReducedMotion } from '../motion'

interface Toast {
  id: number
  message: string
  /** A button that runs a command, e.g. "Go to Space" after a restore to another Space (AR-05). */
  action?: ToastAction
}

let nextId = 1

/** FL-22: a toast stays about 3–4 s; one with a button stays long enough to use it. */
const STAY_MS = 3000
const STAY_WITH_ACTION_MS = 4000
/** FL-22: after the pointer leaves a hovered toast, it stays about 1 s more. */
const AFTER_HOVER_MS = 1000
/** FL-22: at most three stack. */
const MAX_TOASTS = 3

/**
 * FL-22's motion: in, a toast rises about 12 px, fades in and grows from 0.96 with the pop spring;
 * out, it fades and drops about 8 px (about 160 ms). A new toast pushes the older ones up with the
 * snappy spring.
 *
 * With reduced motion (FL-28) a toast only fades, in and out, where it rests, and the push is at
 * once. Its start and end hold no move at all: motion jumps a reduced move to its end in a frame of
 * its own, so a toast could show 12 px low in its first frame, and drop 8 px as it starts to leave.
 * ShellApp also renders the toasts under OrbitMotionConfig.
 */
const ENTER = { opacity: 0, y: 12, scale: 0.96 }
const SHOWN = { opacity: 1, y: 0, scale: 1, transition: { ...POP, opacity: tween('quick') } }
const LEAVE = { opacity: 0, y: 8, scale: 1, transition: { duration: 0.16, ease: EASE.quick } }
const FADE_IN = { opacity: 0, y: 0, scale: 1 }
const FADE_OUT = { opacity: 0, y: 0, scale: 1, transition: { duration: 0.16, ease: EASE.quick } }

/**
 * Short confirmations from the main process (e.g. "Copied URL"), shown at the bottom of the sidebar;
 * while the sidebar is hidden, over the page card in a view of their own (ToastViewApp, SB-13).
 */
export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const hovered = useRef<number | null>(null)
  const reduced = useReducedMotion()
  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    setToasts((list) => list.filter((t) => t.id !== id))
  }, [])
  // A hovered toast waits: it leaves once the pointer has left it (FL-22).
  const leaveAfter = useCallback(
    (id: number, ms: number) => {
      clearTimeout(timers.current.get(id))
      timers.current.set(
        id,
        setTimeout(() => {
          if (hovered.current !== id) dismiss(id)
        }, ms),
      )
    },
    [dismiss],
  )
  useEffect(
    () =>
      window.orbit.on('toast', (payload) => {
        const { message, action } = payload as ToastPayload
        const id = nextId++
        setToasts((list) => [...list.slice(-(MAX_TOASTS - 1)), { id, message, ...(action ? { action } : {}) }])
        leaveAfter(id, action ? STAY_WITH_ACTION_MS : STAY_MS)
      }),
    [leaveAfter],
  )
  useEffect(() => {
    const all = timers.current
    return () => {
      for (const timer of all.values()) clearTimeout(timer)
    }
  }, [])
  return (
    <div className="toasts" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout={reduced ? false : 'position'}
            className={`toast${t.action ? ' has-action' : ''}`}
            data-testid="toast"
            data-toast-id={t.id}
            initial={reduced ? FADE_IN : ENTER}
            animate={SHOWN}
            exit={reduced ? FADE_OUT : LEAVE}
            transition={{ layout: SNAPPY }}
            onPointerEnter={() => {
              hovered.current = t.id
            }}
            onPointerLeave={() => {
              if (hovered.current === t.id) hovered.current = null
              leaveAfter(t.id, AFTER_HOVER_MS)
            }}
            // A toast with a button is clickable as a whole: a click anywhere on it runs the button's
            // action, the button's own included (SB-13, FL-22).
            onClick={
              t.action
                ? () => {
                    const action = t.action
                    if (action) void invoke(action.command, action.args as never)
                    dismiss(t.id)
                  }
                : undefined
            }
          >
            {t.message}
            {t.action && (
              <button type="button" className="toast__action" data-testid="toast-action">
                {t.action.label}
              </button>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
