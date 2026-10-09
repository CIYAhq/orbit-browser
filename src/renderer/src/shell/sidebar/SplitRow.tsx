import { Volume2, VolumeX, X } from 'lucide-react'
import { memo } from 'react'
import { layoutLeaves, paneOrder } from '../../../../shared/split'
import type { OrbitState } from '../../../../shared/state'
import { invoke } from '../../api'
import { activeTabId } from '../../selectors'
import { getOrbitState, useOrbit } from '../../store'
import { Favicon } from '../../ui/Favicon'

/** The pane of a split the window currently focuses, or '' when the split isn't shown. */
function focusedPaneOf(s: OrbitState, splitId: string): string {
  const active = activeTabId(s)
  const split = s.splits[splitId]
  return active && split && layoutLeaves(split.layout).includes(active) ? active : ''
}

/** The pane focused most recently (selecting the row returns to it, SV-14). */
function lastFocusedPane(s: OrbitState, panes: string[]): string | undefined {
  let best: string | undefined
  for (const id of panes) {
    const t = s.tabs[id]
    if (t && (!best || t.lastActiveAt > (s.tabs[best]?.lastActiveAt ?? 0))) best = id
  }
  return best
}

/**
 * A split view as one sidebar row (SV-21): one favicon + title segment per pane, in reading
 * order. Clicking a segment shows the split with that pane focused; the row's × closes the
 * whole split (SV-19); ⌥/Alt-click separates it (SV-18); right-click opens the split menu (SV-22).
 */
export function SplitRow({ splitId, depth }: { splitId: string; depth: number }) {
  const order = useOrbit((s) => {
    const split = s.splits[splitId]
    return split ? paneOrder(split.layout).join(',') : ''
  })
  const focused = useOrbit((s) => focusedPaneOf(s, splitId))
  if (!order) return null
  const panes = order.split(',')
  return (
    <div
      role="button"
      tabIndex={-1}
      className={`split-row${focused ? ' is-active' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      data-testid="split-row"
      data-split-id={splitId}
      data-panes={panes.length}
      onMouseDown={(e) => {
        if (e.button !== 0) return
        if (e.altKey) {
          void invoke('split.separate', { splitId })
          return
        }
        const segment = (e.target as Element).closest('[data-testid="split-segment"]') as HTMLElement | null
        const tabId = segment?.dataset.tabId ?? lastFocusedPane(getOrbitState(), panes)
        if (tabId) void invoke('tabs.activate', { tabId })
      }}
      onAuxClick={(e) => {
        if (e.button === 1) void invoke('split.close', { splitId })
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        void invoke('split.contextMenu', { splitId })
      }}
    >
      <span className="split-row__segments">
        {panes.map((tabId) => (
          <Segment key={tabId} tabId={tabId} focused={focused === tabId && panes.length > 1} />
        ))}
      </span>
      <button
        type="button"
        className="split-row__close"
        aria-label="Close split"
        title="Close split"
        data-testid="split-close"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => void invoke('split.close', { splitId })}
      >
        <X size={13} strokeWidth={2.2} />
      </button>
    </div>
  )
}

const Segment = memo(function Segment({ tabId, focused }: { tabId: string; focused: boolean }) {
  const tab = useOrbit((s) => s.tabs[tabId])
  if (!tab) return null
  const blank = !tab.url || tab.url === 'about:blank'
  const title = blank ? 'New pane' : (tab.customTitle ?? tab.title)
  return (
    <span
      className={`split-segment${focused ? ' is-focused' : ''}${tab.asleep ? ' is-asleep' : ''}${tab.loading ? ' is-loading' : ''}`}
      data-testid="split-segment"
      data-tab-id={tabId}
      title={title}
    >
      <span className="split-segment__icon">
        <Favicon src={tab.favicon} size={14} />
      </span>
      <span className="split-segment__title">{title}</span>
      {(tab.audible || tab.muted) && (
        <button
          type="button"
          className="split-segment__audio"
          aria-label={tab.muted ? 'Unmute pane' : 'Mute pane'}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => void invoke('tabs.setMuted', { tabId, muted: !tab.muted })}
        >
          {tab.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
        </button>
      )}
    </span>
  )
})
