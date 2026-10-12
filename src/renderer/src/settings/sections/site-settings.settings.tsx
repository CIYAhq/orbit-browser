import { ChevronLeft, ChevronRight, GlobeLock, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DEVICE_NAME } from '../../../../shared/site'
import {
  isDeviceCategory,
  SITE_CATEGORIES,
  SITE_CATEGORY_GROUPS,
  SITE_CATEGORY_ORDER,
  SITE_CHOICE_NAME,
  type SiteCategory,
  type SiteChoice,
  type SiteDefault,
  type SiteSettingsSite,
  siteChoice,
  siteDefaultIn,
  siteDefaultLabel,
  siteOrigin,
} from '../../../../shared/site-settings'
import type { ProfileId } from '../../../../shared/state'
import { invoke } from '../../api'
import { useOrbit } from '../../store'
import { useSettingsContext } from '../context'
import { Button, Dialog, type Option, Select, SettingGroup, SettingRow, TextField } from '../controls'
import { useProfileName, useProfiles } from '../profiles'
import type { SettingsSection } from '../registry'

type View = { kind: 'main' } | { kind: 'category'; id: SiteCategory } | { kind: 'site'; origin: string }

type Defaults = Partial<Record<SiteCategory, SiteDefault>> | undefined

/** How Settings names a site: its host, with the scheme only when the connection isn't secure. */
function siteName(origin: string): string {
  if (origin === 'file://') return 'Local files'
  try {
    const url = new URL(origin)
    return url.protocol === 'https:' ? url.host : origin
  } catch {
    return origin
  }
}

/** The opening of Settings whose site request was handled (returning to the section doesn't redo it). */
let handledNonce = -1

/**
 * Site settings (ST-13): per profile, what sites may do. Each category has a default and lists the
 * sites with a choice of their own (Allow / Block), which can be changed and removed; a site's page
 * shows all its choices at once. The site controls panel changes the same choices (NV-16).
 */
function SiteSettingsPage() {
  const { context, target, nonce } = useSettingsContext()
  const profiles = useProfiles()
  const [profileId, setProfileId] = useState<ProfileId>(context.profileId)
  const [view, setView] = useState<View>({ kind: 'main' })
  /** What to focus when going back to the main view: the button that left it. */
  const backTo = useRef<string | undefined>(undefined)
  const [sites, reload] = useSites(profileId)
  const defaults = useOrbit((s) => s.profiles[profileId]?.siteDefaults)
  const profileName = useProfileName(profileId)

  // Each opening acts for its window's profile, or for the one a profile's page opened it for
  // (ST-07); one asked to show a site opens at its page. Coming back from another section is a
  // visit of its own, for the window's profile.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opening of Settings
  useEffect(() => {
    const asked = handledNonce !== nonce && target.section === 'site-settings'
    if (asked) handledNonce = nonce
    setProfileId(asked && target.profileId ? target.profileId : context.profileId)
    if (asked && target.site) setView({ kind: 'site', origin: target.site })
  }, [nonce, context.profileId])

  const go = (next: View, from?: string) => {
    if (next.kind !== 'main') backTo.current = from
    setView(next)
  }
  // A new view starts at the top, with the keyboard on its Back button (or where the user left from).
  const pageRef = useRef<HTMLDivElement>(null)
  const shownView = useRef(view)
  useLayoutEffect(() => {
    const root = pageRef.current
    if (!root || shownView.current === view) return
    shownView.current = view
    root.closest('.settings__content')?.scrollTo({ top: 0 })
    if (view.kind !== 'main') root.querySelector<HTMLElement>('[data-testid="site-back"]')?.focus()
    else if (backTo.current) root.querySelector<HTMLElement>(`[data-back-id="${CSS.escape(backTo.current)}"]`)?.focus()
  }, [view])

  const shown = profiles.some((p) => p.id === profileId) ? profileId : (profiles[0]?.id ?? profileId)
  return (
    <div ref={pageRef} className="st-sites" data-testid="site-settings" data-profile={shown}>
      {view.kind === 'main' && (
        <MainView
          profileId={shown}
          profiles={profiles}
          onProfile={(id) => setProfileId(id)}
          defaults={defaults}
          sites={sites}
          go={go}
        />
      )}
      {view.kind === 'category' && (
        <CategoryView
          profileId={shown}
          profileName={profileName}
          category={view.id}
          defaults={defaults}
          sites={sites}
          reload={reload}
          go={go}
        />
      )}
      {view.kind === 'site' && (
        <SiteView
          profileId={shown}
          profileName={profileName}
          origin={view.origin}
          defaults={defaults}
          site={sites?.find((s) => s.origin === view.origin)}
          reload={reload}
          go={go}
        />
      )}
    </div>
  )
}

/** The profile's sites with choices, read again when Settings comes forward or after a change here. */
function useSites(profileId: ProfileId): [SiteSettingsSite[] | undefined, () => void] {
  const [sites, setSites] = useState<SiteSettingsSite[]>()
  const [round, setRound] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` asks for a fresh read
  useEffect(() => {
    let live = true
    const load = () => void invoke('siteSettings.list', { profileId }).then((list) => live && setSites(list))
    load()
    const off = window.orbit.on('settings.refresh', load)
    window.addEventListener('focus', load)
    return () => {
      live = false
      off()
      window.removeEventListener('focus', load)
    }
  }, [profileId, round])
  return [sites, () => setRound((r) => r + 1)]
}

function BackBar({ title, profileName, go }: { title: string; profileName: string; go: (v: View) => void }) {
  return (
    <div className="st-sites__bar">
      <button
        type="button"
        className="st-sites__back"
        data-testid="site-back"
        aria-label="Back to Site settings"
        onClick={() => go({ kind: 'main' })}
      >
        <ChevronLeft size={16} aria-hidden="true" />
        <span>Site settings</span>
      </button>
      <h2 className="st-sites__title">
        <span data-testid="site-view-title">{title}</span>
        <span className="st-scope" title={`These settings belong to the profile “${profileName}”`}>
          {profileName}
        </span>
      </h2>
    </div>
  )
}

function MainView({
  profileId,
  profiles,
  onProfile,
  defaults,
  sites,
  go,
}: {
  profileId: ProfileId
  profiles: { id: ProfileId; name: string }[]
  onProfile: (id: ProfileId) => void
  defaults: Defaults
  sites: SiteSettingsSite[] | undefined
  go: (v: View, from?: string) => void
}) {
  const name = profiles.find((p) => p.id === profileId)?.name ?? 'Default'
  const count = (category: SiteCategory) => sites?.filter((s) => siteChoice(s, category)).length ?? 0
  return (
    <>
      <SettingGroup>
        <SettingRow
          id="site-settings-profile"
          label="Profile"
          description="Each profile keeps its own site settings. Private windows use the Default profile’s defaults and forget their own choices."
          profile={name}
        >
          {profiles.length > 1 && (
            <Select
              label="Profile"
              value={profileId}
              options={profiles.map((p) => ({ value: p.id, label: p.name }))}
              testId="site-settings-profile"
              onChange={onProfile}
            />
          )}
        </SettingRow>
      </SettingGroup>
      {SITE_CATEGORY_GROUPS.map((group) => (
        <SettingGroup key={group.title} title={group.title}>
          {group.ids.map((id) => {
            const n = count(id)
            return (
              <SettingRow
                key={id}
                id={`site-category-${id}`}
                label={SITE_CATEGORIES[id].name}
                description={siteDefaultLabel(id, siteDefaultIn(defaults, id))}
              >
                <button
                  type="button"
                  className="st-sites__open"
                  data-testid={`site-category-${id}`}
                  data-back-id={`category:${id}`}
                  aria-label={`${SITE_CATEGORIES[id].name}${n ? `: ${n} site${n === 1 ? '' : 's'} with a choice of their own` : ''}`}
                  onClick={() => go({ kind: 'category', id }, `category:${id}`)}
                >
                  {n > 0 && <span className="st-sites__count">{n === 1 ? '1 site' : `${n} sites`}</span>}
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </SettingRow>
            )
          })}
        </SettingGroup>
      ))}
      <SettingGroup title="Sites" description="Every site with a choice of its own in this profile.">
        {sites && sites.length === 0 && (
          <SettingRow
            id="site-list-empty"
            label="No sites yet"
            description="Sites show here once you allow or block something for one."
          />
        )}
        {sites?.map((site) => (
          <SettingRow
            key={site.origin}
            id={`site-${site.origin}`}
            label={siteName(site.origin)}
            description={summary(site)}
          >
            <button
              type="button"
              className="st-sites__open"
              data-testid="site-open"
              data-origin={site.origin}
              data-back-id={`site:${site.origin}`}
              aria-label={`${siteName(site.origin)}: all its settings`}
              onClick={() => go({ kind: 'site', origin: site.origin }, `site:${site.origin}`)}
            >
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </SettingRow>
        ))}
      </SettingGroup>
    </>
  )
}

/** "Camera: Allow · JavaScript: Block · USB device" */
function summary(site: SiteSettingsSite): string {
  const parts: string[] = []
  for (const id of SITE_CATEGORY_ORDER) {
    if (isDeviceCategory(id)) continue
    const choice = siteChoice(site, id)
    if (choice) parts.push(`${SITE_CATEGORIES[id].name}: ${SITE_CHOICE_NAME[choice]}`)
  }
  for (const device of site.devices) parts.push(device.name || DEVICE_NAME[device.type])
  return parts.join(' · ')
}

function CategoryView({
  profileId,
  profileName,
  category,
  defaults,
  sites,
  reload,
  go,
}: {
  profileId: ProfileId
  profileName: string
  category: SiteCategory
  defaults: Defaults
  sites: SiteSettingsSite[] | undefined
  reload: () => void
  go: (v: View, from?: string) => void
}) {
  const def = SITE_CATEGORIES[category]
  const current = siteDefaultIn(defaults, category)
  const device = isDeviceCategory(category)
  const set = async (origin: string, choice: SiteChoice | null) => {
    await invoke('siteSettings.set', { profileId, origin, category, choice })
    reload()
  }
  const choiceOptions: Option<SiteChoice>[] = def.exceptions.map((c) => ({ value: c, label: SITE_CHOICE_NAME[c] }))
  const listed = (choice: SiteChoice) => sites?.filter((s) => siteChoice(s, category) === choice) ?? []
  return (
    <div data-testid="site-category-page" data-category={category}>
      <BackBar title={def.name} profileName={profileName} go={go} />
      <SettingGroup title="Default">
        <SettingRow
          id={`site-default-${category}`}
          label="For sites with no choice of their own"
          description={def.note}
        >
          {def.defaults.length > 1 ? (
            <Select
              label={`${def.name}: default`}
              value={current}
              options={def.defaults.map((v) => ({ value: v, label: siteDefaultLabel(category, v) }))}
              testId="site-default"
              onChange={(value) => void invoke('siteSettings.setDefault', { profileId, category, value })}
            />
          ) : (
            <span className="st-sites__fixed" data-testid="site-default-fixed">
              {siteDefaultLabel(category, current)}
            </span>
          )}
        </SettingRow>
      </SettingGroup>
      {device && (
        <SettingGroup title="Allowed devices">
          {(sites ?? []).flatMap((site) =>
            site.devices
              .filter((d) => d.type === category)
              .map((d) => (
                <SettingRow
                  key={`${site.origin}|${d.key}`}
                  id={`site-device-${site.origin}-${d.key}`}
                  label={d.name || DEVICE_NAME[d.type]}
                  description={siteName(site.origin)}
                >
                  <RemoveButton
                    label={`Take ${d.name || DEVICE_NAME[d.type]} back from ${siteName(site.origin)}`}
                    testId="site-device-remove"
                    onClick={async () => {
                      await invoke('siteSettings.revokeDevice', { profileId, origin: site.origin, key: d.key })
                      reload()
                    }}
                  />
                </SettingRow>
              )),
          )}
          {sites && !sites.some((s) => s.devices.some((d) => d.type === category)) && (
            <SettingRow
              id={`site-devices-empty-${category}`}
              label="No devices"
              description="A device you pick for a site in its chooser shows here."
            />
          )}
        </SettingGroup>
      )}
      {!device &&
        def.exceptions.map((choice) => (
          <SettingGroup key={choice} title={choice === 'allow' ? 'Allowed' : 'Blocked'}>
            {listed(choice).map((site) => (
              <SettingRow
                key={site.origin}
                id={`site-exception-${choice}-${site.origin}`}
                label={siteName(site.origin)}
              >
                {choiceOptions.length > 1 && (
                  <Select
                    label={`${siteName(site.origin)}: ${def.name}`}
                    value={choice}
                    options={choiceOptions}
                    testId="site-exception-choice"
                    onChange={(next) => void set(site.origin, next)}
                  />
                )}
                <button
                  type="button"
                  className="st-icon-button"
                  title="All settings of this site"
                  aria-label={`${siteName(site.origin)}: all its settings`}
                  data-back-id={`site:${site.origin}`}
                  onClick={() => go({ kind: 'site', origin: site.origin })}
                >
                  <ChevronRight size={16} />
                </button>
                <RemoveButton
                  label={`Remove ${siteName(site.origin)}: it follows the default`}
                  testId="site-exception-remove"
                  onClick={() => void set(site.origin, null)}
                />
              </SettingRow>
            ))}
            {sites && listed(choice).length === 0 && (
              <SettingRow id={`site-exceptions-empty-${choice}`} label="No sites" />
            )}
          </SettingGroup>
        ))}
      {!device && def.exceptions.length > 0 && (
        <AddSite category={category} choices={choiceOptions} onAdd={(origin, choice) => set(origin, choice)} />
      )}
    </div>
  )
}

function RemoveButton({ label, testId, onClick }: { label: string; testId: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="st-icon-button"
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={onClick}
    >
      <X size={15} />
    </button>
  )
}

/** "Add a site": a site's own choice before it ever asks (sound, JavaScript and images never do). */
function AddSite({
  category,
  choices,
  onAdd,
}: {
  category: SiteCategory
  choices: Option<SiteChoice>[]
  onAdd: (origin: string, choice: SiteChoice) => Promise<void>
}) {
  const [text, setText] = useState('')
  const [choice, setChoice] = useState<SiteChoice>(choices[choices.length - 1]?.value ?? 'block')
  const [error, setError] = useState<string>()
  const add = async () => {
    const origin = siteOrigin(text)
    if (!origin) {
      setError('Type a site’s address, such as example.com.')
      return
    }
    setError(undefined)
    await onAdd(origin, choice)
    setText('')
  }
  return (
    <SettingGroup title="Add a site">
      <SettingRow id={`site-add-${category}`} label="Site" stacked>
        <form
          className="st-sites__add"
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <TextField
            label="Site address"
            hideLabel
            value={text}
            placeholder="example.com"
            error={error}
            testId="site-add-input"
            onChange={(next) => {
              setText(next)
              setError(undefined)
            }}
          />
          {choices.length > 1 && (
            <Select
              label="Choice for the site"
              value={choice}
              options={choices}
              testId="site-add-choice"
              onChange={setChoice}
            />
          )}
          <Button type="submit" testId="site-add-button" disabled={!text.trim()}>
            {choices.length > 1 ? 'Add' : `${SITE_CHOICE_NAME[choice]} site`}
          </Button>
        </form>
      </SettingRow>
    </SettingGroup>
  )
}

function SiteView({
  profileId,
  profileName,
  origin,
  defaults,
  site,
  reload,
  go,
}: {
  profileId: ProfileId
  profileName: string
  origin: string
  defaults: Defaults
  site: SiteSettingsSite | undefined
  reload: () => void
  go: (v: View, from?: string) => void
}) {
  const [confirm, setConfirm] = useState(false)
  const [done, setDone] = useState<string>()
  const empty: SiteSettingsSite = { origin, permissions: {}, popups: false, devices: [] }
  const shown = site ?? empty
  const name = siteName(origin)
  const set = async (category: SiteCategory, choice: SiteChoice | null) => {
    await invoke('siteSettings.set', { profileId, origin, category, choice })
    reload()
  }
  const choosable = SITE_CATEGORY_ORDER.filter(
    (id) => !isDeviceCategory(id) && SITE_CATEGORIES[id].exceptions.length > 0,
  )
  return (
    <div data-testid="site-page" data-origin={origin}>
      <BackBar title={name} profileName={profileName} go={go} />
      {SITE_CATEGORY_GROUPS.map((group) => {
        const ids = group.ids.filter((id) => choosable.includes(id))
        if (ids.length === 0) return null
        return (
          <SettingGroup key={group.title} title={group.title}>
            {ids.map((id) => {
              const def = SITE_CATEGORIES[id]
              const fallback = siteDefaultIn(defaults, id)
              const options: Option<SiteChoice | 'default'>[] = [
                { value: 'default', label: `Default (${SITE_CHOICE_NAME[fallback]})` },
                ...def.exceptions.map((c) => ({ value: c, label: SITE_CHOICE_NAME[c] })),
              ]
              return (
                <SettingRow key={id} id={`site-choice-${id}`} label={def.name}>
                  <Select
                    label={`${name}: ${def.name}`}
                    value={siteChoice(shown, id) ?? 'default'}
                    options={options}
                    testId={`site-choice-${id}`}
                    onChange={(next) => void set(id, next === 'default' ? null : next)}
                  />
                </SettingRow>
              )
            })}
          </SettingGroup>
        )
      })}
      {shown.devices.length > 0 && (
        <SettingGroup title="Devices">
          {shown.devices.map((d) => (
            <SettingRow
              key={d.key}
              id={`site-page-device-${d.key}`}
              label={d.name || DEVICE_NAME[d.type]}
              description={DEVICE_NAME[d.type]}
            >
              <RemoveButton
                label={`Take ${d.name || DEVICE_NAME[d.type]} back from ${name}`}
                testId="site-device-remove"
                onClick={async () => {
                  await invoke('siteSettings.revokeDevice', { profileId, origin, key: d.key })
                  reload()
                }}
              />
            </SettingRow>
          ))}
        </SettingGroup>
      )}
      <SettingGroup title="This site">
        {origin !== 'file://' && (
          <SettingRow
            id="site-clear-data"
            label="Clear cookies and site data"
            description="Its cookies, what it stored on this computer and its cached files. You may be signed out of it."
          >
            {done && <span className="st-status">{done}</span>}
            <Button testId="site-clear-data" onClick={() => setConfirm(true)}>
              Clear…
            </Button>
          </SettingRow>
        )}
        <SettingRow
          id="site-reset"
          label="Reset permissions"
          description="Forgets every choice above and its devices: the site asks again."
        >
          <Button
            testId="site-reset"
            disabled={!site}
            onClick={async () => {
              await invoke('siteSettings.resetSite', { profileId, origin })
              reload()
            }}
          >
            Reset
          </Button>
        </SettingRow>
      </SettingGroup>
      {confirm && (
        <Dialog
          title={`Clear cookies and site data for ${name}?`}
          description={`From the profile “${profileName}”. You may be signed out of this site.`}
          testId="site-clear-dialog"
          onClose={() => setConfirm(false)}
          actions={
            <>
              <Button onClick={() => setConfirm(false)}>Cancel</Button>
              <Button
                kind="danger"
                testId="site-clear-confirm"
                onClick={async () => {
                  setConfirm(false)
                  await invoke('siteSettings.clearSite', { profileId, origin })
                  setDone('Cleared')
                }}
              >
                Clear
              </Button>
            </>
          }
        />
      )}
    </div>
  )
}

export default {
  id: 'site-settings',
  label: 'Site settings',
  icon: GlobeLock,
  order: 65,
  component: SiteSettingsPage,
  keywords: [
    'permissions',
    'camera',
    'microphone',
    'location',
    'notifications',
    'pop-ups',
    'popups',
    'javascript',
    'images',
    'sound',
    'clipboard',
    'midi',
    'usb',
    'site data',
  ],
} satisfies SettingsSection
