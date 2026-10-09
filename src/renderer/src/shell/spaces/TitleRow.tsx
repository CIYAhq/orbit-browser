import { MoreHorizontal } from 'lucide-react'
import { type KeyboardEvent, memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SpacePanel } from '../../../../shared/commands/spaces'
import { DEFAULT_PROFILE_ID } from '../../../../shared/defaults'
import type { SpaceId } from '../../../../shared/state'
import { invoke } from '../../api'
import { useOrbit } from '../../store'

export function openSpacePanel(panel: SpacePanel, params: Record<string, string | number | boolean>): void {
  void invoke('overlay.open', { overlay: { kind: 'panel', panel, params } })
}

/** Opens the Space menu (SP-04) at a point in window coordinates. */
export function openSpaceMenu(spaceId: SpaceId, x: number, y: number, sidebar = false): void {
  openSpacePanel('space-menu', { spaceId, x: Math.round(x), y: Math.round(y), sidebar })
}

/** First letter of a profile name for the profile badge (PR-07). */
export function profileInitial(name: string): string {
  return [...name.trim()][0]?.toUpperCase() ?? '?'
}

/**
 * The Space title row (SP-04, SB-06): the name (click to rename inline, SP-03),
 * and on hover the profile badge (PR-07) and the "…" button for the Space menu.
 * Right-click opens the same menu.
 */
export const TitleRow = memo(function TitleRow({ spaceId }: { spaceId: SpaceId }) {
  const name = useOrbit((s) => s.spaces[spaceId]?.name)
  const icon = useOrbit((s) => s.spaces[spaceId]?.icon)
  const hidden = useOrbit((s) => s.spaceOrder.length === 1 && !!s.spaces[spaceId]?.unnamed)
  const profile = useOrbit((s) => {
    const id = s.spaces[spaceId]?.profileId
    return id && id !== DEFAULT_PROFILE_ID ? s.profiles[id]?.name : undefined
  })
  const [editing, setEditing] = useState(false)

  useEffect(
    () =>
      window.orbit.on('spaces:rename', (payload) => {
        if ((payload as { spaceId?: string }).spaceId === spaceId) setEditing(true)
      }),
    [spaceId],
  )

  if (name === undefined) return null
  // A single Space that was never named shows no title row until it gets a name (SP-04).
  if (hidden && !editing) return null

  return (
    <div
      className={`space-title${editing ? ' is-editing' : ''}`}
      data-testid="space-title-row"
      onContextMenu={(e) => {
        e.preventDefault()
        openSpaceMenu(spaceId, e.clientX, e.clientY)
      }}
    >
      {icon ? (
        <span className="space-title__icon" aria-hidden>
          {icon}
        </span>
      ) : null}
      {editing ? (
        <RenameField spaceId={spaceId} name={name} done={() => setEditing(false)} />
      ) : (
        <button
          type="button"
          className="space-title__name"
          data-testid="space-name"
          title="Rename Space"
          onClick={() => setEditing(true)}
        >
          {name}
        </button>
      )}
      {profile && !editing ? (
        <span className="space-title__badge" data-testid="profile-badge" title={`Profile: ${profile}`}>
          {profileInitial(profile)}
        </span>
      ) : null}
      {!editing && (
        <button
          type="button"
          className="space-title__menu"
          aria-label="Space options"
          title="Space options"
          data-testid="space-menu-button"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            openSpaceMenu(spaceId, r.left, r.bottom + 4)
          }}
        >
          <MoreHorizontal size={15} />
        </button>
      )}
    </div>
  )
})

/** Inline rename (SP-03): Enter or clicking elsewhere saves, Escape restores the old name. */
function RenameField({ spaceId, name, done }: { spaceId: SpaceId; name: string; done: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const finished = useRef(false)
  useLayoutEffect(() => {
    const input = ref.current
    if (!input) return
    input.focus()
    input.select()
  }, [])
  const finish = (save: boolean) => {
    if (finished.current) return
    finished.current = true
    const value = ref.current?.value ?? name
    if (save && value !== name) void invoke('spaces.update', { spaceId, name: value })
    done()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finish(false)
    }
  }
  return (
    <input
      ref={ref}
      className="space-title__input"
      data-testid="space-rename-input"
      defaultValue={name}
      aria-label="Space name"
      spellCheck={false}
      maxLength={80}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
    />
  )
}
