import { Command } from 'lucide-react'
import { type RefObject, useLayoutEffect, useRef } from 'react'
import { formatAccelerator } from '../../../shared/actions'
import type { WindowState } from '../../../shared/state'
import { activeTabId } from '../selectors'
import { getSeq, useOrbit } from '../store'

export const FRAME_RADIUS = 10

/**
 * The rounded content frame. It reserves space for the active tab's native
 * view and reports the pane rectangles to the main process, which positions
 * the WebContentsViews exactly over them.
 */
export function ContentArea({ win }: { win: WindowState }) {
  const tabId = useOrbit((s) => activeTabId(s, win.id))
  const frameRef = useRef<HTMLDivElement>(null)
  usePaneReporter(frameRef, tabId)
  const shortcut = formatAccelerator(window.orbit.platform === 'darwin' ? 'Cmd+T' : 'Ctrl+T', window.orbit.platform)
  return (
    <main className="content">
      <div className="frame" ref={frameRef} data-testid="content-frame" data-active-tab={tabId ?? ''}>
        {!tabId && (
          <div className="frame__empty" data-testid="empty-state">
            <Command size={28} strokeWidth={1.4} />
            <p>
              Press <kbd>{shortcut}</kbd> to open a tab
            </p>
          </div>
        )}
      </div>
    </main>
  )
}

/** Reports where the active tab should be drawn whenever the frame moves or resizes. */
function usePaneReporter(ref: RefObject<HTMLDivElement | null>, tabId: string | null) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let last = ''
    const report = () => {
      const r = el.getBoundingClientRect()
      const panes = tabId ? [{ tabId, rect: { x: r.left, y: r.top, width: r.width, height: r.height } }] : []
      const key = JSON.stringify(panes)
      if (key === last) return
      last = key
      window.orbit.send('layout.panes', { panes, radius: FRAME_RADIUS, seq: getSeq() })
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    window.addEventListener('resize', report)
    // Follow the frame every frame while a CSS transition (e.g. sidebar hide/show) is running.
    let running = 0
    let raf = 0
    const tick = () => {
      report()
      raf = running > 0 ? requestAnimationFrame(tick) : 0
    }
    const onRun = () => {
      running++
      if (!raf) raf = requestAnimationFrame(tick)
    }
    const onEnd = () => {
      running = Math.max(0, running - 1)
      if (running === 0) requestAnimationFrame(report)
    }
    document.addEventListener('transitionrun', onRun)
    document.addEventListener('transitionend', onEnd)
    document.addEventListener('transitioncancel', onEnd)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      document.removeEventListener('transitionrun', onRun)
      document.removeEventListener('transitionend', onEnd)
      document.removeEventListener('transitioncancel', onEnd)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [ref, tabId])
}
