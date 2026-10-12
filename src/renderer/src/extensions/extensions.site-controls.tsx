import { MoreHorizontal, Pin, PinOff } from 'lucide-react'
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { StoreListing } from '../../../shared/commands/extensions'
import { extensionKey, panelExtensions, type SiteAccess, siteAccessOn } from '../../../shared/extensions'
import type { InstalledExtension, ProfileId, TabId } from '../../../shared/state'
import { invoke, runAction } from '../api'
import type { SiteControlsSection, SiteSectionProps } from '../overlay/site/registry'
import { useOrbit, useOrbitShallow } from '../store'
import { ExtensionIcon } from './ExtensionIcon'
import { runExtension } from './run'
import './extensions.css'
import './site.css'

/**
 * On a store listing page, Orbit's own way to add its extension (EX-01): for when the store's button
 * doesn't offer to install in Orbit. Main reads the extension's ID from the tab's own address,
 * downloads and checks the file, and asks in Orbit's dialog, which takes the panel's place.
 */
function StoreRow({ tabId }: { tabId: TabId }) {
  const url = useOrbit((s) => s.tabs[tabId]?.url)
  const profileId = useOrbit((s) => s.tabs[tabId]?.profileId)
  const [listing, setListing] = useState<StoreListing | null>(null)
  const [adding, setAdding] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: asks again when the tab's page changes
  useEffect(() => {
    let live = true
    void invoke('extensions.storeListing', { tabId }).then((found) => {
      if (live) setListing(found)
    })
    return () => {
      live = false
    }
  }, [tabId, url])
  const added = useOrbit((s) =>
    listing && profileId ? (s.extensions[extensionKey(profileId, listing.id)] ?? null) : null,
  )
  if (!listing) return null
  const add = async () => {
    setAdding(true)
    try {
      await invoke('extensions.installFromStore', { tabId })
    } finally {
      setAdding(false)
    }
  }
  return (
    <ul className="site-panel__rows" data-testid="ext-store">
      <li className="site-panel__row ext-site-row" data-testid="ext-store-row" data-state={added ? 'added' : 'new'}>
        <ExtensionIcon icon={added?.icon ?? ''} size={18} />
        <span className="site-panel__name">
          {added ? added.name : 'This extension'}
          <span className="site-panel__state">
            {added ? 'In this profile' : listing.private ? 'Not in a private window' : 'From the extension store'}
          </span>
        </span>
        {!added && !listing.private && (
          <button
            type="button"
            className="site-panel__button is-primary"
            data-testid="ext-store-add"
            disabled={adding}
            onClick={() => void add()}
          >
            {adding ? 'Adding…' : 'Add to Orbit'}
          </button>
        )}
      </li>
    </ul>
  )
}

const ACCESS_TEXT: Record<SiteAccess, string> = {
  all: 'On all sites',
  this: 'On this site',
  none: 'Not on this site',
}

/**
 * Where an extension may run, seen from the panel's page: null on a page no extension runs on
 * (Orbit's own, an extension's, a blank one), and on a file page it may not read (EX-07).
 */
function accessOf(ext: InstalledExtension, info: SiteSectionProps['info']): SiteAccess | null {
  if (info.web) return siteAccessOn(ext.hosts, info.url)
  if (info.url.startsWith('file:') && ext.allowFileAccess) return siteAccessOn(ext.hosts, info.url)
  return null
}

/** Where the row menu opens (window coordinates): under the ⋯ button, or at the pointer. */
interface MenuAt {
  id: string
  x: number
  y: number
  /** Right-aligned to x (under the ⋯ button). */
  end: boolean
  /** Opened from the keyboard: its first item takes focus. */
  byKey: boolean
}

interface MenuItem {
  key: string
  label: string
  disabled?: boolean
  title?: string
  run?: () => void
}

/**
 * A row's menu (EX-03): Pin to Top / Unpin, Options, its site access (shown, not changeable: the
 * engine gives an extension every site it asks for), Remove from Orbit and Manage Extensions. Drawn
 * in the panel; ↑↓ move, Enter chooses, Esc or a click outside closes it (not the panel).
 */
function RowMenu({ at, items, onClose }: { at: MenuAt; items: MenuItem[]; onClose: (refocus: boolean) => void }) {
  const menu = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: at.x, top: at.y })
  useLayoutEffect(() => {
    const el = menu.current
    if (!el) return
    const edge = 8
    const left = Math.max(
      edge,
      Math.min(at.end ? at.x - el.offsetWidth : at.x, window.innerWidth - edge - el.offsetWidth),
    )
    const top = Math.max(edge, Math.min(at.y, window.innerHeight - edge - el.offsetHeight))
    setPos({ left, top })
    if (at.byKey) el.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
    else el.focus()
  }, [at])
  // A click anywhere else closes it; that click goes on to what it was on.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node)) onClose(false)
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [onClose])
  const onKeyDown = (e: KeyboardEvent) => {
    const el = menu.current
    if (!el) return
    if (e.key === 'Escape') {
      // The menu's, not the panel's (its Esc closes the panel).
      e.preventDefault()
      e.stopPropagation()
      onClose(true)
      return
    }
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (!step && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    e.stopPropagation()
    const buttons = [...el.querySelectorAll<HTMLElement>('button:not(:disabled)')]
    if (buttons.length === 0) return
    const now = buttons.indexOf(document.activeElement as HTMLElement)
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? buttons.length - 1
          : now < 0
            ? step > 0
              ? 0
              : buttons.length - 1
            : (now + step + buttons.length) % buttons.length
    buttons[next]?.focus()
  }
  return (
    <div
      ref={menu}
      className="ext-menu"
      role="menu"
      tabIndex={-1}
      data-testid="ext-menu"
      data-ext={at.id}
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={onKeyDown}
    >
      {items.map((item) =>
        item.key.startsWith('-') ? (
          <div key={item.key} className="ext-menu__separator" role="separator" />
        ) : (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className="ext-menu__item"
            data-testid={`ext-menu-${item.key}`}
            disabled={item.disabled}
            title={item.title}
            onClick={() => {
              onClose(false)
              item.run?.()
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  )
}

/** An extension's row: its icon and name run it (its popup, EX-05); the pin and ⋯ beside them. */
function ExtensionRow({
  ext,
  access,
  menuOpen,
  onMenu,
}: {
  ext: InstalledExtension
  access: SiteAccess | null
  menuOpen: boolean
  onMenu: (ext: InstalledExtension, at: Omit<MenuAt, 'id'>) => void
}) {
  const pinned = ext.pinnedAt !== undefined
  const state = ext.error
    ? 'Isn’t running'
    : access === null
      ? ext.popup
        ? ''
        : 'No popup'
      : access === 'none'
        ? 'No access to this site'
        : 'Has access to this site'
  return (
    <li
      className={`site-panel__row ext-site-row${menuOpen ? ' is-menu-open' : ''}`}
      data-testid="ext-row"
      data-ext={ext.id}
      data-pinned={pinned ? 'true' : 'false'}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(ext, { x: e.clientX, y: e.clientY, end: false, byKey: false })
      }}
    >
      <button
        type="button"
        className="ext-site-row__run"
        data-testid="ext-run"
        title={ext.popup ? `Open ${ext.name}` : ext.name}
        onClick={(e) => runExtension(ext.id, ext.profileId, e.currentTarget.closest('li') ?? e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
            e.preventDefault()
            const r = e.currentTarget.getBoundingClientRect()
            onMenu(ext, { x: r.left + 24, y: r.bottom, end: false, byKey: true })
          }
        }}
      >
        <ExtensionIcon icon={ext.icon} size={18} />
        <span className="site-panel__name">
          <span className="ext-site-row__name">{ext.name}</span>
          {state && <span className="site-panel__state">{state}</span>}
        </span>
      </button>
      <button
        type="button"
        className={`site-panel__icon-button ext-site-row__pin${pinned ? ' is-pinned' : ''}`}
        data-testid="ext-pin-toggle"
        aria-pressed={pinned}
        aria-label={pinned ? `Unpin ${ext.name}` : `Pin ${ext.name}`}
        title={pinned ? 'Unpin' : 'Pin to the address field'}
        onClick={() => void invoke('extensions.pin', { id: ext.id, pinned: !pinned, profileId: ext.profileId })}
      >
        {pinned ? <PinOff size={13} /> : <Pin size={13} />}
      </button>
      <button
        type="button"
        className="site-panel__icon-button"
        data-testid="ext-more"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`More for ${ext.name}`}
        title="More"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          onMenu(ext, { x: r.right, y: r.bottom + 4, end: true, byKey: e.detail === 0 })
        }}
      >
        <MoreHorizontal size={14} />
      </button>
    </li>
  )
}

/**
 * The extensions of the tab's profile (EX-03): every enabled one with its icon and name, pinned
 * ones first. A click runs it (its popup, EX-05); the pin puts it in the address field (EX-04);
 * right-click or ⋯ opens its menu; Manage opens the extensions page (EX-07). Private windows run
 * no extension (EX-10).
 */
function ExtensionList({ tabId, info, close }: SiteSectionProps) {
  const profileId = useOrbit((s) => s.tabs[tabId]?.profileId) as ProfileId | undefined
  const devMode = useOrbit((s) => s.settings.extensionsDevMode)
  const listRef = useRef<HTMLDivElement>(null)
  const list = useOrbitShallow((s) => (profileId ? panelExtensions(s.extensions, profileId) : []))
  const [menu, setMenu] = useState<MenuAt | null>(null)
  const moreButton = useRef<HTMLElement | null>(null)
  const menuExt = menu ? list.find((e) => e.id === menu.id) : undefined
  // The extension went (removed, turned off) while its menu was open.
  useEffect(() => {
    if (menu && !menuExt) setMenu(null)
  }, [menu, menuExt])

  const manage = async () => {
    await close()
    runAction('extension.manage')
  }

  const openMenu = (ext: InstalledExtension, at: Omit<MenuAt, 'id'>) => {
    moreButton.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setMenu(menu?.id === ext.id ? null : { id: ext.id, ...at })
  }
  const closeMenu = (refocus: boolean) => {
    setMenu(null)
    if (refocus) moreButton.current?.focus()
  }

  const itemsFor = (ext: InstalledExtension): MenuItem[] => {
    const pinned = ext.pinnedAt !== undefined
    const where = accessOf(ext, info)
    const access = where ? ACCESS_TEXT[where] : 'Not on this page'
    const items: MenuItem[] = [
      {
        key: 'pin',
        label: pinned ? 'Unpin' : 'Pin to Top',
        run: () => void invoke('extensions.pin', { id: ext.id, pinned: !pinned, profileId: ext.profileId }),
      },
    ]
    if (devMode && ext.popup) {
      // Developer mode (EX-07): the popup with its DevTools, which keep it open (EX-05).
      items.push({
        key: 'inspect',
        label: 'Inspect Popup',
        run: () => {
          const row = listRef.current?.querySelector<HTMLElement>(`[data-testid="ext-row"][data-ext="${ext.id}"]`)
          if (row) runExtension(ext.id, ext.profileId, row, true)
        },
      })
    }
    if (ext.options) {
      items.push({
        key: 'options',
        label: 'Options',
        run: async () => {
          await close()
          await invoke('extensions.openOptions', { id: ext.id, profileId: ext.profileId })
        },
      })
    }
    items.push(
      { key: '-1', label: '' },
      {
        key: 'access',
        label: `Site access: ${access}`,
        disabled: true,
        title: 'It may run on the sites it asked for when it was added.',
      },
      { key: '-2', label: '' },
      {
        key: 'remove',
        label: 'Remove from Orbit…',
        run: () => void invoke('extensions.remove', { id: ext.id, profileId: ext.profileId }),
      },
      { key: 'manage', label: 'Manage Extensions', run: () => void manage() },
    )
    return items
  }

  return (
    <div className="ext-site" data-testid="ext-list" ref={listRef}>
      <div className="ext-site__head">
        <h3 className="site-panel__title">Extensions</h3>
        <button
          type="button"
          className="site-panel__link ext-site__manage"
          data-testid="ext-manage"
          onClick={() => void manage()}
        >
          Manage
        </button>
      </div>
      {info.private ? (
        <p className="site-panel__note" data-testid="ext-private">
          Extensions don’t run in private windows.
        </p>
      ) : list.length === 0 ? (
        <p className="site-panel__note" data-testid="ext-none">
          No extensions in this profile.
        </p>
      ) : (
        <ul className="site-panel__rows">
          {list.map((ext) => (
            <ExtensionRow
              key={ext.id}
              ext={ext}
              access={accessOf(ext, info)}
              menuOpen={menu?.id === ext.id}
              onMenu={openMenu}
            />
          ))}
        </ul>
      )}
      {menu && menuExt && <RowMenu at={menu} items={itemsFor(menuExt)} onClose={closeMenu} />}
    </div>
  )
}

/** The extensions part of the site controls panel (EX-01, EX-03). */
function ExtensionsSection(props: SiteSectionProps) {
  return (
    <section className="site-panel__section" aria-label="Extensions" data-testid="ext-section">
      <StoreRow tabId={props.tabId} />
      <ExtensionList {...props} />
    </section>
  )
}

export const section: SiteControlsSection = { id: 'extensions', order: 10, component: ExtensionsSection }
