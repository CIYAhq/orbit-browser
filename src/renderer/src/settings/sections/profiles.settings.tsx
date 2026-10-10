import { Users } from 'lucide-react'
import { type KeyboardEvent, useEffect, useState } from 'react'
import { ARCHIVE_AFTER_CHOICES } from '../../../../shared/commands/settings'
import { DEFAULT_PROFILE_ID } from '../../../../shared/defaults'
import type { ProfileId } from '../../../../shared/state'
import { invoke } from '../../api'
import { DownloadLocationRow } from '../../downloads/DownloadLocationRow'
import { useOrbit, useOrbitShallow } from '../../store'
import { useSettingsContext } from '../context'
import { Button, Dialog, LinkButton, type Option, Select, SettingGroup, SettingRow, TextField } from '../controls'
import { durationLabel, withCurrent } from '../format'
import { settingsProfiles, useProfiles } from '../profiles'
import type { SettingsSection } from '../registry'
import { SearchEngineSelect } from './search.settings'

/** The archive timing select's "Same as Default" choice (ST-05). */
const INHERIT = -1

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The profile the page shows: the one Settings was opened for, until another is chosen. */
function useSelectedProfile(): [ProfileId, (id: ProfileId) => void] {
  const { context, target, nonce } = useSettingsContext()
  const initial = target.profileId ?? context.profileId
  const [selected, setSelected] = useState(initial)
  // biome-ignore lint/correctness/useExhaustiveDependencies: each opening shows its own profile
  useEffect(() => setSelected(initial), [nonce])
  const exists = useOrbit((s) => !!s.profiles[selected]?.partition.startsWith('persist:'))
  return [exists ? selected : DEFAULT_PROFILE_ID, setSelected]
}

/** Profiles (ST-04): the list, Default first, and the chosen profile's own settings (ST-05, ST-06, ST-20). */
function ProfilesPage() {
  const profiles = useProfiles()
  const spaceCounts = useOrbitShallow((s) =>
    settingsProfiles(s).map((p) => Object.values(s.spaces).filter((space) => space.profileId === p.id).length),
  )
  const [selected, select] = useSelectedProfile()
  const [creating, setCreating] = useState(false)

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const i = profiles.findIndex((p) => p.id === selected)
    const next = profiles[(i + (e.key === 'ArrowDown' ? 1 : profiles.length - 1)) % profiles.length]
    if (!next) return
    select(next.id)
    document.getElementById(`profile-${next.id}`)?.focus()
  }

  return (
    <>
      <SettingGroup
        title="Profiles"
        description="Each profile keeps its own logins, history, Favorites and settings. Every Space uses one."
      >
        <div
          className="st-profiles"
          role="listbox"
          aria-label="Profiles"
          tabIndex={-1}
          data-testid="profile-list"
          onKeyDown={onListKey}
        >
          {profiles.map((p, i) => (
            <button
              key={p.id}
              id={`profile-${p.id}`}
              type="button"
              role="option"
              aria-selected={p.id === selected}
              tabIndex={p.id === selected ? 0 : -1}
              className="st-profile"
              data-testid={`profile-${p.id}`}
              onClick={() => select(p.id)}
            >
              <span className="st-profile__avatar" aria-hidden="true">
                {p.name.trim().charAt(0).toUpperCase() || '?'}
              </span>
              <span className="st-profile__text">
                <span className="st-profile__name">{p.name}</span>
                <span className="st-profile__meta">
                  {p.id === DEFAULT_PROFILE_ID ? 'Default · ' : ''}
                  {spaceCounts[i] ? `Used by ${plural(spaceCounts[i] ?? 0, 'Space')}` : 'No Spaces'}
                </span>
              </span>
            </button>
          ))}
        </div>
        {creating ? (
          <SettingRow id="profile-new" label="New profile" stacked>
            <NewProfileForm
              onDone={(id) => {
                setCreating(false)
                if (id) select(id)
              }}
            />
          </SettingRow>
        ) : (
          <SettingRow id="profile-add" label="New profile" description="Starts empty: no logins, no history.">
            <Button testId="profile-new" onClick={() => setCreating(true)}>
              New Profile…
            </Button>
          </SettingRow>
        )}
      </SettingGroup>
      <ProfileSettings key={selected} profileId={selected} />
    </>
  )
}

function NewProfileForm({ onDone }: { onDone: (id?: ProfileId) => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string>()
  return (
    <form
      className="st-form"
      data-testid="profile-new-form"
      onSubmit={(e) => {
        e.preventDefault()
        const trimmed = name.replace(/\s+/g, ' ').trim()
        if (!trimmed) {
          setError('Enter a name')
          return
        }
        void invoke('profiles.create', { name: trimmed }).then((id) => onDone(id))
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onDone()
        }
      }}
    >
      <TextField
        label="Name"
        value={name}
        error={error}
        testId="profile-new-name"
        autoFocus
        onChange={(v) => {
          setName(v)
          setError(undefined)
        }}
      />
      <div className="st-form__actions">
        <Button onClick={() => onDone()}>Cancel</Button>
        <Button kind="primary" type="submit" testId="profile-new-create">
          Create Profile
        </Button>
      </div>
    </form>
  )
}

/** One profile's settings, each labelled with the profile it belongs to (ST-20). */
function ProfileSettings({ profileId }: { profileId: ProfileId }) {
  const name = useOrbit((s) => s.profiles[profileId]?.name ?? '')
  const spaces = useOrbitShallow((s) =>
    s.spaceOrder.filter((id) => s.spaces[id]?.profileId === profileId).map((id) => s.spaces[id]?.name ?? ''),
  )
  const isDefault = profileId === DEFAULT_PROFILE_ID
  const [draft, setDraft] = useState(name)
  useEffect(() => setDraft(name), [name])
  const [confirming, setConfirming] = useState(false)

  const commitName = () => {
    const next = draft.replace(/\s+/g, ' ').trim()
    if (!next) setDraft(name)
    else if (next !== name) void invoke('profiles.rename', { profileId, name: next })
  }

  return (
    <>
      <SettingGroup title={`${name} profile`} id="profile-settings">
        <SettingRow id="profile-name" label="Name" profile={name}>
          <TextField
            label="Profile name"
            hideLabel
            value={draft}
            testId="profile-name"
            onChange={setDraft}
            onCommit={commitName}
          />
        </SettingRow>
        <SettingRow
          id="profile-spaces"
          label="Spaces"
          description={spaces.length > 0 ? spaces.join(', ') : 'No Space uses this profile.'}
        />
        <ArchiveRow profileId={profileId} name={name} />
        <SettingRow
          id="profile-search-engine"
          label="Default search engine"
          description={
            <>
              For what you type in the command bar in this profile’s Spaces.{' '}
              <LinkButton
                testId="profile-search-settings"
                onClick={() => void invoke('settings.open', { section: 'search', item: 'site-search' })}
              >
                Search engines…
              </LinkButton>
            </>
          }
          profile={name}
        >
          <SearchEngineSelect profileId={profileId} testId={`profile-search-engine-${profileId}`} />
        </SettingRow>
        {/* Downloads lane (DL-07). */}
        <DownloadLocationRow profileId={profileId} name={name} />
      </SettingGroup>
      {!isDefault && (
        <SettingGroup>
          <SettingRow
            id="profile-delete"
            label="Delete profile"
            description={
              spaces.length > 0
                ? `Used by ${plural(spaces.length, 'Space')}. Give ${spaces.length === 1 ? 'it' : 'them'} another profile first.`
                : 'Deletes its cookies, history and site data from this computer.'
            }
          >
            <Button
              kind="danger"
              testId="profile-delete"
              disabled={spaces.length > 0}
              title={spaces.length > 0 ? 'A profile a Space uses can’t be deleted' : undefined}
              onClick={() => setConfirming(true)}
            >
              Delete Profile…
            </Button>
          </SettingRow>
        </SettingGroup>
      )}
      {confirming && (
        <Dialog
          title={`Delete the profile “${name}”?`}
          description="Its cookies, history, Favorites and site data are deleted from this computer. This can’t be undone."
          testId="profile-delete-dialog"
          onClose={() => setConfirming(false)}
          actions={
            <>
              <Button onClick={() => setConfirming(false)}>Cancel</Button>
              <Button
                kind="danger"
                testId="profile-delete-confirm"
                onClick={() => void invoke('profiles.delete', { profileId }).finally(() => setConfirming(false))}
              >
                Delete Profile
              </Button>
            </>
          }
        />
      )}
    </>
  )
}

/** "Archive Today tabs after" (ST-05): 12 hours to 30 days, never off; other profiles follow Default until set. */
function ArchiveRow({ profileId, name }: { profileId: ProfileId; name: string }) {
  const own = useOrbit((s) => s.profiles[profileId]?.archiveAfterMs)
  const fallback = useOrbit((s) => s.profiles[DEFAULT_PROFILE_ID]?.archiveAfterMs ?? s.settings.archiveAfterMs)
  const isDefault = profileId === DEFAULT_PROFILE_ID
  const choices: Option<number>[] = ARCHIVE_AFTER_CHOICES.map((ms) => ({ value: ms, label: durationLabel(ms) }))
  const value = isDefault ? (own ?? fallback) : (own ?? INHERIT)
  const options = isDefault
    ? withCurrent(choices, value)
    : [
        { value: INHERIT, label: `Same as Default (${durationLabel(fallback)})` },
        ...(own === undefined ? choices : withCurrent(choices, own)),
      ]
  return (
    <SettingRow
      id="archive-after"
      label="Archive Today tabs after"
      description="Today tabs you haven’t used for this long move to the Archive. Pinned tabs and tabs playing sound stay."
      profile={name}
    >
      <Select
        label="Archive Today tabs after"
        value={value}
        options={options}
        testId={`archive-after-${profileId}`}
        onChange={(v) => void invoke('settings.setArchiveAfter', { profileId, ms: v === INHERIT ? null : v })}
      />
    </SettingRow>
  )
}

export default {
  id: 'profiles',
  label: 'Profiles',
  icon: Users,
  order: 20,
  component: ProfilesPage,
  keywords: ['profile', 'rename', 'delete', 'new profile', 'archive', 'auto archive', 'today tabs', 'downloads folder'],
} satisfies SettingsSection
