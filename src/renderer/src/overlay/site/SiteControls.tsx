import {
  CircleAlert,
  FileText,
  Globe,
  Laptop,
  Minus,
  PictureInPicture2,
  Plus,
  RotateCw,
  TriangleAlert,
  X,
} from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { sitePipMode } from '../../../../shared/media'
import type { Connection } from '../../../../shared/nav'
import {
  DEVICE_NAME,
  PERMISSION_NAME,
  type PermissionKind,
  SITE_PANEL,
  type SiteControlsInfo,
  type SitePermissionRow,
} from '../../../../shared/site'
import type { OverlayState } from '../../../../shared/state'
import { invoke } from '../../api'
import { DEVICE_ICON, PERMISSION_ICON } from '../../shell/chrome/PermissionPrompt'
import { useOrbit } from '../../store'
import './site.css'

type PanelOverlay = Extract<OverlayState, { kind: 'panel' }>

const close = () => invoke('overlay.close', {})

const STATE_LABEL: Record<SitePermissionRow['state'], string> = {
  allow: 'Allowed',
  block: 'Blocked',
  once: 'Allowed this time',
  ask: 'Ask',
}

function connectionLine(connection: Connection): { icon: ReactNode; text: string; warn?: boolean } {
  switch (connection) {
    case 'secure':
      return { icon: <Globe size={14} />, text: 'Connection is secure' }
    case 'insecure':
      return {
        icon: <TriangleAlert size={14} />,
        text: 'Not secure: what you send to this site could be seen by others',
        warn: true,
      }
    case 'local':
      return { icon: <Laptop size={14} />, text: 'A page on this device' }
    case 'file':
      return { icon: <FileText size={14} />, text: 'A file on this device' }
    default:
      return { icon: <CircleAlert size={14} />, text: 'An Orbit page' }
  }
}

/**
 * The site controls panel (NV-16), drawn in the overlay under the address display (or at the
 * page's corner while the sidebar is hidden). It shows the active tab's site and connection, the
 * permissions the site was given, refused or asked for with a switch each (pop-ups too), devices
 * it may use, zoom with a reset, and clearing its cookies and data. Changes apply at once; when the
 * page only sees them after a reload, a Reload button says so. Esc or a click outside closes it;
 * arrows move between its controls.
 */
export function SiteControls({ overlay, dark = false }: { overlay: PanelOverlay; dark?: boolean }) {
  const params = overlay.params ?? {}
  const tabId = typeof params.tabId === 'string' ? params.tabId : ''
  const x = typeof params.x === 'number' ? params.x : SITE_PANEL.margin
  const y = typeof params.y === 'number' ? params.y : SITE_PANEL.margin
  const [info, setInfo] = useState<SiteControlsInfo | null | undefined>(undefined)
  const [confirmClear, setConfirmClear] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const focused = useRef(false)

  // What the page is and what it was given: again after each change, and when the tab moves on.
  const url = useOrbit((s) => s.tabs[tabId]?.url)
  const blockedPopups = useOrbit((s) => s.tabs[tabId]?.blockedPopups)
  const refresh = useCallback(() => {
    void invoke('site.info', { tabId }).then(setInfo)
  }, [tabId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: asks again when the page or its blocked pop-ups change
  useEffect(() => {
    refresh()
  }, [refresh, url, blockedPopups])
  // The tab went away: nothing to show.
  const exists = useOrbit((s) => !!s.tabs[tabId])
  useEffect(() => {
    if (!exists) void close()
  }, [exists])

  // Placed under the point main gave, kept inside the window.
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y })
  useLayoutEffect(() => {
    const el = panel.current
    if (!el) return
    const place = () => {
      const { margin } = SITE_PANEL
      const w = el.offsetWidth
      const h = el.offsetHeight
      const left = Math.max(margin, Math.min(x, window.innerWidth - margin - w))
      const top = Math.max(margin, Math.min(y, window.innerHeight - margin - h))
      setPos((p) => (p.left === left && p.top === top ? p : { left, top }))
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(el)
    window.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [x, y])

  // Keyboard focus goes to the panel once it has something in it (KS-19).
  useEffect(() => {
    if (info === undefined || focused.current) return
    focused.current = true
    panel.current?.focus()
  }, [info])

  // Esc closes it (or backs out of clearing data) wherever focus is: a control that went away (Reset
  // permissions once there is nothing left to reset) leaves it on the page's body.
  const confirming = useRef(confirmClear)
  confirming.current = confirmClear
  useEffect(() => {
    const onEscape = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      if (confirming.current) setConfirmClear(false)
      else void close()
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [])

  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (!step || !panel.current) return
    const controls = [...panel.current.querySelectorAll<HTMLElement>('button:not(:disabled)')]
    if (controls.length === 0) return
    e.preventDefault()
    const at = controls.indexOf(document.activeElement as HTMLElement)
    const next = at < 0 ? (step > 0 ? 0 : controls.length - 1) : (at + step + controls.length) % controls.length
    controls[next]?.focus()
  }

  const setPermission = async (kind: PermissionKind, allowed: boolean) => {
    await invoke('site.setPermission', { tabId, kind, allowed })
    refresh()
  }
  const zoom = async (id: 'page.zoomIn' | 'page.zoomOut' | 'page.zoomReset') => {
    await invoke('action.run', { id })
    refresh()
  }

  const conn = info ? connectionLine(info.connection) : null
  return (
    <div
      ref={panel}
      className={`site-panel${dark ? ' is-dark' : ''}`}
      role="dialog"
      aria-label="Site controls"
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top, width: SITE_PANEL.width }}
      data-testid="site-controls"
      onKeyDown={onKeyDown}
    >
      {info === null && <p className="site-panel__note">Nothing to show for this tab.</p>}
      {info && conn && (
        <>
          <header className="site-panel__head">
            <div className="site-panel__host" data-testid="site-controls-host" title={info.url}>
              {info.host}
            </div>
            <div
              className={`site-panel__connection${conn.warn ? ' is-warning' : ''}`}
              data-testid="site-controls-connection"
              data-connection={info.connection}
            >
              {conn.icon}
              <span>{conn.text}</span>
            </div>
            <button
              type="button"
              className="site-panel__close"
              aria-label="Close"
              title="Close"
              onClick={() => void close()}
            >
              <X size={13} />
            </button>
          </header>

          {info.reload && (
            <div className="site-panel__reload" data-testid="site-controls-reload">
              <span>Reload this page to apply your changes.</span>
              <button
                type="button"
                className="site-panel__button is-primary"
                onClick={async () => {
                  await close()
                  await invoke('action.run', { id: 'nav.reload' })
                }}
              >
                <RotateCw size={12} /> Reload
              </button>
            </div>
          )}

          {info.web && (
            <section className="site-panel__section" aria-label="Permissions">
              <h3 className="site-panel__title">Permissions</h3>
              {info.permissions.length === 0 ? (
                <p className="site-panel__note" data-testid="site-controls-no-permissions">
                  This site hasn’t asked for any permissions.
                </p>
              ) : (
                <ul className="site-panel__rows">
                  {info.permissions.map((row) => (
                    <PermissionRow key={row.kind} row={row} onChange={(on) => void setPermission(row.kind, on)} />
                  ))}
                </ul>
              )}
            </section>
          )}

          {info.devices.length > 0 && (
            <section className="site-panel__section" aria-label="Devices">
              <h3 className="site-panel__title">Devices</h3>
              <ul className="site-panel__rows">
                {info.devices.map((device) => {
                  const Icon = DEVICE_ICON[device.type]
                  return (
                    <li key={device.key} className="site-panel__row" data-testid="site-controls-device">
                      <Icon size={14} aria-hidden />
                      <span className="site-panel__name" title={DEVICE_NAME[device.type]}>
                        {device.name}
                      </span>
                      <button
                        type="button"
                        className="site-panel__icon-button"
                        aria-label={`Stop letting this site use ${device.name}`}
                        title="Remove"
                        onClick={async () => {
                          await invoke('site.revokeDevice', { tabId, key: device.key })
                          refresh()
                        }}
                      >
                        <X size={13} />
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}

          {info.web && <PipRow url={info.url} />}

          <section className="site-panel__section" aria-label="Zoom">
            <div className="site-panel__row site-panel__zoom">
              <span className="site-panel__name">Zoom</span>
              <button
                type="button"
                className="site-panel__icon-button"
                aria-label="Zoom out"
                onClick={() => void zoom('page.zoomOut')}
              >
                <Minus size={13} />
              </button>
              <span className="site-panel__zoom-value" data-testid="site-controls-zoom">
                {info.zoom}%
              </span>
              <button
                type="button"
                className="site-panel__icon-button"
                aria-label="Zoom in"
                onClick={() => void zoom('page.zoomIn')}
              >
                <Plus size={13} />
              </button>
              {info.zoom !== 100 && (
                <button
                  type="button"
                  className="site-panel__button"
                  data-testid="site-controls-zoom-reset"
                  onClick={() => void zoom('page.zoomReset')}
                >
                  Reset
                </button>
              )}
            </div>
          </section>

          {info.web && (
            <footer className="site-panel__foot">
              {info.permissions.some((r) => r.state !== 'ask') || info.devices.length > 0 ? (
                <button
                  type="button"
                  className="site-panel__link"
                  data-testid="site-controls-reset"
                  onClick={async () => {
                    await invoke('site.resetPermissions', { tabId })
                    refresh()
                  }}
                >
                  Reset permissions
                </button>
              ) : null}
              {confirmClear ? (
                <div className="site-panel__confirm" data-testid="site-controls-clear-confirm">
                  <span>
                    Clear cookies and site data for {info.host}? You may be signed out of this site
                    {info.private ? '' : ' in this profile'}.
                  </span>
                  <div className="site-panel__confirm-buttons">
                    <button type="button" className="site-panel__button" onClick={() => setConfirmClear(false)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="site-panel__button is-danger"
                      data-testid="site-controls-clear-ok"
                      onClick={async () => {
                        setConfirmClear(false)
                        await invoke('site.clearData', { tabId })
                        refresh()
                      }}
                    >
                      Clear
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="site-panel__link"
                  data-testid="site-controls-clear"
                  onClick={() => setConfirmClear(true)}
                >
                  Clear cookies and site data…
                </button>
              )}
              {info.private && (
                <p className="site-panel__note">Choices here last until the last private window closes.</p>
              )}
            </footer>
          )}
        </>
      )}
    </div>
  )
}

/**
 * Automatic picture-in-picture for this site (MD-08), on by default. It shows the player menu's
 * "Turn off for today" and "Always turn off for this site" too, and switching it on undoes either.
 */
function PipRow({ url }: { url: string }) {
  const allSites = useOrbit((s) => s.settings.autoPip)
  const mode = useOrbit((s) => sitePipMode(s.settings, url, Date.now()))
  const on = mode === 'on'
  const state = mode === 'today' ? 'Off for today' : !on ? 'Off' : allSites ? 'On' : 'Off for every site in Settings'
  return (
    <section className="site-panel__section" aria-label="Picture in Picture">
      <ul className="site-panel__rows">
        <li className="site-panel__row" data-testid="site-controls-pip" data-mode={mode}>
          <PictureInPicture2 size={14} aria-hidden />
          <span className="site-panel__name" title="Videos float when you leave their tab">
            Picture in Picture
            <span className="site-panel__state">{state}</span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label="Picture in Picture"
            className={`site-switch${on ? ' is-on' : ''}`}
            data-testid="site-switch-pip"
            onClick={() => void invoke('media.setSitePip', { url, mode: on ? 'always' : 'on' })}
          >
            <span className="site-switch__knob" />
          </button>
        </li>
      </ul>
    </section>
  )
}

function PermissionRow({ row, onChange }: { row: SitePermissionRow; onChange: (on: boolean) => void }) {
  const Icon = PERMISSION_ICON[row.kind]
  const on = row.state === 'allow' || row.state === 'once'
  const name = PERMISSION_NAME[row.kind]
  return (
    <li className="site-panel__row" data-testid="site-controls-permission" data-kind={row.kind} data-state={row.state}>
      <Icon size={14} aria-hidden />
      <span className="site-panel__name">
        {name}
        <span className="site-panel__state">{STATE_LABEL[row.state]}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={name}
        className={`site-switch${on ? ' is-on' : ''}`}
        data-testid={`site-switch-${row.kind}`}
        onClick={() => onChange(!on)}
      >
        <span className="site-switch__knob" />
      </button>
    </li>
  )
}
