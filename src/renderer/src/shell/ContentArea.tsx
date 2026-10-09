import { Command } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { formatAccelerator } from '../../../shared/actions'
import { type DividerBox, layoutBoxes, layoutLeaves, leaf } from '../../../shared/split'
import type { OrbitState, SplitLayout, WindowState } from '../../../shared/state'
import { splitOfTab } from '../../../shared/tree'
import { invoke } from '../api'
import { activeTabId } from '../selectors'
import { useOrbit } from '../store'
import { DROP_PANE, type DropPreview, dividerKey, FRAME_RADIUS, PaneEngine } from './split/engine'
import { useAltClickSplit } from './split/useAltClickSplit'
import { usePaneDrag, useTabDrop } from './split/useTabDrop'

export { FRAME_RADIUS }

interface FrameInfo {
  tabId: string
  splitId?: string
  layout: SplitLayout
  blank: string[]
}

const isBlank = (url: string | undefined) => !url || url === 'about:blank'

/** Everything the frame's structure depends on, as one string, so unrelated state changes don't re-render it. */
function frameKey(s: OrbitState, winId: string): string {
  const tabId = activeTabId(s, winId)
  if (!tabId) return ''
  const splitId = splitOfTab(s, tabId)
  const split = splitId ? s.splits[splitId] : undefined
  if (!split) return JSON.stringify({ tabId, layout: leaf(tabId), blank: [] } satisfies FrameInfo)
  const blank = layoutLeaves(split.layout).filter((id) => isBlank(s.tabs[id]?.url))
  return JSON.stringify({ tabId, splitId, layout: split.layout, blank } satisfies FrameInfo)
}

/**
 * The content frame: one rounded page card, or 2–4 for a split view with dividers between
 * them. The shell reports each pane's rectangle to the main process, which places the native
 * page views exactly over them (docs/ARCHITECTURE.md §1, §4).
 */
export function ContentArea({ win }: { win: WindowState }) {
  const key = useOrbit((s) => frameKey(s, win.id))
  const frame = useMemo(() => (key ? (JSON.parse(key) as FrameInfo) : null), [key])
  const hostRef = useRef<HTMLDivElement>(null)
  const engine = useMemo(() => new PaneEngine(), [])
  const [drop, setDrop] = useState<DropPreview | null>(null)

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    engine.attach(host)
    return () => engine.detach()
  }, [engine])
  useLayoutEffect(() => {
    engine.setModel({
      layout: frame?.layout ?? null,
      blank: new Set(frame?.blank ?? []),
      focused: frame?.tabId ?? null,
    })
  }, [engine, frame])
  useLayoutEffect(() => engine.setPreview(drop), [engine, drop])
  useLayoutEffect(() => {
    const offFullscreen = window.orbit.on('split:fullscreen', (payload) => {
      engine.setFullscreen((payload as { tabId: string | null }).tabId)
    })
    const offRelayout = window.orbit.on('split:relayout', () => engine.invalidate())
    return () => {
      offFullscreen()
      offRelayout()
    }
  }, [engine])
  useTabDrop(engine, setDrop)
  usePaneDrag(engine, setDrop)
  useAltClickSplit()

  const layout = frame?.layout ?? null
  const leaves = layout ? layoutLeaves(layout) : []
  const isSplit = !!layout && layout.type !== 'leaf'
  const dividers = useMemo(
    () =>
      layout && layout.type !== 'leaf' ? layoutBoxes(layout, { x: 0, y: 0, width: 1, height: 1 }, 0).dividers : [],
    [layout],
  )
  return (
    <main className="content">
      <div
        ref={hostRef}
        className={`frame-host${isSplit ? ' is-split' : ''}`}
        data-testid="content-frame"
        data-active-tab={frame?.tabId ?? ''}
        data-split-id={frame?.splitId ?? ''}
      >
        {!layout && <EmptyState />}
        {leaves.map((id) => (
          <Pane
            key={id}
            tabId={id}
            engine={engine}
            blank={frame?.blank.includes(id) ?? false}
            focused={isSplit && id === frame?.tabId}
            single={!isSplit}
          />
        ))}
        {drop && drop.side !== 'center' && (drop.move || !leaves.includes(drop.tabId)) && (
          <div
            key={DROP_PANE}
            className="pane pane--drop"
            data-testid="split-drop-indicator"
            data-side={drop.side}
            ref={(el) => engine.registerPane(DROP_PANE, el)}
          />
        )}
        {frame?.splitId &&
          dividers.map((d) => (
            <Divider key={dividerKey(d.path, d.index)} divider={d} splitId={frame.splitId as string} engine={engine} />
          ))}
        {isSplit && (
          <div className="pane-focus-ring" data-testid="split-focus-ring" ref={(el) => engine.registerRing(el)} />
        )}
      </div>
    </main>
  )
}

const Pane = memo(function Pane(props: {
  tabId: string
  engine: PaneEngine
  blank: boolean
  focused: boolean
  single: boolean
}) {
  const { tabId, engine, blank, focused, single } = props
  return (
    <div
      ref={(el) => engine.registerPane(tabId, el)}
      className={`pane${single ? ' pane--single' : ''}${blank ? ' pane--blank' : ''}${focused ? ' is-focused' : ''}`}
      data-testid="split-pane"
      data-tab-id={tabId}
      data-focused={focused ? 'true' : undefined}
    >
      {blank && <span className="pane__hint">Choose a page for this pane</span>}
    </div>
  )
})

function Divider({ divider, splitId, engine }: { divider: DividerBox; splitId: string; engine: PaneEngine }) {
  const key = dividerKey(divider.path, divider.index)
  const cursorClass = divider.axis === 'row' ? 'is-resizing' : 'is-resizing-rows'
  const finish = () => {
    document.documentElement.classList.remove(cursorClass)
    const result = engine.endDrag()
    if (result) void invoke('split.resize', { splitId, path: result.path, sizes: result.sizes })
  }
  // A divider that goes away mid-drag (the split changed) ends its drag and its cursor.
  useEffect(
    () => () => {
      document.documentElement.classList.remove(cursorClass)
      engine.cancelDrag(key)
    },
    [engine, key, cursorClass],
  )
  return (
    <div
      ref={(el) => engine.registerDivider(key, el)}
      className={`split-divider split-divider--${divider.axis}`}
      role="separator"
      aria-orientation={divider.axis === 'row' ? 'vertical' : 'horizontal'}
      aria-label="Resize panes (double-click to even them out)"
      data-testid="split-divider"
      data-axis={divider.axis}
      onPointerDown={(e) => {
        if (e.button !== 0 || !engine.beginDrag(key, e.clientX, e.clientY)) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        document.documentElement.classList.add(cursorClass)
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) engine.moveDrag(e.clientX, e.clientY)
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={() => void invoke('split.equalize', { splitId, path: divider.path, index: divider.index })}
    />
  )
}

function EmptyState() {
  const shortcut = formatAccelerator(window.orbit.platform === 'darwin' ? 'Cmd+T' : 'Ctrl+T', window.orbit.platform)
  return (
    <div className="pane pane--empty" data-testid="empty-state">
      <div className="frame__empty">
        <Command size={28} strokeWidth={1.4} />
        <p>
          Press <kbd>{shortcut}</kbd> to open a tab
        </p>
      </div>
    </div>
  )
}
