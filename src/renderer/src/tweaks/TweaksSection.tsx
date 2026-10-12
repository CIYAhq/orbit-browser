import { ExternalLink, MoreHorizontal, Paintbrush, Pencil, SquarePen, Trash2 } from 'lucide-react'
import {
  type KeyboardEvent,
  type MouseEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { TWEAK_LIMITS, tweaksByHost } from '../../../shared/tweaks'
import { invoke } from '../api'
import { ConfirmDialog } from '../library/ConfirmDialog'
import type { LibrarySectionProps } from '../library/sections'
import { useOrbit } from '../store'
import { updateTweak } from './edit'
import { useTweakSite } from './site'
import './library.css'

/** What a row shows of a Tweak, as primitives: a row draws again only when one of them changes. */
interface Row {
  id: string
  name: string
  host: string
  subdomains: boolean
  enabled: boolean
  /** It has JavaScript; `jsAllowed`: allowed to run on this device (BO-18). */
  js: boolean
  jsAllowed: boolean
}

type RowAction = 'select' | 'edit' | 'toggle' | 'menu' | 'more'

/** Where the row menu opens: at the pointer, or under the row's ⋯ button (right-aligned to it). */
interface MenuAt {
  id: string
  x: number
  y: number
  /** Aligned by its right edge to x (under the ⋯ button). */
  end: boolean
  /** Opened with the keyboard: its first item takes the focus. */
  byKey: boolean
}

/** What a row says of the site: the host, unless the name already is it, and whether subdomains count. */
function siteLine(row: Row): string {
  if (row.name === row.host) return row.subdomains ? 'and its subdomains' : ''
  return row.subdomains ? `${row.host} and its subdomains` : row.host
}

/**
 * The Library's Tweaks (BO-15): every Tweak on this device, a site's together. Each row shows the
 * name and the site, a JS badge where it has JavaScript and a switch that turns it on or off at once.
 * Right-click or ⋯ offers Edit, Open Site, Rename… and Delete… (which asks). Keys: ↑↓ choose a row,
 * Enter edits, Space switches, F2 renames, Delete asks to delete, Shift+F10 opens the menu. With no
 * Tweaks, a short explanation and Tweak This Site; with Tweaks off as a whole (BO-16), a note to turn
 * them back on.
 */
export function TweaksSection({ show }: LibrarySectionProps) {
  const tweaks = useOrbit((s) => s.tweaks)
  const allowed = useOrbit((s) => s.settings.tweaksEnabled)
  const site = useTweakSite(window.orbit.windowId)
  const rows = useMemo<Row[]>(
    () =>
      tweaksByHost(tweaks).map((t) => ({
        id: t.id,
        name: t.name,
        host: t.host,
        subdomains: t.subdomains,
        enabled: t.enabled,
        js: t.js.trim() !== '',
        jsAllowed: t.jsAllowed,
      })),
    [tweaks],
  )
  const [highlight, setHighlight] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuAt | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [ask, setAsk] = useState<Row | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Each open of the Library starts afresh, and the list takes the keys.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs for each open of the Library
  useEffect(() => {
    setMenu(null)
    setRenaming(null)
    setAsk(null)
    listRef.current?.focus()
  }, [show.nonce])

  const at = highlight ? rows.findIndex((r) => r.id === highlight) : -1
  const focusList = () => listRef.current?.focus()

  const edit = (id: string) => {
    if (allowed) void invoke('tweaks.open', { id, edit: true })
  }
  const openMenu = (row: Row, byKey: boolean) => {
    const button = listRef.current?.querySelector<HTMLElement>(`[data-id="${row.id}"] [data-testid="tweak-row-more"]`)
    const box = button?.getBoundingClientRect()
    if (box) setMenu({ id: row.id, x: box.right, y: box.bottom + 4, end: true, byKey })
  }

  // One stable handler for every row, reading the latest state: rows stay memoized.
  const act = useRef<(action: RowAction, row: Row, e?: MouseEvent) => void>(() => {})
  act.current = (action, row, e) => {
    setHighlight(row.id)
    if (action === 'edit') edit(row.id)
    else if (action === 'toggle') void invoke('tweaks.setEnabled', { id: row.id, enabled: !row.enabled })
    else if (action === 'menu' && e) setMenu({ id: row.id, x: e.clientX, y: e.clientY, end: false, byKey: false })
    else if (action === 'more') {
      if (menu?.id === row.id) setMenu(null)
      else openMenu(row, e?.detail === 0)
    }
  }
  const onAction = useCallback((action: RowAction, row: Row, e?: MouseEvent) => act.current(action, row, e), [])

  // A menu or a rename on a Tweak deleted meanwhile (in another window, say) is gone with it.
  const menuRow = menu ? rows.find((r) => r.id === menu.id) : undefined
  const renamingId = renaming && rows.some((r) => r.id === renaming) ? renaming : null

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (ask || renamingId || menuRow || e.nativeEvent.isComposing || rows.length === 0) return
    if ((e.target as HTMLElement).closest('input')) return
    const moves: Record<string, number> = {
      ArrowDown: at + 1,
      ArrowUp: at < 0 ? 0 : at - 1,
      Home: 0,
      End: rows.length - 1,
    }
    const move = moves[e.key]
    if (move !== undefined) {
      e.preventDefault()
      const next = rows[Math.max(0, Math.min(rows.length - 1, move))]
      if (next) setHighlight(next.id)
      focusList()
      return
    }
    // The other keys act on the highlighted row while the list itself has the keys (a button in a
    // row takes Enter and Space for itself).
    const row = rows[at]
    if (!row || e.target !== e.currentTarget) return
    const run = (fn: () => void) => {
      e.preventDefault()
      fn()
    }
    if (e.key === 'Enter') run(() => edit(row.id))
    else if (e.key === ' ') run(() => void invoke('tweaks.setEnabled', { id: row.id, enabled: !row.enabled }))
    else if (e.key === 'F2') run(() => setRenaming(row.id))
    else if (e.key === 'Delete' || e.key === 'Backspace') run(() => setAsk(row))
    else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) run(() => openMenu(row, true))
  }

  // The highlighted row stays in sight.
  useEffect(() => {
    if (highlight) listRef.current?.querySelector(`[data-id="${highlight}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  const closeMenu = useCallback((refocus: boolean) => {
    setMenu(null)
    if (refocus) listRef.current?.focus()
  }, [])

  const remove = (row: Row) => {
    setAsk(null)
    // The next row (or else the one before) is highlighted in its place.
    const i = rows.findIndex((r) => r.id === row.id)
    setHighlight((rows[i + 1] ?? rows[i - 1])?.id ?? null)
    void invoke('tweaks.delete', { id: row.id })
    requestAnimationFrame(focusList)
  }

  const create = async () => {
    await invoke('library.close', {})
    await invoke('tweaks.create', {})
  }

  return (
    <section className="archive tweak-lib" data-testid="tweaks-section">
      <header className="archive__header">
        <div className="archive__heading">
          <h1 className="archive__title">Tweaks</h1>
          {rows.length > 0 && (
            <span className="archive__count" data-testid="tweaks-count">
              {rows.length === 1 ? '1 Tweak' : `${rows.length} Tweaks`}
            </span>
          )}
        </div>
        <p className="backups__intro">
          Tweaks change how websites look, on this device only. Right-click one to edit, rename or delete it.
        </p>
        {!allowed && (
          <div className="tweak-lib__off" role="status" data-testid="tweaks-off">
            <span>Tweaks are turned off: no website shows them, and no new one can be made.</span>
            <button
              type="button"
              className="archive__button"
              data-testid="tweaks-turn-on"
              onClick={() => void invoke('tweaks.setGlobal', { enabled: true })}
            >
              Turn On
            </button>
          </div>
        )}
      </header>
      <div
        ref={listRef}
        className={`tweak-lib__list${allowed ? '' : ' is-paused'}`}
        role="listbox"
        aria-label="Tweaks"
        tabIndex={-1}
        data-testid="tweaks-list"
        onKeyDown={onKeyDown}
      >
        {rows.map((row) => (
          <TweakRow
            key={row.id}
            row={row}
            highlighted={row.id === highlight}
            menuOpen={menuRow?.id === row.id}
            renaming={renamingId === row.id}
            onAction={onAction}
            onRenamed={() => {
              setRenaming(null)
              requestAnimationFrame(focusList)
            }}
          />
        ))}
        {rows.length === 0 && (
          <div className="archive__empty" data-testid="tweaks-empty">
            <p className="archive__empty-title">No Tweaks yet</p>
            <p>A Tweak changes how a website looks: its colours, fonts and size, or what it shows.</p>
            <button
              type="button"
              className="archive__button tweak-lib__create"
              data-testid="tweaks-create"
              disabled={!allowed || !site.host}
              title={site.host ? `A new Tweak for ${site.host}` : 'Open a website to tweak it'}
              onClick={() => void create()}
            >
              <Paintbrush size={14} aria-hidden />
              Tweak This Site
            </button>
          </div>
        )}
      </div>
      {menu && menuRow && (
        <RowMenu
          at={menu}
          row={menuRow}
          allowed={allowed}
          onClose={closeMenu}
          onEdit={() => {
            closeMenu(false)
            edit(menuRow.id)
          }}
          onOpen={() => {
            closeMenu(false)
            void invoke('tweaks.open', { id: menuRow.id })
          }}
          onRename={() => {
            closeMenu(false)
            setRenaming(menuRow.id)
          }}
          onDelete={() => {
            closeMenu(false)
            setAsk(menuRow)
          }}
        />
      )}
      {ask && (
        <ConfirmDialog
          title={`Delete “${ask.name}”?`}
          confirmLabel="Delete"
          destructive
          testId="tweaks-delete-confirm"
          onConfirm={() => remove(ask)}
          onCancel={() => {
            setAsk(null)
            requestAnimationFrame(focusList)
          }}
        >
          <p>Its changes leave {ask.host} at once.</p>
          {ask.js && <p>Pages its JavaScript already ran on are back to normal when they next load.</p>}
        </ConfirmDialog>
      )}
    </section>
  )
}

interface RowProps {
  row: Row
  highlighted: boolean
  menuOpen: boolean
  renaming: boolean
  onAction: (action: RowAction, row: Row, e?: MouseEvent) => void
  onRenamed: () => void
}

/** Rows are made afresh with each change to any Tweak: a row draws again only when what it shows changed. */
const sameRow = (a: RowProps, b: RowProps) =>
  a.highlighted === b.highlighted &&
  a.menuOpen === b.menuOpen &&
  a.renaming === b.renaming &&
  a.onAction === b.onAction &&
  (Object.keys(a.row) as (keyof Row)[]).every((k) => a.row[k] === b.row[k])

const TweakRow = memo(function TweakRow({ row, highlighted, menuOpen, renaming, onAction, onRenamed }: RowProps) {
  const site = siteLine(row)
  return (
    <div
      className={`tweak-lib-row${highlighted ? ' is-highlighted' : ''}${row.enabled ? '' : ' is-off'}`}
      role="option"
      aria-selected={highlighted}
      data-testid="tweak-row"
      data-id={row.id}
      data-on={row.enabled ? 'true' : 'false'}
      onClick={() => onAction('select', row)}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest('button, input')) onAction('edit', row)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onAction('menu', row, e)
      }}
    >
      <Paintbrush size={15} className="tweak-lib-row__icon" aria-hidden />
      <span className="tweak-lib-row__text">
        {renaming ? (
          <RenameField row={row} done={onRenamed} />
        ) : (
          <span className="tweak-lib-row__name" data-testid="tweak-row-name">
            {row.name}
          </span>
        )}
        {site && (
          <span className="tweak-lib-row__site" data-testid="tweak-row-site">
            {site}
          </span>
        )}
      </span>
      {row.js ? (
        <span
          className={`tweak-lib-row__badge${row.jsAllowed ? '' : ' is-blocked'}`}
          data-testid="tweak-row-js"
          title={
            row.jsAllowed
              ? 'This Tweak runs JavaScript'
              : 'This Tweak has JavaScript, not allowed to run on this device'
          }
        >
          JS
        </span>
      ) : (
        <span aria-hidden />
      )}
      <button
        type="button"
        role="switch"
        className="tweak-lib-switch"
        aria-checked={row.enabled}
        aria-label={row.name}
        title={row.enabled ? 'On: turn this Tweak off' : 'Off: turn this Tweak on'}
        data-testid="tweak-row-switch"
        onClick={(e) => {
          e.stopPropagation()
          onAction('toggle', row)
        }}
      >
        <span className="tweak-lib-switch__knob" />
      </button>
      <button
        type="button"
        className="tweak-lib-row__more"
        aria-label={`More for ${row.name}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="Edit, Open Site, Rename or Delete"
        data-testid="tweak-row-more"
        onClick={(e) => {
          e.stopPropagation()
          onAction('more', row, e)
        }}
      >
        <MoreHorizontal size={15} />
      </button>
    </div>
  )
}, sameRow)

/** The name, edited in place: Enter (or leaving the field) keeps it, Esc leaves it as it was. */
function RenameField({ row, done }: { row: Row; done: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const finished = useRef(false)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const finish = (keep: boolean) => {
    if (finished.current) return
    finished.current = true
    const name = input.current?.value.trim() ?? ''
    if (keep && name && name !== row.name) updateTweak(row.id, { name })
    done()
  }
  return (
    <input
      ref={input}
      className="tweak-lib-row__rename"
      data-testid="tweak-row-rename"
      aria-label="Name"
      defaultValue={row.name}
      maxLength={TWEAK_LIMITS.name}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          // The rename goes, not the Library.
          e.preventDefault()
          finish(false)
        }
      }}
      onBlur={() => finish(true)}
    />
  )
}

/**
 * A row's menu (BO-15), in the Library's own page: Edit, Open Site, Rename…, Delete…. ↑↓ move, Esc
 * and Tab close it (not the Library), a press elsewhere closes it.
 */
function RowMenu({
  at,
  row,
  allowed,
  onClose,
  onEdit,
  onOpen,
  onRename,
  onDelete,
}: {
  at: MenuAt
  row: Row
  allowed: boolean
  onClose: (refocus: boolean) => void
  onEdit: () => void
  onOpen: () => void
  onRename: () => void
  onDelete: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Inside the window, flipped above the point when there is no room below; placed before it
  // paints, then it takes the keys (its first item, when opened with the keyboard).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const left = Math.max(8, Math.min(at.end ? at.x - width : at.x, window.innerWidth - width - 8))
    const top = at.y + height <= window.innerHeight - 8 ? at.y : Math.max(8, at.y - height - (at.end ? 34 : 0))
    el.style.left = `${left}px`
    el.style.top = `${top}px`
    const items = el.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')
    ;(at.byKey ? items[0] : el)?.focus()
  }, [at])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element
      // The row's ⋯ closes it itself, on its click.
      if (ref.current?.contains(target) || target.closest?.(`[data-id="${row.id}"] .tweak-lib-row__more`)) return
      onClose(false)
    }
    const onBlur = () => onClose(false)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [onClose, row.id])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // The menu's keys stay in it: the list underneath and the Library don't act on them.
    e.stopPropagation()
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      onClose(true)
      return
    }
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    const n = items.length
    const moves: Record<string, number> = { ArrowDown: (i + 1) % n, ArrowUp: (i <= 0 ? n : i) - 1, Home: 0, End: n - 1 }
    const next = moves[e.key]
    if (next === undefined) return
    e.preventDefault()
    items[next]?.focus()
  }

  return (
    <div
      ref={ref}
      className="tweak-lib-menu"
      role="menu"
      aria-label={row.name}
      tabIndex={-1}
      data-testid="tweaks-menu"
      style={{ left: at.x, top: at.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        type="button"
        role="menuitem"
        className="tweak-lib-menu__item"
        data-testid="tweaks-menu-edit"
        disabled={!allowed}
        title={allowed ? undefined : 'Tweaks are turned off'}
        onClick={onEdit}
      >
        <SquarePen size={14} aria-hidden />
        Edit
      </button>
      <button
        type="button"
        role="menuitem"
        className="tweak-lib-menu__item"
        data-testid="tweaks-menu-open"
        onClick={onOpen}
      >
        <ExternalLink size={14} aria-hidden />
        Open Site
      </button>
      <button
        type="button"
        role="menuitem"
        className="tweak-lib-menu__item"
        data-testid="tweaks-menu-rename"
        onClick={onRename}
      >
        <Pencil size={14} aria-hidden />
        Rename…
      </button>
      <div className="tweak-lib-menu__line" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="tweak-lib-menu__item is-danger"
        data-testid="tweaks-menu-delete"
        onClick={onDelete}
      >
        <Trash2 size={14} aria-hidden />
        Delete…
      </button>
    </div>
  )
}
