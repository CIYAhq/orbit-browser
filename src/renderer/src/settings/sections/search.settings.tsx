import { Search } from 'lucide-react'
import { useState } from 'react'
import { ENGINE_ORDER, type SiteSearchDraft } from '../../../../shared/commands/settings'
import type { ProfileId, SiteSearchEngine } from '../../../../shared/state'
import { engineFor, SEARCH_ENGINES, siteEngineId } from '../../../../shared/url'
import { invoke } from '../../api'
import { useOrbit } from '../../store'
import { useSettingsContext } from '../context'
import { Button, type Option, RowMenu, Select, SettingGroup, SettingRow, Switch, TextField } from '../controls'
import { useProfileName, useProfiles } from '../profiles'
import type { SettingsSection } from '../registry'

/** A profile's default search engine (ST-06): built-in engines, plus its custom one when it uses one. */
export function SearchEngineSelect({ profileId, testId }: { profileId: ProfileId; testId?: string }) {
  // Strings only: a custom engine's choice is a new object on every call.
  const currentId = useOrbit((s) => engineFor(s, profileId).id)
  const currentName = useOrbit((s) => engineFor(s, profileId).name)
  const options: Option<string>[] = ENGINE_ORDER.map((id) => ({ value: id, label: SEARCH_ENGINES[id].name }))
  if (!options.some((o) => o.value === currentId)) options.push({ value: currentId, label: currentName })
  return (
    <Select
      label="Default search engine"
      value={currentId}
      options={options}
      testId={testId}
      onChange={(engine) => void invoke('settings.setSearchEngine', { profileId, engine })}
    />
  )
}

function SearchPage() {
  const profiles = useProfiles()
  const suggestions = useOrbit((s) => s.settings.searchSuggestions)
  const topResult = useOrbit((s) => s.settings.searchTopResult)
  return (
    <>
      <SettingGroup
        title="Default search engine"
        description="What you type in the command bar that isn't an address is searched here, for Spaces that use the profile."
      >
        {profiles.map((p) => (
          <SettingRow key={p.id} id={`search-engine-${p.id}`} label="Search with" profile={p.name}>
            <SearchEngineSelect profileId={p.id} testId={`search-engine-${p.id}`} />
          </SettingRow>
        ))}
      </SettingGroup>
      <SettingGroup title="Command bar">
        <SettingRow
          id="search-suggestions"
          label="Show search suggestions"
          description="Sends what you type to the search engine while you type."
        >
          <Switch
            label="Show search suggestions"
            checked={suggestions}
            testId="search-suggestions"
            onChange={(v) => void invoke('settings.update', { searchSuggestions: v })}
          />
        </SettingRow>
        <SettingRow
          id="search-top-result"
          label="⇧Enter opens the first result"
          description="Skips the results page where the search engine supports it (DuckDuckGo)."
        >
          <Switch
            label="Shift-Enter opens the first result"
            checked={topResult}
            testId="search-top-result"
            onChange={(v) => void invoke('settings.update', { searchTopResult: v })}
          />
        </SettingRow>
      </SettingGroup>
      <SiteSearches />
    </>
  )
}

/** Custom engines and site search keywords (ST-06, CB-11). */
function SiteSearches() {
  const { context } = useSettingsContext()
  const profileId = context.profileId
  const profileName = useProfileName(profileId)
  const several = useProfiles().length > 1
  const sites = useOrbit((s) => s.settings.siteSearch)
  const defaultId = useOrbit((s) => engineFor(s, profileId).id)
  const [editing, setEditing] = useState<string | undefined>()
  return (
    <SettingGroup
      title="Search engines and site search"
      description="Type a keyword in the command bar, press Tab, then what to search for. Any engine here can be a default search engine."
      id="site-search"
    >
      {sites.map((site) =>
        editing === site.id ? (
          <SettingRow key={site.id} id={`site-search-${site.id}`} label={`Edit ${site.name}`} stacked>
            <SiteSearchForm initial={site} onDone={() => setEditing(undefined)} />
          </SettingRow>
        ) : (
          <SettingRow
            key={site.id}
            id={`site-search-${site.id}`}
            label={
              <>
                {site.name}
                <span className="st-key">{site.keyword}</span>
                {defaultId === siteEngineId(site.id) && <span className="st-badge">Default</span>}
              </>
            }
            description={<span className="st-url">{site.url}</span>}
          >
            <RowMenu
              label={`${site.name} options`}
              testId={`site-search-menu-${site.id}`}
              items={[
                {
                  label: several ? `Make default for ${profileName}` : 'Make default',
                  disabled: defaultId === siteEngineId(site.id),
                  testId: 'site-search-make-default',
                  onSelect: () => void invoke('settings.setSearchEngine', { profileId, engine: siteEngineId(site.id) }),
                },
                { label: 'Edit', testId: 'site-search-edit', onSelect: () => setEditing(site.id) },
                {
                  label: 'Remove',
                  danger: true,
                  testId: 'site-search-remove',
                  onSelect: () => void invoke('settings.removeSiteSearch', { id: site.id }),
                },
              ]}
            />
          </SettingRow>
        ),
      )}
      {editing === '' ? (
        <SettingRow id="site-search-new" label="Add search engine" stacked>
          <SiteSearchForm onDone={() => setEditing(undefined)} />
        </SettingRow>
      ) : (
        <SettingRow
          id="site-search-add"
          label="Add a search engine"
          description="A name, a keyword and its results page."
        >
          <Button testId="site-search-add" onClick={() => setEditing('')}>
            Add…
          </Button>
        </SettingRow>
      )}
    </SettingGroup>
  )
}

function SiteSearchForm({ initial, onDone }: { initial?: SiteSearchEngine; onDone: () => void }) {
  const [draft, setDraft] = useState<SiteSearchDraft>({
    id: initial?.id,
    name: initial?.name ?? '',
    keyword: initial?.keyword ?? '',
    url: initial?.url ?? '',
  })
  const [error, setError] = useState<{ field: 'name' | 'keyword' | 'url'; message: string }>()
  const set = (field: 'name' | 'keyword' | 'url') => (value: string) => {
    setDraft((d) => ({ ...d, [field]: value }))
    if (error?.field === field) setError(undefined)
  }
  const errorFor = (field: 'name' | 'keyword' | 'url') => (error?.field === field ? error.message : undefined)
  return (
    <form
      className="st-form"
      data-testid="site-search-form"
      onSubmit={(e) => {
        e.preventDefault()
        void invoke('settings.saveSiteSearch', draft).then((saved) => {
          if (saved.ok) onDone()
          else setError({ field: saved.field, message: saved.message })
        })
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onDone()
        }
      }}
    >
      <div className="st-form__fields">
        <TextField
          label="Name"
          value={draft.name}
          onChange={set('name')}
          error={errorFor('name')}
          testId="site-search-name"
          autoFocus
        />
        <TextField
          label="Keyword"
          value={draft.keyword}
          onChange={set('keyword')}
          error={errorFor('keyword')}
          testId="site-search-keyword"
        />
      </div>
      <TextField
        label="Results address, with %s where the search words go"
        placeholder="https://example.com/search?q=%s"
        value={draft.url}
        onChange={set('url')}
        error={errorFor('url')}
        testId="site-search-url"
        wide
      />
      <div className="st-form__actions">
        <Button onClick={onDone}>Cancel</Button>
        <Button kind="primary" type="submit" testId="site-search-save">
          Save
        </Button>
      </div>
    </form>
  )
}

export default {
  id: 'search',
  label: 'Search',
  icon: Search,
  order: 25,
  component: SearchPage,
  keywords: ['search engine', 'site search', 'keyword', 'command bar', 'suggestions', 'google', 'duckduckgo'],
} satisfies SettingsSection
