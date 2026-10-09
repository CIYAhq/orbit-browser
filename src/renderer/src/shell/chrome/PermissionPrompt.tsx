import {
  AppWindow,
  Bell,
  Cable,
  ClipboardPaste,
  Gamepad2,
  Hourglass,
  type LucideIcon,
  MapPin,
  Mic,
  Network,
  Piano,
  SquareArrowOutUpRight,
  Type,
  Usb,
  Video,
  X,
} from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  DEVICE_ASK,
  type DeviceKind,
  PERMISSION_ASK,
  type PermissionKind,
  type PermissionPrompt as Prompt,
  type PromptChoice,
  siteLabel,
} from '../../../../shared/site'
import { invoke } from '../../api'
import { activeTabId } from '../../selectors'
import { useOrbit } from '../../store'
import './prompt.css'

export const PERMISSION_ICON: Record<PermissionKind, LucideIcon> = {
  camera: Video,
  microphone: Mic,
  location: MapPin,
  notifications: Bell,
  clipboard: ClipboardPaste,
  midi: Piano,
  idle: Hourglass,
  windows: AppWindow,
  fonts: Type,
  network: Network,
  popups: SquareArrowOutUpRight,
}

export const DEVICE_ICON: Record<DeviceKind, LucideIcon> = { serial: Cable, usb: Usb, hid: Gamepad2 }

/** The permission prompt waiting on a window's active tab (NV-15), if any. */
export function useActivePrompt(windowId: string): Prompt | undefined {
  return useOrbit((s) => {
    const id = activeTabId(s, windowId)
    return id ? s.tabs[id]?.permissionPrompt : undefined
  })
}

/**
 * The permission prompt (NV-15): a small card anchored under the address display at the top of
 * the sidebar (or over the page's top-left corner while the sidebar is hidden, in a view of its
 * own). It names the site and what it wants, with Chromium's choices: "Allow while visiting the
 * site", "Allow this time" and "Never allow" for the camera, microphone and location, "Allow" and
 * "Block" for the rest, or a list to pick a device or a screen from. The text wraps to the
 * sidebar's width. Esc (or the close button) dismisses it: the site may ask again later. Arrow
 * keys move between the choices; Enter takes one.
 */
export function PermissionPrompt({ prompt, onSize }: { prompt: Prompt; onSize?: (height: number) => void }) {
  const card = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)

  useLayoutEffect(() => {
    const el = card.current
    if (!el || !onSize) return
    onSize(el.offsetHeight)
    const observer = new ResizeObserver(() => onSize(el.offsetHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [onSize])

  const answer = (choice: PromptChoice, pick?: string) => {
    if (busy) return
    setBusy(true)
    void invoke('permissions.answer', { id: prompt.id, choice, pick }).finally(() => setBusy(false))
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      answer('dismiss')
      return
    }
    const step =
      e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
    if (!step || !card.current) return
    // Inside a list, arrows pick the next item (the list's own handler); elsewhere they move between buttons.
    if ((e.target as HTMLElement).closest('[role="listbox"]')) return
    const buttons = [...card.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([role="option"])')]
    if (buttons.length === 0) return
    e.preventDefault()
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = at < 0 ? (step > 0 ? 0 : buttons.length - 1) : (at + step + buttons.length) % buttons.length
    buttons[next]?.focus()
  }

  const site = siteLabel(prompt.origin)
  return (
    <div
      ref={card}
      className="perm-prompt"
      role="alertdialog"
      aria-label={`${site} permission request`}
      data-testid="permission-prompt"
      data-type={prompt.type}
      data-kinds={prompt.type === 'permission' ? prompt.kinds.join(' ') : undefined}
      onKeyDown={onKeyDown}
    >
      <div className="perm-prompt__head">
        <p className="perm-prompt__title">
          <span className="perm-prompt__site" data-testid="permission-site">
            {site}
          </span>{' '}
          {title(prompt)}
        </p>
        <button
          type="button"
          className="perm-prompt__close"
          aria-label="Close"
          title="Close"
          data-testid="permission-dismiss"
          onClick={() => answer('dismiss')}
        >
          <X size={13} />
        </button>
      </div>
      {prompt.type === 'permission' && <PermissionBody prompt={prompt} busy={busy} answer={answer} />}
      {prompt.type === 'device' && <DeviceBody prompt={prompt} busy={busy} answer={answer} />}
      {prompt.type === 'screen' && <ScreenBody prompt={prompt} busy={busy} answer={answer} />}
      {prompt.type === 'file' && (
        <Actions>
          <Choice testId="permission-block" disabled={busy} onClick={() => answer('block')}>
            Block
          </Choice>
          <Choice testId="permission-allow" primary disabled={busy} onClick={() => answer('allow')}>
            Allow
          </Choice>
        </Actions>
      )}
    </div>
  )
}

function title(prompt: Prompt): string {
  switch (prompt.type) {
    case 'permission':
      return 'wants to'
    case 'device':
      return `wants to ${DEVICE_ASK[prompt.device].toLowerCase()}`
    case 'screen':
      return 'wants to share your screen'
    case 'file': {
      const name = prompt.name ? `“${prompt.name}”` : prompt.directory ? 'a folder' : 'a file'
      if (prompt.write) return `wants to save changes to ${prompt.directory ? `files in ${name}` : name}`
      return `wants to see ${prompt.directory ? `the files in ${name}` : name}`
    }
  }
}

type Answer = (choice: PromptChoice, pick?: string) => void

function Actions({ children, stacked = false }: { children: ReactNode; stacked?: boolean }) {
  return <div className={`perm-prompt__actions${stacked ? ' is-stacked' : ''}`}>{children}</div>
}

function Choice({
  children,
  onClick,
  primary = false,
  disabled = false,
  testId,
}: {
  children: ReactNode
  onClick: () => void
  primary?: boolean
  disabled?: boolean
  testId: string
}) {
  return (
    <button
      type="button"
      className={`perm-prompt__choice${primary ? ' is-primary' : ''}`}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function PermissionBody({
  prompt,
  busy,
  answer,
}: {
  prompt: Extract<Prompt, { type: 'permission' }>
  busy: boolean
  answer: Answer
}) {
  return (
    <>
      <ul className="perm-prompt__list">
        {prompt.kinds.map((kind) => {
          const Icon = PERMISSION_ICON[kind]
          return (
            <li key={kind} data-kind={kind}>
              <Icon size={14} aria-hidden />
              <span>{PERMISSION_ASK[kind]}</span>
            </li>
          )
        })}
      </ul>
      {prompt.oneTime ? (
        <Actions stacked>
          <Choice testId="permission-allow" disabled={busy} onClick={() => answer('allow')}>
            Allow while visiting the site
          </Choice>
          <Choice testId="permission-once" disabled={busy} onClick={() => answer('once')}>
            Allow this time
          </Choice>
          <Choice testId="permission-block" disabled={busy} onClick={() => answer('block')}>
            Never allow
          </Choice>
        </Actions>
      ) : (
        <Actions>
          <Choice testId="permission-block" disabled={busy} onClick={() => answer('block')}>
            Block
          </Choice>
          <Choice testId="permission-allow" primary disabled={busy} onClick={() => answer('allow')}>
            Allow
          </Choice>
        </Actions>
      )}
    </>
  )
}

/** A list to pick one item from: arrows move the pick (and focus), Enter takes it. */
function PickList({
  label,
  items,
  picked,
  onPick,
  onEnter,
  empty,
  testId,
}: {
  label: string
  items: { id: string; name: string; icon?: ReactNode; preview?: string }[]
  picked: string | undefined
  onPick: (id: string) => void
  onEnter: () => void
  empty: string
  testId: string
}) {
  const list = useRef<HTMLDivElement>(null)
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && picked) {
      e.preventDefault()
      onEnter()
      return
    }
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (!step || items.length === 0) return
    e.preventDefault()
    const at = items.findIndex((i) => i.id === picked)
    const next = at < 0 ? 0 : Math.min(items.length - 1, Math.max(0, at + step))
    const item = items[next]
    if (!item) return
    onPick(item.id)
    list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')[next]?.focus()
  }
  if (items.length === 0) {
    return (
      <p className="perm-prompt__empty" data-testid={`${testId}-empty`}>
        {empty}
      </p>
    )
  }
  const focusable = items.some((i) => i.id === picked) ? picked : items[0]?.id
  return (
    <div
      ref={list}
      className="perm-prompt__picks"
      role="listbox"
      aria-label={label}
      data-testid={testId}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={item.id === picked}
          tabIndex={item.id === focusable ? 0 : -1}
          className={`perm-prompt__pick${item.id === picked ? ' is-picked' : ''}`}
          data-testid={`${testId}-item`}
          onClick={() => onPick(item.id)}
          onDoubleClick={() => {
            onPick(item.id)
            onEnter()
          }}
        >
          {item.preview !== undefined ? (
            <span
              className="perm-prompt__preview"
              style={item.preview ? { backgroundImage: `url(${item.preview})` } : undefined}
            />
          ) : (
            item.icon
          )}
          <span className="perm-prompt__pick-name">{item.name}</span>
        </button>
      ))}
    </div>
  )
}

function DeviceBody({
  prompt,
  busy,
  answer,
}: {
  prompt: Extract<Prompt, { type: 'device' }>
  busy: boolean
  answer: Answer
}) {
  const [picked, setPicked] = useState<string | undefined>(undefined)
  // A device that went away can't be picked.
  const current = prompt.devices.some((d) => d.id === picked) ? picked : undefined
  const Icon = DEVICE_ICON[prompt.device]
  return (
    <>
      <PickList
        label="Devices"
        items={prompt.devices.map((d) => ({ id: d.id, name: d.name, icon: <Icon size={14} aria-hidden /> }))}
        picked={current}
        onPick={setPicked}
        onEnter={() => current && answer('allow', current)}
        empty="No compatible devices found."
        testId="permission-devices"
      />
      <Actions>
        <Choice testId="permission-block" disabled={busy} onClick={() => answer('dismiss')}>
          Cancel
        </Choice>
        <Choice testId="permission-allow" primary disabled={busy || !current} onClick={() => answer('allow', current)}>
          Connect
        </Choice>
      </Actions>
    </>
  )
}

function ScreenBody({
  prompt,
  busy,
  answer,
}: {
  prompt: Extract<Prompt, { type: 'screen' }>
  busy: boolean
  answer: Answer
}) {
  const [picked, setPicked] = useState<string | undefined>(prompt.sources.find((s) => s.screen)?.id)
  const [previews, setPreviews] = useState<Record<string, string>>({})
  useEffect(() => {
    let alive = true
    void invoke('permissions.thumbnails', { id: prompt.id }).then((p) => {
      if (alive) setPreviews(p)
    })
    return () => {
      alive = false
    }
  }, [prompt.id])
  const items = prompt.sources.map((s) => ({
    id: s.id,
    name: s.screen && prompt.sources.filter((x) => x.screen).length === 1 ? 'Entire screen' : s.name,
    preview: previews[s.id] ?? '',
  }))
  return (
    <>
      <PickList
        label="Screens and windows"
        items={items}
        picked={picked}
        onPick={setPicked}
        onEnter={() => picked && answer('allow', picked)}
        empty="Nothing to share."
        testId="permission-sources"
      />
      <Actions>
        <Choice testId="permission-block" disabled={busy} onClick={() => answer('dismiss')}>
          Cancel
        </Choice>
        <Choice testId="permission-allow" primary disabled={busy || !picked} onClick={() => answer('allow', picked)}>
          Share
        </Choice>
      </Actions>
    </>
  )
}
