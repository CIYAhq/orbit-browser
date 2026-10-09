import { Plus } from 'lucide-react'
import {
  type CSSProperties,
  memo,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { formatAccelerator } from '../../../../shared/actions'
import { DEFAULT_PROFILE_ID } from '../../../../shared/defaults'
import type { SpaceId, WindowState } from '../../../../shared/state'
import { primaryColor } from '../../../../shared/theme'
import { invoke, isMac } from '../../api'
import { useOrbit } from '../../store'
import { switcher } from '../spaces/switcher'
import { openSpaceMenu, openSpacePanel } from '../spaces/TitleRow'

/** Bottom bar (SB-09): the Space switcher in the centre and the "+" menu at the right. */
export function SpaceBar({ win }: { win: WindowState }) {
  return <SpaceBarInner spaceId={win.spaceId} />
}

const SpaceBarInner = memo(function SpaceBarInner({ spaceId }: { spaceId: SpaceId }) {
  const order = useOrbit((s) => s.spaceOrder)
  const many = order.length > 1
  return (
    <nav className="spacebar" data-testid="spacebar">
      <div className="spacebar__lead" />
      {many ? <Switcher order={order} activeId={spaceId} /> : <div className="spacebar__spaces" />}
      <button
        type="button"
        className="icon-button spacebar__plus"
        aria-label="New…"
        title="New Tab, Space, Folder or Split View"
        data-testid="sidebar-plus"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          openSpacePanel('space-plus-menu', { x: Math.round(r.right), y: Math.round(r.top) })
        }}
      >
        <Plus size={17} />
      </button>
    </nav>
  )
})

interface DragState {
  spaceId: SpaceId
  pointerId: number
  startX: number
  from: number
  to: number
  moved: boolean
  pitch: number
}

/**
 * One target per Space in order: its icon, or a dot (SP-06). The emphasis
 * pill and each target's `--p` (0..1 "activeness") are painted by the
 * switcher so they slide with a swipe. Click switches (SP-07), right-click
 * opens that Space's menu, and dragging a target reorders Spaces (SP-11).
 */
function Switcher({ order, activeId }: { order: SpaceId[]; activeId: SpaceId }) {
  const rowRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [overflow, setOverflow] = useState({ left: false, right: false })

  // Keep the active target in view and show fades at clipped edges (and repaint the
  // emphasis after the targets moved).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the order changes target positions
  useLayoutEffect(() => {
    const row = rowRef.current
    if (!row) return
    const update = () => {
      const left = row.scrollLeft > 1
      const right = row.scrollLeft + row.clientWidth < row.scrollWidth - 1
      setOverflow((o) => (o.left === left && o.right === right ? o : { left, right }))
    }
    // Measure after the browser's own layout (no forced layout during the switch).
    const raf = requestAnimationFrame(() => {
      const active = row.querySelector<HTMLElement>(`[data-space-id="${CSS.escape(activeId)}"]`)
      if (active && row.scrollWidth > row.clientWidth) {
        const left = active.offsetLeft
        const right = left + active.offsetWidth
        if (left < row.scrollLeft) row.scrollLeft = left - 4
        else if (right > row.scrollLeft + row.clientWidth) row.scrollLeft = right - row.clientWidth + 4
      }
      update()
    })
    row.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(row)
    switcher.refresh()
    return () => {
      cancelAnimationFrame(raf)
      row.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [activeId, order])

  const dragRef = useRef(drag)
  dragRef.current = drag
  const orderRef = useRef(order)
  orderRef.current = order
  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLButtonElement>, spaceId: SpaceId) => {
    const order = orderRef.current
    if (e.button !== 0) return
    const pitch = e.currentTarget.offsetWidth + 2
    setDrag({
      spaceId,
      pointerId: e.pointerId,
      startX: e.clientX,
      from: order.indexOf(spaceId),
      to: order.indexOf(spaceId),
      moved: false,
      pitch,
    })
  }, [])
  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    const order = orderRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    const dx = e.clientX - drag.startX
    if (!drag.moved && Math.abs(dx) < 4) return
    if (!drag.moved) e.currentTarget.setPointerCapture(e.pointerId)
    const to = Math.max(0, Math.min(order.length - 1, drag.from + Math.round(dx / drag.pitch)))
    setDrag({ ...drag, moved: true, to })
    e.currentTarget.style.setProperty('--drag-x', `${dx}px`)
  }, [])
  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    e.currentTarget.style.removeProperty('--drag-x')
    if (drag.moved && drag.to !== drag.from) void invoke('spaces.reorder', { spaceId: drag.spaceId, index: drag.to })
    // A drag is not a click: keep the flag until the click event has passed.
    if (drag.moved) setTimeout(() => setDrag(null), 0)
    else setDrag(null)
  }, [])

  const shiftOf = (index: number): number => {
    if (!drag?.moved) return 0
    const { from, to, pitch } = drag
    if (index === from) return 0
    if (from < to && index > from && index <= to) return -pitch
    if (from > to && index < from && index >= to) return pitch
    return 0
  }

  return (
    <div
      className={`spacebar__spaces${overflow.left ? ' fade-left' : ''}${overflow.right ? ' fade-right' : ''}`}
      ref={rowRef}
      data-testid="space-switcher"
    >
      <div className="spacebar__row">
        <span className="spacebar__pill" ref={switcher.registerPill} aria-hidden />
        {order.map((id, index) => (
          <SpaceTarget
            key={id}
            spaceId={id}
            index={index}
            active={id === activeId}
            dragging={drag?.moved === true && drag.spaceId === id}
            shift={shiftOf(index)}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            suppressClick={drag?.moved === true}
          />
        ))}
      </div>
    </div>
  )
}

const SpaceTarget = memo(function SpaceTarget(props: {
  spaceId: SpaceId
  index: number
  active: boolean
  dragging: boolean
  shift: number
  suppressClick: boolean
  onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>, spaceId: SpaceId) => void
  onPointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLButtonElement>) => void
}) {
  const { spaceId, index, active } = props
  const ref = useCallback((el: HTMLButtonElement | null) => switcher.registerDot(spaceId, el), [spaceId])
  const name = useOrbit((s) => s.spaces[spaceId]?.name)
  const icon = useOrbit((s) => s.spaces[spaceId]?.icon)
  const color = useOrbit((s) => {
    const theme = s.spaces[spaceId]?.theme
    return theme ? primaryColor(theme) : undefined
  })
  const profile = useOrbit((s) => {
    const id = s.spaces[spaceId]?.profileId
    return id && id !== DEFAULT_PROFILE_ID ? s.profiles[id]?.name : undefined
  })
  if (name === undefined) return null
  const shortcut =
    index < 9 ? formatAccelerator(isMac ? `Ctrl+${index + 1}` : `Alt+${index + 1}`, window.orbit.platform) : ''
  // Tooltip: "Name · Profile (shortcut)" (SP-06, PR-07, AP-16).
  const tooltip = `${name}${profile ? ` · ${profile}` : ''}${shortcut ? ` (${shortcut})` : ''}`
  const style = {
    '--dot': color,
    '--p': active ? 1 : 0,
    transform: props.dragging
      ? 'translateX(var(--drag-x, 0px)) scale(1.12)'
      : props.shift
        ? `translateX(${props.shift}px)`
        : undefined,
  } as CSSProperties
  return (
    <button
      type="button"
      ref={ref}
      className={`space-dot${active ? ' is-active' : ''}${props.dragging ? ' is-dragging' : ''}`}
      title={tooltip}
      aria-label={`Switch to ${name}`}
      aria-pressed={active}
      data-testid="space-dot"
      data-space-id={spaceId}
      data-space-drop-target={spaceId}
      style={style}
      onPointerDown={(e) => props.onPointerDown(e, spaceId)}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onPointerCancel={props.onPointerUp}
      onClick={() => {
        if (props.suppressClick || active) return
        void invoke('spaces.switch', { spaceId })
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        // The menu acts on the clicked Space without switching to it (SP-07).
        openSpaceMenu(spaceId, e.clientX, e.clientY)
      }}
    >
      {icon ? <span className="space-dot__icon">{icon}</span> : <span className="space-dot__dot" />}
    </button>
  )
})
