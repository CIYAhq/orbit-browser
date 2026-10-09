import { Volume2, VolumeX, X } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import { invoke } from '../../api'
import { getOrbitState, useOrbit } from '../../store'
import { Favicon } from '../../ui/Favicon'
import { focusedPaneOf, lastFocusedPane, paneOrderKey } from '../split/selectors'

/**
 * A split view as one sidebar row (SV-21): one favicon + title segment per pane, in reading
 * order. Clicking a segment shows the split with that pane focused; the row's × closes the
 * whole split (SV-19); ⌥/Alt-click separates it (SV-18); right-click opens the split menu (SV-22).
 */
export function SplitRow({ splitId, depth }: { splitId: string; depth: number }) {
  const order = useOrbit((s) => paneOrderKey(s, splitId))
  const focused = useOrbit((s) => focusedPaneOf(s, splitId))
  const name = useOrbit((s) => s.splits[splitId]?.name ?? '')
  const [renaming, setRenaming] = useState(false)
  useEffect(
    () =>
      window.orbit.on('sidebar:rename', (payload) => {
        if ((payload as { id?: string }).id === splitId) setRenaming(true)
      }),
    [splitId],
  )
  if (!order) return null
  const panes = order.split(',')
  const commitName = (value: string | null) => {
    setRenaming(false)
    if (value !== null && value.trim() !== name) void invoke('split.rename', { splitId, name: value })
  }
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
      onDoubleClick={(e) => {
        if (!(e.target as Element).closest('button')) setRenaming(true)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        void invoke('split.contextMenu', { splitId })
      }}
    >
      {renaming ? (
        <RenameField initial={name} onDone={commitName} />
      ) : name ? (
        <span className="split-row__named" data-testid="split-name">
          <span className="split-row__icons">
            {panes.map((tabId) => (
              <PaneIcon key={tabId} tabId={tabId} />
            ))}
          </span>
          <span className="split-row__name">{name}</span>
        </span>
      ) : (
        <span className="split-row__segments">
          {panes.map((tabId) => (
            <Segment key={tabId} tabId={tabId} focused={focused === tabId && panes.length > 1} />
          ))}
        </span>
      )}
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

function RenameField({ initial, onDone }: { initial: string; onDone: (value: string | null) => void }) {
  // Enter/Escape end the edit once; a blur from the field unmounting must not commit again.
  const ended = useRef(false)
  const end = (value: string | null) => {
    if (ended.current) return
    ended.current = true
    onDone(value)
  }
  return (
    <input
      className="split-row__rename"
      data-testid="split-rename"
      defaultValue={initial}
      placeholder="Name this split"
      // biome-ignore lint/a11y/noAutofocus: the field opens on an explicit rename request
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') end(e.currentTarget.value)
        else if (e.key === 'Escape') end(null)
      }}
      onBlur={(e) => end(e.currentTarget.value)}
    />
  )
}

const PaneIcon = memo(function PaneIcon({ tabId }: { tabId: string }) {
  const favicon = useOrbit((s) => s.tabs[tabId]?.favicon)
  return (
    <span className="split-row__icon">
      <Favicon src={favicon} size={14} />
    </span>
  )
})

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
