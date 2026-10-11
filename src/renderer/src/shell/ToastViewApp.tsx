import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { invoke } from '../api'
import { OrbitMotionConfig } from '../motion'
import { useWindow } from '../store'
import { paletteVars, usePalette } from '../theme'
import { Toasts } from './Toasts'
import './toast-view.css'

/**
 * Toasts while the sidebar is hidden (SB-13): a small view main keeps over the bottom centre of the
 * page card while it has toasts (FL-22), in the Space's colours (SP-16). It tells main how big the
 * stack is, so the view fits it, and 0 × 0 once the last toast has gone, so main takes it away.
 */
export function ToastViewApp() {
  const win = useWindow()
  const palette = usePalette(win?.spaceId)
  const stack = useRef<HTMLDivElement>(null)
  const [arrived, setArrived] = useState(0)

  const report = useCallback(() => {
    const el = stack.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    void invoke('toasts.size', { width: Math.ceil(width), height: Math.ceil(height) }).catch(() => {})
  }, [])

  // A toast came: measure the stack in the same commit. The view is out of the window until main
  // has its size, and a view out of the window draws no frames, so it observes no resize.
  useEffect(() => window.orbit.on('toast', () => setArrived((n) => n + 1)), [])
  useLayoutEffect(() => {
    if (arrived > 0) report()
  }, [arrived, report])
  // The stack shrinks as toasts leave, while the view is shown.
  useEffect(() => {
    const el = stack.current
    if (!el) return
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => observer.disconnect()
  }, [report])
  // The toasts listen now (a child's effects run first): main sends the ones that waited.
  useEffect(() => {
    void invoke('toasts.ready', {}).catch(() => {})
  }, [])

  return (
    <div className="toast-view" style={paletteVars(palette) as CSSProperties} data-testid="toast-view">
      <div ref={stack} className="toast-view__stack">
        {/* The toasts' motion follows reduced motion here too (FL-28). */}
        <OrbitMotionConfig>
          <Toasts />
        </OrbitMotionConfig>
      </div>
    </div>
  )
}
