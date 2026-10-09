import { Check, Smile } from 'lucide-react'
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DEFAULT_PROFILE_ID, NEW_SPACE_PRESETS, THEME_PRESETS } from '../../../../shared/defaults'
import type { SpaceTheme } from '../../../../shared/state'
import { invoke } from '../../api'
import { getOrbitState, useOrbit } from '../../store'
import { EmojiPicker } from './EmojiPicker'
import { switcher } from './switcher'
import { ThemeEditor, ThemeRenditions } from './ThemeEditor'

/**
 * The new-Space flow (SP-02, PR-04), shown in the sidebar on the page past the
 * last Space: name and icon, the profile (only when there is more than one),
 * then the theme with light and dark renditions, then Create. The window
 * previews the chosen theme live. Escape or Cancel creates nothing.
 */
export function NewSpaceFlow({ windowId }: { windowId: string }) {
  const profiles = useOrbit((s) => s.profiles)
  const [initial] = useState(() => {
    const s = getOrbitState()
    const active = s.spaces[s.windows[windowId]?.spaceId ?? '']
    return {
      profileId: active?.profileId ?? DEFAULT_PROFILE_ID,
      theme: THEME_PRESETS[s.spaceOrder.length % NEW_SPACE_PRESETS] as SpaceTheme,
      placeholder: `Space ${s.spaceOrder.length + 1}`,
    }
  })
  const [name, setName] = useState('')
  const [icon, setIcon] = useState('')
  const [profileId, setProfileId] = useState(initial.profileId)
  const [theme, setTheme] = useState<SpaceTheme>(initial.theme)
  const [pickingIcon, setPickingIcon] = useState(false)
  const [newProfile, setNewProfile] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => {
    nameRef.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => switcher.setFlowTheme(theme), [theme])

  const profileList = Object.values(profiles).sort((a, b) =>
    a.id === DEFAULT_PROFILE_ID ? -1 : b.id === DEFAULT_PROFILE_ID ? 1 : a.createdAt - b.createdAt,
  )

  const create = () => {
    if (busy) return
    setBusy(true)
    void invoke('spaces.create', {
      name,
      icon,
      theme,
      profileId: profiles[profileId] ? profileId : undefined,
      activate: true,
    }).catch(() => setBusy(false))
  }

  const addProfile = async (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return
    const id = await invoke('profiles.create', { name: trimmed })
    setProfileId(id)
    setNewProfile(null)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    if (pickingIcon) setPickingIcon(false)
    else if (newProfile !== null) setNewProfile(null)
    else switcher.cancelFlow()
  }

  return (
    <div className="space-flow" data-testid="new-space-flow" onKeyDown={onKeyDown}>
      <div className="space-flow__title">New Space</div>
      <section className="space-flow__step">
        <div className="space-flow__name-row">
          <button
            type="button"
            className="space-flow__icon"
            aria-label="Choose an icon"
            title="Choose an icon"
            data-testid="new-space-icon"
            onClick={() => setPickingIcon((v) => !v)}
          >
            {icon || <Smile size={16} />}
          </button>
          <input
            ref={nameRef}
            className="space-flow__name"
            data-testid="new-space-name"
            placeholder={initial.placeholder}
            aria-label="Space name"
            value={name}
            maxLength={80}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                create()
              }
            }}
          />
        </div>
        {pickingIcon && (
          <div className="space-flow__emoji">
            <EmojiPicker
              compact
              autoFocus
              current={icon}
              onPick={(emoji) => {
                setIcon(emoji)
                setPickingIcon(false)
                nameRef.current?.focus()
              }}
              onRemove={
                icon
                  ? () => {
                      setIcon('')
                      setPickingIcon(false)
                    }
                  : undefined
              }
            />
          </div>
        )}
      </section>
      {profileList.length > 1 && (
        <section className="space-flow__step" data-testid="new-space-profiles">
          <div className="space-flow__label">Profile</div>
          <div className="space-flow__profiles" role="radiogroup" aria-label="Profile">
            {profileList.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={p.id === profileId}
                className={`space-flow__profile${p.id === profileId ? ' is-selected' : ''}`}
                data-testid="new-space-profile"
                onClick={() => setProfileId(p.id)}
              >
                <span className="space-flow__check">{p.id === profileId ? <Check size={13} /> : null}</span>
                <span>{p.name}</span>
              </button>
            ))}
            {newProfile === null ? (
              <button type="button" className="space-flow__profile is-new" onClick={() => setNewProfile('')}>
                <span className="space-flow__check" />
                <span>New Profile…</span>
              </button>
            ) : (
              <input
                // biome-ignore lint/a11y/noAutofocus: the user just asked to type a name
                autoFocus
                className="space-flow__name"
                placeholder="Profile name"
                aria-label="New profile name"
                value={newProfile}
                onChange={(e) => setNewProfile(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void addProfile(newProfile)
                  }
                }}
              />
            )}
          </div>
        </section>
      )}
      <section className="space-flow__step">
        <div className="space-flow__label">Theme</div>
        <ThemeEditor compact theme={theme} onChange={setTheme} />
        <ThemeRenditions theme={theme} />
      </section>
      <div className="space-flow__actions">
        <button
          type="button"
          className="space-button"
          data-testid="new-space-cancel"
          onClick={() => switcher.cancelFlow()}
        >
          Cancel
        </button>
        <button
          type="button"
          className="space-button is-primary"
          data-testid="new-space-create"
          disabled={busy}
          onClick={create}
        >
          Create Space
        </button>
      </div>
    </div>
  )
}
