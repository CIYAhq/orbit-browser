import {
  Check,
  ChevronRight,
  Columns2,
  FolderPlus,
  LayoutGrid,
  Moon,
  Palette,
  Pencil,
  Plus,
  Smile,
  Sparkles,
  Sun,
  Trash2,
  UserRound,
} from 'lucide-react'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { SPACE_PANELS, type SpacePanel } from '../../../../shared/commands/spaces'
import { DEFAULT_PROFILE_ID } from '../../../../shared/defaults'
import type { ColorMode, OverlayState, SpaceId, SpaceTheme } from '../../../../shared/state'
import { invoke, runAction } from '../../api'
import { useOrbit } from '../../store'
import { EmojiPicker } from './EmojiPicker'
import { ThemeEditor } from './ThemeEditor'
import './spaces.css'

type PanelOverlay = Extract<OverlayState, { kind: 'panel' }>

const close = () => invoke('overlay.close', {})

function openPanel(panel: SpacePanel, params: Record<string, string | number | boolean>) {
  void invoke('overlay.open', { overlay: { kind: 'panel', panel, params } })
}

/** True for overlay panels this lane draws (see SpacePanel). */
export function isSpacePanel(panel: string): panel is SpacePanel {
  return (SPACE_PANELS as readonly string[]).includes(panel)
}

/**
 * Space surfaces drawn in the overlay renderer: they float over the sidebar
 * and the page, take the Space theme (SP-16) and close on Escape or a click
 * outside (the overlay backdrop).
 */
export function SpacePanels({ overlay }: { overlay: PanelOverlay }) {
  const params = overlay.params ?? {}
  const str = (k: string) => (typeof params[k] === 'string' ? (params[k] as string) : undefined)
  const num = (k: string) => (typeof params[k] === 'number' ? (params[k] as number) : undefined)
  const spaceId = str('spaceId') ?? ''
  const x = num('x')
  const y = num('y')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        void close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  switch (overlay.panel as SpacePanel) {
    case 'space-menu':
      return <SpaceMenu spaceId={spaceId} x={x ?? 0} y={y ?? 0} sidebar={params.sidebar === true} />
    case 'space-plus-menu':
      return <PlusMenu x={x ?? 0} y={y ?? 0} />
    case 'space-theme':
      return <ThemePanel spaceId={spaceId} />
    case 'space-icon':
      return <IconPanel spaceId={spaceId} x={x} y={y} />
    case 'space-delete':
      return <DeleteSpaceDialog spaceId={spaceId} />
    case 'profile-new':
      return <NewProfileDialog spaceId={str('spaceId')} />
    default:
      return null
  }
}

// ---- Positioning ----

/** Places a floating box at (x, y), flipping/clamping it inside the window. */
function useFloating(x: number, y: number, align: 'start' | 'end' = 'start', above = false) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const margin = 8
    let left = align === 'end' ? x - w : x
    let top = above ? y - h - 6 : y
    if (left + w > window.innerWidth - margin) left = window.innerWidth - margin - w
    if (top + h > window.innerHeight - margin) top = Math.max(margin, y - h)
    left = Math.max(margin, left)
    top = Math.max(margin, top)
    setPos({ left, top })
  }, [x, y, align, above])
  // Layout effects run before paint, so the first position is never seen; the box
  // stays visible so children can take focus on mount.
  return { ref, style: pos ? { left: pos.left, top: pos.top } : { left: x, top: y } }
}

// ---- Menus ----

interface MenuItem {
  id: string
  label: string
  icon?: ReactNode
  hint?: string
  disabled?: boolean
  checked?: boolean
  danger?: boolean
  submenu?: MenuItem[]
  run?: () => void
}

type MenuEntry = MenuItem | 'separator'

function Menu({
  entries,
  x,
  y,
  align,
  above,
  testId,
  label,
}: {
  entries: MenuEntry[]
  x: number
  y: number
  align?: 'start' | 'end'
  above?: boolean
  testId: string
  label: string
}) {
  const { ref, style } = useFloating(x, y, align, above)
  const items = entries.filter((e): e is MenuItem => e !== 'separator')
  const [focus, setFocus] = useState(-1)
  const [openSub, setOpenSub] = useState<string | null>(null)
  useLayoutEffect(() => {
    ref.current?.focus()
  }, [ref])
  const activate = (item: MenuItem | undefined) => {
    if (!item || item.disabled) return
    if (item.submenu) setOpenSub(item.id)
    else item.run?.()
  }
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const pos = enabled.indexOf(focus)
      const next =
        e.key === 'ArrowDown'
          ? (enabled[(pos + 1) % enabled.length] ?? -1)
          : (enabled[(pos - 1 + enabled.length) % enabled.length] ?? -1)
      setFocus(next)
      setOpenSub(null)
    } else if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
      e.preventDefault()
      activate(items[focus])
    } else if (e.key === 'ArrowLeft') {
      setOpenSub(null)
    }
  }
  return (
    <div
      ref={ref}
      className="space-menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      data-testid={testId}
      style={style}
      onKeyDown={onKeyDown}
    >
      {entries.map((entry, i) => {
        if (entry === 'separator') {
          // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity
          return <div key={`sep-${i}`} className="space-menu__separator" role="separator" />
        }
        const index = items.indexOf(entry)
        return (
          <div key={entry.id} className="space-menu__wrap">
            <button
              type="button"
              role="menuitem"
              className={`space-menu__item${index === focus ? ' is-focused' : ''}${entry.danger ? ' is-danger' : ''}`}
              data-testid={`menu-${entry.id}`}
              disabled={entry.disabled}
              aria-haspopup={entry.submenu ? 'menu' : undefined}
              aria-expanded={entry.submenu ? openSub === entry.id : undefined}
              title={entry.hint}
              onMouseEnter={() => {
                setFocus(index)
                setOpenSub(entry.submenu ? entry.id : null)
              }}
              onClick={() => activate(entry)}
            >
              <span className="space-menu__icon">{entry.checked ? <Check size={14} /> : entry.icon}</span>
              <span className="space-menu__label">{entry.label}</span>
              {entry.submenu ? <ChevronRight size={14} className="space-menu__more" /> : null}
            </button>
            {entry.submenu && openSub === entry.id ? (
              <div className="space-menu space-menu--sub" role="menu" data-testid={`menu-${entry.id}-sub`}>
                {entry.submenu.map((sub) => (
                  <button
                    key={sub.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={sub.checked}
                    className="space-menu__item"
                    data-testid={`menu-${sub.id}`}
                    disabled={sub.disabled}
                    onClick={() => sub.run?.()}
                  >
                    <span className="space-menu__icon">{sub.checked ? <Check size={14} /> : sub.icon}</span>
                    <span className="space-menu__label">{sub.label}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

const run = (fn: () => unknown) => () => {
  void Promise.resolve(fn())
}

/** The Space menu (SP-04): Theme, Change Icon, Profile ▸, Rename, Manage Spaces, Delete Space. */
function SpaceMenu({ spaceId, x, y, sidebar }: { spaceId: SpaceId; x: number; y: number; sidebar: boolean }) {
  const space = useOrbit((s) => s.spaces[spaceId])
  const profiles = useOrbit((s) => s.profiles)
  const count = useOrbit((s) => s.spaceOrder.length)
  if (!space) return null
  const profileItems: MenuItem[] = Object.values(profiles)
    .sort((a, b) => (a.id === DEFAULT_PROFILE_ID ? -1 : b.id === DEFAULT_PROFILE_ID ? 1 : a.createdAt - b.createdAt))
    .map((p) => ({
      id: `profile-${p.id}`,
      label: p.name,
      checked: p.id === space.profileId,
      run: run(async () => {
        if (p.id !== space.profileId) await invoke('spaces.update', { spaceId, profileId: p.id })
        await close()
      }),
    }))
  profileItems.push({
    id: 'profile-new',
    label: 'New Profile…',
    icon: <Plus size={14} />,
    run: () => openPanel('profile-new', { spaceId }),
  })
  const entries: MenuEntry[] = []
  if (sidebar) {
    entries.push(
      {
        id: 'new-tab',
        label: 'New Tab',
        icon: <Plus size={14} />,
        run: run(async () => {
          await close()
          runAction('tab.new')
        }),
      },
      {
        id: 'new-folder',
        label: 'New Folder',
        icon: <FolderPlus size={14} />,
        run: run(async () => {
          await close()
          runAction('folder.new')
        }),
      },
      {
        id: 'new-space',
        label: 'New Space',
        icon: <LayoutGrid size={14} />,
        run: run(() => invoke('spaces.beginCreate', {})),
      },
      'separator',
    )
  }
  entries.push(
    { id: 'theme', label: 'Theme…', icon: <Palette size={14} />, run: () => openPanel('space-theme', { spaceId }) },
    {
      id: 'icon',
      label: 'Change Icon…',
      icon: <Smile size={14} />,
      run: () => openPanel('space-icon', { spaceId, x, y }),
    },
    { id: 'profile', label: 'Profile', icon: <UserRound size={14} />, submenu: profileItems },
    {
      id: 'rename',
      label: 'Rename',
      icon: <Pencil size={14} />,
      run: run(() => invoke('spaces.beginRename', { spaceId })),
    },
    {
      id: 'manage',
      label: 'Manage Spaces',
      icon: <LayoutGrid size={14} />,
      disabled: true,
      hint: 'The Spaces overview arrives with the Library',
    },
    'separator',
    {
      id: 'delete',
      label: 'Delete Space…',
      icon: <Trash2 size={14} />,
      danger: true,
      disabled: count <= 1,
      hint: count <= 1 ? 'The last Space can’t be deleted' : undefined,
      run: () => openPanel('space-delete', { spaceId }),
    },
  )
  return <Menu entries={entries} x={x} y={y} testId="space-menu" label={`${space.name} options`} />
}

/** The bottom bar's "+" menu (SB-09). */
function PlusMenu({ x, y }: { x: number; y: number }) {
  const act = (id: string) =>
    run(async () => {
      await close()
      runAction(id)
    })
  const entries: MenuEntry[] = [
    { id: 'plus-tab', label: 'New Tab', icon: <Plus size={14} />, run: act('tab.new') },
    {
      id: 'plus-space',
      label: 'New Space',
      icon: <LayoutGrid size={14} />,
      run: run(() => invoke('spaces.beginCreate', {})),
    },
    { id: 'plus-folder', label: 'New Folder', icon: <FolderPlus size={14} />, run: act('folder.new') },
    { id: 'plus-split', label: 'New Split View', icon: <Columns2 size={14} />, run: act('split.add') },
  ]
  return <Menu entries={entries} x={x} y={y} align="end" above testId="plus-menu" label="New" />
}

// ---- Theme picker (SP-14, SP-15, SP-17, SP-18) ----

const MODES: { mode: ColorMode; label: string; icon: ReactNode }[] = [
  { mode: 'system', label: 'Automatic', icon: <Sparkles size={14} /> },
  { mode: 'light', label: 'Light', icon: <Sun size={14} /> },
  { mode: 'dark', label: 'Dark', icon: <Moon size={14} /> },
]

function ThemePanel({ spaceId }: { spaceId: SpaceId }) {
  const theme = useOrbit((s) => s.spaces[spaceId]?.theme)
  const name = useOrbit((s) => s.spaces[spaceId]?.name)
  const appearance = useOrbit((s) => s.settings.appearance)
  const sidebar = useOrbit((s) => s.windows[window.orbit.windowId]?.sidebar)
  const [draft, setDraft] = useState<SpaceTheme | undefined>(theme)
  const pending = useRef<SpaceTheme | null>(null)
  const raf = useRef(0)
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    ref.current?.focus()
  }, [])
  useEffect(() => () => cancelAnimationFrame(raf.current), [])
  if (!draft || name === undefined) return null
  // Changes apply live at drag rate, at most once per frame (FL-14).
  const change = (next: SpaceTheme) => {
    setDraft(next)
    pending.current = next
    if (raf.current) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      const t = pending.current
      pending.current = null
      if (t) void invoke('spaces.update', { spaceId, theme: t })
    })
  }
  const left = sidebar?.visible ? sidebar.width + 10 : 10
  return (
    <div
      ref={ref}
      className="space-panel theme-panel"
      role="dialog"
      aria-label={`Theme for ${name}`}
      tabIndex={-1}
      data-testid="theme-picker"
      style={{ left, top: 44 }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
          e.preventDefault()
          void close()
        }
      }}
    >
      <div className="space-panel__title">
        <span>Theme</span>
        <span className="space-panel__subtitle">{name}</span>
      </div>
      <div className="mode-switch" role="radiogroup" aria-label="Appearance">
        {MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            role="radio"
            aria-checked={appearance === m.mode}
            className={`mode-switch__option${appearance === m.mode ? ' is-selected' : ''}`}
            data-testid={`appearance-${m.mode}`}
            title={
              m.mode === 'system' ? 'Match the system (applies to every Space)' : `${m.label} (applies to every Space)`
            }
            onClick={() => void invoke('spaces.setAppearance', { appearance: m.mode })}
          >
            {m.icon}
            <span>{m.label}</span>
          </button>
        ))}
      </div>
      <ThemeEditor theme={draft} onChange={change} />
    </div>
  )
}

// ---- Icon picker (SP-05) ----

function IconPanel({ spaceId, x, y }: { spaceId: SpaceId; x?: number; y?: number }) {
  const icon = useOrbit((s) => s.spaces[spaceId]?.icon)
  const sidebar = useOrbit((s) => s.windows[window.orbit.windowId]?.sidebar)
  const ax = x ?? (sidebar?.visible ? sidebar.width + 10 : 10)
  const { ref, style } = useFloating(ax, y ?? 44)
  if (icon === undefined) return null
  const set = async (value: string) => {
    await invoke('spaces.update', { spaceId, icon: value })
    await close()
  }
  return (
    <div
      ref={ref}
      className="space-panel icon-panel"
      role="dialog"
      aria-label="Space icon"
      data-testid="icon-picker"
      style={style}
    >
      <EmojiPicker
        autoFocus
        current={icon}
        onPick={(emoji: string) => void set(emoji)}
        onRemove={icon ? () => void set('') : undefined}
      />
    </div>
  )
}

// ---- Dialogs ----

function Dialog({ title, children, testId }: { title: string; children: ReactNode; testId: string }) {
  return (
    <div
      className="space-dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) void close()
      }}
    >
      <div className="space-dialog" role="alertdialog" aria-modal aria-label={title} data-testid={testId}>
        <h2 className="space-dialog__title">{title}</h2>
        {children}
      </div>
    </div>
  )
}

/** Delete confirmation naming the Space (SP-12). */
function DeleteSpaceDialog({ spaceId }: { spaceId: SpaceId }) {
  const name = useOrbit((s) => s.spaces[spaceId]?.name)
  const tabs = useOrbit((s) =>
    s.spaces[spaceId] ? s.spaces[spaceId].pinned.length + s.spaces[spaceId].today.length : 0,
  )
  const last = useOrbit((s) => s.spaceOrder.length <= 1)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => cancelRef.current?.focus(), [])
  if (name === undefined) return null
  const confirm = async () => {
    await invoke('spaces.delete', { spaceId })
    await close()
    // So ⌘Z right away reaches the sidebar's undo (SP-12).
    void invoke('spaces.focusShell', {})
  }
  return (
    <Dialog title={`Delete “${name}”?`} testId="space-delete-dialog">
      <p className="space-dialog__text">
        {tabs > 0
          ? 'Its pinned tabs, folders and Today tabs will be removed from the sidebar. You can still find them in the Archive.'
          : 'This Space has no tabs.'}{' '}
        Its profile, with its Favorites and logins, stays.
      </p>
      <div className="space-dialog__actions">
        <button
          ref={cancelRef}
          type="button"
          className="space-button"
          data-testid="space-delete-cancel"
          onClick={() => void close()}
        >
          Cancel
        </button>
        <button
          type="button"
          className="space-button is-danger"
          data-testid="space-delete-confirm"
          disabled={last}
          onClick={() => void confirm()}
        >
          Delete Space
        </button>
      </div>
    </Dialog>
  )
}

/** Name prompt for a new profile, assigned to the Space it came from (PR-02). */
function NewProfileDialog({ spaceId }: { spaceId?: SpaceId }) {
  const [name, setName] = useState('')
  const spaceName = useOrbit((s) => (spaceId ? s.spaces[spaceId]?.name : undefined))
  const create = async () => {
    if (!name.trim()) return
    await invoke('profiles.create', { name, assignSpaceId: spaceId })
    await close()
  }
  return (
    <Dialog title="New Profile" testId="profile-new-dialog">
      <p className="space-dialog__text">
        A profile keeps its own logins, cookies, history, extensions and Favorites.
        {spaceName ? ` “${spaceName}” will use it.` : ''}
      </p>
      <input
        autoFocus
        className="space-dialog__input"
        data-testid="profile-name"
        placeholder="Profile name"
        aria-label="Profile name"
        value={name}
        maxLength={60}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void create()
          }
        }}
      />
      <div className="space-dialog__actions">
        <button type="button" className="space-button" onClick={() => void close()}>
          Cancel
        </button>
        <button
          type="button"
          className="space-button is-primary"
          data-testid="profile-create"
          disabled={!name.trim()}
          onClick={() => void create()}
        >
          Create Profile
        </button>
      </div>
    </Dialog>
  )
}
