import { Command } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { type DividerBox, layoutBoxes, layoutLeaves, leaf, nodeAt } from '../../../shared/split'
import type { OrbitState, SplitLayout, WindowState } from '../../../shared/state'
import { splitOfTab } from '../../../shared/tree'
import { invoke } from '../api'
import { useShortcutLabel } from '../keys/live'
import { activeTabId } from '../selectors'
import { useOrbit } from '../store'
import { DROP_PANE, type DropPreview, dividerKey, FRAME_RADIUS, PaneEngine } from './split/engine'
import { useAltClickSplit } from './split/useAltClickSplit'
import { useLinkDrop } from './split/useLinkDrop'
import { usePaneDrag, useTabDrop } from './split/useTabDrop'

export { FRAME_RADIUS }

interface FrameInfo {
  tabId: string
  splitId?: string
  layout: SplitLayout
  blank: string[]
}

/** Everything the frame's structure depends on, as one string, so unrelated state changes don't re-render it. */
function frameKey(s: OrbitState, winId: string): string {
  const tabId = activeTabId(s, winId)
  if (!tabId) return ''
  const splitId = splitOfTab(s, tabId)
  const split = splitId ? s.splits[splitId] : undefined
  if (!split) return JSON.stringify({ tabId, layout: leaf(tabId), blank: [] } satisfies FrameInfo)
  // A pane waiting for its first page is drawn by the shell, not by a page view (SV-02).
  const blank = split.pending && layoutLeaves(split.layout).includes(split.pending) ? [split.pending] : []
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
  useLayoutEffect(() => window.orbit.on('split:relayout', () => engine.invalidate()), [engine])
  useTabDrop(engine, setDrop)
  usePaneDrag(engine, setDrop)
  useLinkDrop(engine, setDrop)
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
            <Divider
              key={dividerKey(d.path, d.index)}
              divider={d}
              splitId={frame.splitId as string}
              engine={engine}
              value={sizeBefore(layout, d)}
            />
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
  // The page's own background under it, for the moments the page hasn't drawn (SB-19).
  const pageColor = useOrbit((s) => (blank ? undefined : s.tabs[tabId]?.pageColor))
  return (
    <div
      ref={(el) => engine.registerPane(tabId, el)}
      className={`pane${single ? ' pane--single' : ''}${blank ? ' pane--blank' : ''}${focused ? ' is-focused' : ''}`}
      style={pageColor ? { backgroundColor: pageColor } : undefined}
      data-testid="split-pane"
      data-tab-id={tabId}
      data-focused={focused ? 'true' : undefined}
    >
      {blank && <span className="pane__hint">Choose a page for this pane</span>}
    </div>
  )
})

/** Share (percent) of the container taken by the pane(s) before a divider. */
function sizeBefore(layout: SplitLayout | null, d: DividerBox): number {
  const node = layout ? nodeAt(layout, d.path) : undefined
  if (!node || node.type === 'leaf') return 50
  return Math.round(node.sizes.slice(0, d.index + 1).reduce((a, b) => a + b, 0) * 100)
}

function Divider({
  divider,
  splitId,
  engine,
  value,
}: {
  divider: DividerBox
  splitId: string
  engine: PaneEngine
  value: number
}) {
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
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
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
  // The New Tab shortcut as the user has it (KS-18).
  const shortcut = useShortcutLabel('tab.new')
  return (
    <div className="pane pane--empty" data-testid="empty-state">
      <div className="frame__empty">
        <Command size={28} strokeWidth={1.4} />
        {shortcut ? (
          <p>
            Press <kbd>{shortcut}</kbd> to open a tab
          </p>
        ) : (
          <p>Open a tab from the sidebar</p>
        )}
      </div>
    </div>
  )
}
