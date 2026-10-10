import { CircleCheck, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ClearDataKind, ClearDataRange } from '../../../../shared/commands/settings'
import type { ProfileId, SecureDnsChoice } from '../../../../shared/state'
import { invoke } from '../../api'
import { useOrbit } from '../../store'
import { useSettingsContext } from '../context'
import { Button, Checkbox, Dialog, type Option, Select, SettingGroup, SettingRow } from '../controls'
import { useProfileName, useProfiles } from '../profiles'
import type { SettingsSection } from '../registry'

const RANGES: Option<ClearDataRange>[] = [
  { value: 'hour', label: 'Last hour' },
  { value: 'day', label: 'Last 24 hours' },
  { value: 'week', label: 'Last 7 days' },
  { value: 'month', label: 'Last 4 weeks' },
  { value: 'all', label: 'All time' },
]

const SECURE_DNS: Option<SecureDnsChoice>[] = [
  { value: 'automatic', label: 'Automatic' },
  { value: 'off', label: 'Off' },
  { value: 'cloudflare', label: 'Cloudflare (1.1.1.1)' },
  { value: 'google', label: 'Google Public DNS' },
  { value: 'quad9', label: 'Quad9' },
]

/** The Clear browsing data request each opening of Settings handled (so returning to the page doesn't reopen it). */
let handledNonce = -1

/** Privacy & security (ST-12): what Orbit sends (nothing), clearing browsing data, Secure DNS. */
function PrivacyPage() {
  const { context, target, nonce } = useSettingsContext()
  const [clearing, setClearing] = useState<ProfileId>()
  const [cleared, setCleared] = useState<string>()
  const profileName = useProfileName(context.profileId)
  // ⌘⇧⌫ and the "Clear Browsing Data…" action open the dialog (KS-12).
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opening of Settings
  useEffect(() => {
    if (target.item !== 'clear-data' || handledNonce === nonce) return
    handledNonce = nonce
    setClearing(target.profileId ?? context.profileId)
  }, [nonce])
  return (
    <>
      <div className="st-promise" data-testid="privacy-promise">
        <ShieldCheck size={18} aria-hidden="true" />
        <p>
          Orbit has no servers and no accounts. Nothing about your browsing is sent to Orbit, or to anyone else for it.
          The sites you visit and your search engine see only what you send them. Update checks, off until you set an
          update feed, tell it only Orbit's version, your system and its processor type.
        </p>
      </div>
      <SettingGroup title="Browsing data">
        <SettingRow
          id="clear-data"
          label="Clear browsing data"
          description="History, cookies and other site data, and cached files."
          profile={profileName}
        >
          {cleared && (
            <span className="st-status" data-testid="clear-data-status">
              <CircleCheck size={14} aria-hidden="true" />
              {cleared}
            </span>
          )}
          <Button testId="clear-data-open" onClick={() => setClearing(context.profileId)}>
            Clear…
          </Button>
        </SettingRow>
      </SettingGroup>
      <SecurityGroup />
      {clearing && (
        <ClearDataDialog
          initialProfile={clearing}
          onClose={(done) => {
            setClearing(undefined)
            if (done) setCleared(done)
          }}
        />
      )}
    </>
  )
}

function SecurityGroup() {
  const secureDns = useOrbit((s) => s.settings.secureDns)
  return (
    <SettingGroup title="Security">
      <SettingRow
        id="secure-dns"
        label="Use secure DNS"
        description="Looks up site addresses over an encrypted connection: always, with a provider you pick, or with Automatic when your network’s provider supports it. Some networks, such as ones with parental controls, need it off."
      >
        <Select
          label="Use secure DNS"
          value={secureDns}
          options={SECURE_DNS}
          testId="secure-dns"
          onChange={(next) => void invoke('settings.update', { secureDns: next })}
        />
      </SettingRow>
    </SettingGroup>
  )
}

/** Clear browsing data (ST-12): a profile, a time range for history, and what to delete. */
function ClearDataDialog({
  initialProfile,
  onClose,
}: {
  initialProfile: ProfileId
  /** With the message to show when data was deleted. */
  onClose: (done?: string) => void
}) {
  const profiles = useProfiles()
  const [profileId, setProfileId] = useState(
    profiles.some((p) => p.id === initialProfile) ? initialProfile : (profiles[0]?.id ?? initialProfile),
  )
  const name = useProfileName(profileId)
  const [range, setRange] = useState<ClearDataRange>('hour')
  // What was ticked or unticked here; the rest follow the range. Site data and the cache go from
  // all time whatever the range, so they start ticked only for All time: a quick clear of the last
  // hour doesn't sign you out of every site.
  const [picked, setPicked] = useState<Partial<Record<ClearDataKind, boolean>>>({})
  const kinds: Record<ClearDataKind, boolean> = {
    history: picked.history ?? true,
    siteData: picked.siteData ?? range === 'all',
    cache: picked.cache ?? range === 'all',
  }
  const [busy, setBusy] = useState(false)
  const chosen = (Object.keys(kinds) as ClearDataKind[]).filter((k) => kinds[k])
  const toggle = (kind: ClearDataKind) => (next: boolean) => setPicked((p) => ({ ...p, [kind]: next }))
  return (
    <Dialog
      title="Clear browsing data"
      description={profiles.length > 1 ? undefined : `From the profile “${name}”.`}
      testId="clear-data-dialog"
      onClose={() => onClose()}
      actions={
        <>
          <Button onClick={() => onClose()}>Cancel</Button>
          <Button
            kind="danger"
            testId="clear-data-confirm"
            disabled={busy || chosen.length === 0}
            onClick={() => {
              setBusy(true)
              void invoke('settings.clearData', { profileId, range, kinds: chosen })
                .then(() => onClose(`Deleted from ${name}`))
                .catch(() => {
                  setBusy(false)
                })
            }}
          >
            Delete Data
          </Button>
        </>
      }
    >
      {profiles.length > 1 && (
        <div className="st-dialog__field">
          <span>Profile</span>
          <Select
            label="Profile"
            value={profileId}
            options={profiles.map((p) => ({ value: p.id, label: p.name }))}
            testId="clear-data-profile"
            onChange={setProfileId}
          />
        </div>
      )}
      <div className="st-dialog__field">
        <span>Time range</span>
        <Select label="Time range" value={range} options={RANGES} testId="clear-data-range" onChange={setRange} />
      </div>
      <Checkbox
        label="Browsing history"
        description="Pages you visited, as the command bar and History list them."
        checked={kinds.history}
        testId="clear-data-history"
        onChange={toggle('history')}
      />
      <Checkbox
        label="Cookies and other site data"
        description="From all time. Signs you out of most sites."
        checked={kinds.siteData}
        testId="clear-data-site-data"
        onChange={toggle('siteData')}
      />
      <Checkbox
        label="Cached images and files"
        description="From all time. Some sites load more slowly the next time."
        checked={kinds.cache}
        testId="clear-data-cache"
        onChange={toggle('cache')}
      />
    </Dialog>
  )
}

export default {
  id: 'privacy',
  label: 'Privacy & Security',
  icon: ShieldCheck,
  order: 60,
  component: PrivacyPage,
  keywords: ['clear browsing data', 'cookies', 'cache', 'history', 'secure dns', 'dns over https', 'privacy'],
} satisfies SettingsSection
