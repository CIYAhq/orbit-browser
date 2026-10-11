import { Check, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  isSeparator,
  type RowMenuEntry,
  type RowMenuItem,
  type RowMenuModel,
  typeAheadIndex,
} from '../../../shared/row-menu'
import type { OverlayState } from '../../../shared/state'
import { invoke } from '../api'
import './row-menu.css'

type PanelOverlay = Extract<OverlayState, { kind: 'panel' }>

/** Letters typed within this long of each other make one type-ahead prefix (TB-14). */
const TYPE_AHEAD_MS = 700
/** Room kept between a menu and the window's edges. */
const EDGE = 8

const itemsOf = (entries: RowMenuEntry[]) => entries.filter((e): e is RowMenuItem => !isSeparator(e))

function parseModel(overlay: PanelOverlay): RowMenuModel | null {
  const json = overlay.params?.model
  if (typeof json !== 'string') return null
  try {
    return JSON.parse(json) as RowMenuModel
  } catch {
    return null
  }
}

/**
 * A row's right-click menu (TB-14), drawn in the overlay in the Space's colours (SP-16). Arrows
 * move, → / Enter open a submenu, ← / Esc close one, Enter chooses, letters jump to the item they
 * start (type-ahead); Esc on the menu itself, or a click outside, closes it. Main keeps what the
 * items do, and the keys they show come from the keymap as it is now (KS-18).
 */
/** Which submenus are open and which item of each level has the keyboard. */
interface Nav {
  /** open[i]: the item of level i whose submenu (level i + 1) is open. */
  open: number[]
  /** focus[i]: level i's focused item (-1: none). */
  focus: number[]
  /** The level the keys move in. */
  active: number
}

/** The items of each open level, the menu's own first. */
function levelsOf(model: RowMenuModel | null, open: number[]): RowMenuItem[][] {
  if (!model) return []
  const out: RowMenuItem[][] = [itemsOf(model.entries)]
  for (const index of open) {
    const sub = out[out.length - 1]?.[index]?.submenu
    if (!sub) break
    out.push(itemsOf(sub))
  }
  return out
}

/**
 * A row's right-click menu (TB-14), drawn in the overlay in the Space's colours (SP-16). Arrows
 * move, → / Enter open a submenu, ← / Esc close one, Enter chooses, letters jump to the item they
 * start (type-ahead); Esc on the menu itself, or a click outside, closes it. Main keeps what the
 * items do, and the keys they show come from the keymap as it is now (KS-18).
 */
export function RowMenu({ overlay }: { overlay: PanelOverlay }) {
  const model = useMemo(() => parseModel(overlay), [overlay])
  const x = typeof overlay.params?.x === 'number' ? overlay.params.x : 0
  const y = typeof overlay.params?.y === 'number' ? overlay.params.y : 0
  const [nav, setNavState] = useState<Nav>({ open: [], focus: [-1], active: 0 })
  // Keys read and move the latest state: several may arrive before the menu draws again.
  const navRef = useRef(nav)
  const setNav = useCallback((fn: (n: Nav) => Nav) => {
    navRef.current = fn(navRef.current)
    setNavState(navRef.current)
  }, [])
  const typed = useRef({ text: '', at: 0 })
  const levels = useMemo(() => levelsOf(model, nav.open), [model, nav.open])

  const choose = useCallback(
    (item: RowMenuItem) => {
      if (!model || !item.enabled || item.submenu) return
      void invoke('rowMenu.choose', { menu: model.menu, id: item.id })
    },
    [model],
  )

  /** Opens the submenu of level `level`'s item `index`; `enter` puts the keyboard in it. */
  const openSub = useCallback(
    (level: number, index: number, enter: boolean) => {
      const item = levelsOf(model, navRef.current.open.slice(0, level))[level]?.[index]
      if (!item?.submenu || !item.enabled) return
      const first = itemsOf(item.submenu).findIndex((e) => e.enabled)
      setNav((n) => ({
        open: [...n.open.slice(0, level), index],
        focus: [...n.focus.slice(0, level), index, enter ? first : -1],
        active: enter ? level + 1 : level,
      }))
    },
    [model, setNav],
  )

  const closeTo = useCallback(
    (level: number) =>
      setNav((n) => ({ open: n.open.slice(0, level), focus: n.focus.slice(0, level + 1), active: level })),
    [setNav],
  )

  const focusAt = useCallback(
    (level: number, index: number) =>
      setNav((n) => ({ open: n.open.slice(0, level), focus: [...n.focus.slice(0, level), index], active: level })),
    [setNav],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { open, focus, active } = navRef.current
      const items = levelsOf(model, open)[active] ?? []
      const current = focus[active] ?? -1
      const enabled = items.map((it, i) => (it.enabled ? i : -1)).filter((i) => i >= 0)
      const step = (dir: 1 | -1) => {
        if (enabled.length === 0) return
        const at = enabled.indexOf(current)
        const next =
          at < 0
            ? dir === 1
              ? enabled[0]
              : enabled[enabled.length - 1]
            : enabled[(at + dir + enabled.length) % enabled.length]
        if (next !== undefined) focusAt(active, next)
      }
      // Every key the menu knows is its own: none reaches the page or Orbit's bindings (KS-19).
      switch (e.key) {
        case 'ArrowDown':
          step(1)
          break
        case 'ArrowUp':
          step(-1)
          break
        case 'Home':
          if (enabled[0] !== undefined) focusAt(active, enabled[0])
          break
        case 'End':
          if (enabled.length > 0) focusAt(active, enabled[enabled.length - 1] as number)
          break
        case 'ArrowRight':
          if (items[current]?.submenu) openSub(active, current, true)
          break
        case 'ArrowLeft':
          if (active > 0) closeTo(active - 1)
          break
        case 'Escape':
          if (active > 0) closeTo(active - 1)
          else void invoke('overlay.close', {})
          break
        case 'Enter':
        case ' ': {
          const item = items[current]
          if (item?.submenu) openSub(active, current, true)
          else if (item) choose(item)
          break
        }
        case 'Tab':
          break
        default: {
          if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return
          const now = performance.now()
          const t = typed.current
          t.text = now - t.at > TYPE_AHEAD_MS ? e.key : t.text + e.key
          t.at = now
          const next = typeAheadIndex(items, t.text, current)
          if (next >= 0) focusAt(active, next)
        }
      }
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [model, focusAt, openSub, closeTo, choose])

  if (!model) return null
  const { open, focus } = nav
  return (
    <div className="row-menu" data-testid="row-menu" data-key={model.key}>
      {levels.map((items, level) => (
        <MenuLevel
          // biome-ignore lint/suspicious/noArrayIndexKey: a level is where it is in the open chain
          key={`${level}:${open.slice(0, level).join('.')}`}
          level={level}
          entries={level === 0 ? model.entries : (levels[level - 1]?.[open[level - 1] ?? -1]?.submenu ?? [])}
          items={items}
          focus={focus[level] ?? -1}
          openIndex={open[level] ?? -1}
          anchor={level === 0 ? { x, y } : null}
          label={level === 0 ? model.label : (levels[level - 1]?.[open[level - 1] ?? -1]?.label ?? '')}
          onHover={(index) => {
            const item = items[index]
            if (item?.submenu && item.enabled) openSub(level, index, false)
            else focusAt(level, index)
          }}
          onClick={(index) => {
            const item = items[index]
            if (!item?.enabled) return
            if (item.submenu) openSub(level, index, true)
            else choose(item)
          }}
        />
      ))}
    </div>
  )
}

function MenuLevel(props: {
  level: number
  entries: RowMenuEntry[]
  items: RowMenuItem[]
  focus: number
  openIndex: number
  /** Where the top menu opens; a submenu opens beside its item. */
  anchor: { x: number; y: number } | null
  label: string
  onHover: (index: number) => void
  onClick: (index: number) => void
}) {
  const { level, entries, items, focus, openIndex, anchor, label, onHover, onClick } = props
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const ax = anchor?.x
  const ay = anchor?.y
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const maxLeft = window.innerWidth - EDGE - w
    const maxTop = window.innerHeight - EDGE - h
    if (ax !== undefined && ay !== undefined) {
      // Like a system menu: below-right of the pointer, flipped when it would leave the window.
      const left = ax + w > window.innerWidth - EDGE ? ax - w : ax
      const top = ay + h > window.innerHeight - EDGE ? ay - h : ay
      setPos({ left: Math.max(EDGE, Math.min(left, maxLeft)), top: Math.max(EDGE, Math.min(top, maxTop)) })
      return
    }
    // Beside the item that opened it: to the right, or to the left when there's no room.
    const parent = document.querySelector<HTMLElement>(`[data-row-menu-level="${level - 1}"]`)
    const opener = parent?.querySelector<HTMLElement>('[aria-expanded="true"]')
    const box = parent?.getBoundingClientRect()
    const row = opener?.getBoundingClientRect()
    if (!box || !row) return
    const right = box.right + 2
    const left = right + w > window.innerWidth - EDGE ? box.left - w - 2 : right
    setPos({ left: Math.max(EDGE, Math.min(left, maxLeft)), top: Math.max(EDGE, Math.min(row.top - 5, maxTop)) })
  }, [ax, ay, level])
  return (
    <div
      ref={ref}
      className={`space-menu row-menu__level${level > 0 ? ' row-menu__level--sub' : ''}`}
      role="menu"
      aria-label={label}
      data-testid="row-menu-level"
      data-row-menu-level={level}
      style={pos ? { left: pos.left, top: pos.top } : { left: ax ?? 0, top: ay ?? 0, opacity: 0 }}
    >
      {entries.map((entry) => {
        if (isSeparator(entry)) return <div key={entry.id} className="space-menu__separator" role="separator" />
        const index = items.indexOf(entry)
        const focused = index === focus
        return (
          <button
            key={entry.id}
            type="button"
            tabIndex={-1}
            role={entry.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={entry.checked}
            aria-disabled={!entry.enabled || undefined}
            aria-haspopup={entry.submenu ? 'menu' : undefined}
            aria-expanded={entry.submenu ? index === openIndex : undefined}
            className={`space-menu__item row-menu__item${focused ? ' is-focused' : ''}${index === openIndex ? ' is-open' : ''}`}
            data-testid="row-menu-item"
            data-label={entry.label}
            data-focused={focused || undefined}
            disabled={!entry.enabled}
            onMouseEnter={() => onHover(index)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onClick(index)}
          >
            <span className="space-menu__icon">{entry.checked ? <Check size={14} /> : null}</span>
            <span className="space-menu__label">{entry.label}</span>
            {entry.hint ? <span className="row-menu__hint">{entry.hint}</span> : null}
            {entry.submenu ? <ChevronRight size={14} className="space-menu__more" /> : null}
          </button>
        )
      })}
    </div>
  )
}
