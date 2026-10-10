import { Route } from 'lucide-react'
import { useState } from 'react'
import type { LinkRule } from '../../../../shared/state'
import { invoke } from '../../api'
import { useOrbit, useOrbitShallow } from '../../store'
import {
  Button,
  type MenuItem,
  type Option,
  RowMenu,
  Select,
  SettingGroup,
  SettingRow,
  Switch,
  TextField,
} from '../controls'
import type { SettingsSection } from '../registry'
import { type SpaceRow, useSpaceRows } from '../spaces'

const MINI = 'mini'
const RECENT = 'recent'
const spaceValue = (id: string) => `space:${id}`

/** Links (ST-09): where links from other apps open, link routing rules and the Peek options. */
function LinksPage() {
  return (
    <>
      <OtherAppsGroup />
      <RoutingRules />
      <PeekGroup />
    </>
  )
}

/** "Links from other apps open in": a Mini Window (default), the most recent Space, or one Space (MW-11). */
function OtherAppsGroup() {
  const mini = useOrbit((s) => s.settings.miniWindowForExternalLinks)
  const chosen = useOrbit((s) => s.settings.externalLinksSpace)
  const spaces = useSpaceRows()
  const options: Option<string>[] = [
    { value: MINI, label: 'A Mini Window' },
    { value: RECENT, label: 'The most recent Space' },
    ...spaces.map((s) => ({ value: spaceValue(s.id), label: s.name })),
  ]
  const value = mini ? MINI : chosen && spaces.some((s) => s.id === chosen) ? spaceValue(chosen) : RECENT
  return (
    <SettingGroup title="Links from other apps">
      <SettingRow
        id="external-links"
        label="Open links from other apps in"
        description="A Mini Window opens over everything and closes when you’re done. Otherwise links open as a new tab."
      >
        <Select
          label="Open links from other apps in"
          value={value}
          options={options}
          testId="external-links"
          onChange={(next) =>
            void invoke(
              'settings.update',
              next === MINI
                ? { miniWindowForExternalLinks: true }
                : { miniWindowForExternalLinks: false, externalLinksSpace: next === RECENT ? null : next.slice(6) },
            )
          }
        />
      </SettingRow>
    </SettingGroup>
  )
}

/** Link routing rules (ST-09): a link whose address matches opens as a tab in the rule's Space. */
function RoutingRules() {
  const rules = useOrbitShallow((s) => s.settings.linkRules)
  const spaces = useSpaceRows()
  const [editing, setEditing] = useState<number | 'new'>()
  const save = (next: LinkRule[]) => invoke('settings.setLinkRules', { rules: next })
  const move = (from: number, to: number) => {
    const next = [...rules]
    const [rule] = next.splice(from, 1)
    if (!rule) return
    next.splice(to, 0, rule)
    void save(next)
  }
  return (
    <SettingGroup
      title="Link routing"
      id="link-rules"
      description="A link from another app, or one that would open in Peek, opens as a tab in the rule’s Space when its address matches. The first rule that matches wins."
    >
      {withKeys(rules).map(({ rule, key, index: i }) =>
        editing === i ? (
          <SettingRow key={key} id={`link-rule-${i}`} label="Edit rule" stacked>
            <RuleForm
              rule={rule}
              spaces={spaces}
              onCancel={() => setEditing(undefined)}
              onSave={(changed) => {
                setEditing(undefined)
                void save(rules.map((r, j) => (j === i ? changed : r)))
              }}
            />
          </SettingRow>
        ) : (
          <RuleRow
            key={key}
            index={i}
            rule={rule}
            spaces={spaces}
            menu={[
              { label: 'Edit', onSelect: () => setEditing(i), testId: 'link-rule-edit' },
              { label: 'Move Up', onSelect: () => move(i, i - 1), disabled: i === 0, testId: 'link-rule-up' },
              {
                label: 'Move Down',
                onSelect: () => move(i, i + 1),
                disabled: i === rules.length - 1,
                testId: 'link-rule-down',
              },
              {
                label: 'Remove',
                danger: true,
                onSelect: () => void save(rules.filter((_, j) => j !== i)),
                testId: 'link-rule-remove',
              },
            ]}
          />
        ),
      )}
      {editing === 'new' ? (
        <SettingRow id="link-rule-new" label="New rule" stacked>
          <RuleForm
            spaces={spaces}
            onCancel={() => setEditing(undefined)}
            onSave={(rule) => {
              setEditing(undefined)
              void save([...rules, rule])
            }}
          />
        </SettingRow>
      ) : (
        <SettingRow
          id="link-rule-add"
          label={rules.length === 0 ? 'No rules yet' : 'Add a rule'}
          description={
            rules.length === 0 ? 'For example: links containing “figma.com” open in your Work Space.' : undefined
          }
        >
          <Button testId="link-rule-add" disabled={spaces.length === 0} onClick={() => setEditing('new')}>
            Add Rule…
          </Button>
        </SettingRow>
      )}
    </SettingGroup>
  )
}

/** Rules have no ids: each is keyed by what it says (and which repeat it is). */
function withKeys(rules: readonly LinkRule[]): { rule: LinkRule; key: string; index: number }[] {
  const seen = new Map<string, number>()
  return rules.map((rule, index) => {
    const base = `${rule.match}|${rule.spaceId}|${rule.value}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return { rule, key: n ? `${base}#${n}` : base, index }
  })
}

function RuleRow({
  index,
  rule,
  spaces,
  menu,
}: {
  index: number
  rule: LinkRule
  spaces: SpaceRow[]
  menu: MenuItem[]
}) {
  const space = spaces.find((s) => s.id === rule.spaceId)
  return (
    <SettingRow
      id={`link-rule-${index}`}
      label={
        <span className="st-rule">
          {rule.match === 'exact' ? 'Address is ' : 'Address contains '}
          <span className="st-key">{rule.value}</span>
        </span>
      }
      description={space ? `Opens in ${space.name}` : 'Its Space was deleted: this rule does nothing'}
    >
      <RowMenu label="Rule options" items={menu} testId={`link-rule-menu-${index}`} />
    </SettingRow>
  )
}

function RuleForm({
  rule,
  spaces,
  onSave,
  onCancel,
}: {
  rule?: LinkRule
  spaces: SpaceRow[]
  onSave: (rule: LinkRule) => void
  onCancel: () => void
}) {
  const [match, setMatch] = useState<LinkRule['match']>(rule?.match ?? 'contains')
  const [value, setValue] = useState(rule?.value ?? '')
  const [spaceId, setSpaceId] = useState(
    rule && spaces.some((s) => s.id === rule.spaceId) ? rule.spaceId : (spaces[0]?.id ?? ''),
  )
  const [error, setError] = useState<string>()
  return (
    <form
      className="st-form"
      data-testid="link-rule-form"
      onSubmit={(e) => {
        e.preventDefault()
        const trimmed = value.trim()
        if (!trimmed) {
          setError(match === 'exact' ? 'Enter the address' : 'Enter part of an address, such as a domain')
          return
        }
        onSave({ match, value: trimmed, spaceId })
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
    >
      <div className="st-form__fields">
        <Select
          label="Match"
          value={match}
          testId="link-rule-match"
          options={[
            { value: 'contains', label: 'Address contains' },
            { value: 'exact', label: 'Address is exactly' },
          ]}
          onChange={setMatch}
        />
        <TextField
          label={match === 'exact' ? 'Address' : 'Text'}
          hideLabel
          value={value}
          placeholder={match === 'exact' ? 'https://example.com/page' : 'example.com'}
          error={error}
          testId="link-rule-value"
          autoFocus
          wide
          onChange={(v) => {
            setValue(v)
            setError(undefined)
          }}
        />
      </div>
      <div className="st-form__fields">
        <span className="st-form__words">opens in</span>
        <Select
          label="Space"
          value={spaceId}
          testId="link-rule-space"
          options={spaces.map((s) => ({ value: s.id, label: s.name }))}
          onChange={setSpaceId}
        />
      </div>
      <div className="st-form__actions">
        <Button onClick={onCancel}>Cancel</Button>
        <Button kind="primary" type="submit" testId="link-rule-save">
          Save Rule
        </Button>
      </div>
    </form>
  )
}

/** Peek options (PK-12, PK-03). */
function PeekGroup() {
  const pinned = useOrbit((s) => s.settings.peekExternalLinks)
  const shift = useOrbit((s) => s.settings.peekShiftClick)
  return (
    <SettingGroup title="Peek">
      <SettingRow
        id="peek-external-links"
        label="Open links from pinned tabs and Favorites in Peek"
        description="A link to another site opens over the page, so the pinned tab stays where it was."
      >
        <Switch
          label="Open links from pinned tabs and Favorites in Peek"
          checked={pinned}
          testId="peek-external-links"
          onChange={(next) => void invoke('settings.update', { peekExternalLinks: next })}
        />
      </SettingRow>
      <SettingRow id="peek-shift-click" label="Shift-click opens links in Peek">
        <Switch
          label="Shift-click opens links in Peek"
          checked={shift}
          testId="peek-shift-click"
          onChange={(next) => void invoke('settings.update', { peekShiftClick: next })}
        />
      </SettingRow>
    </SettingGroup>
  )
}

export default {
  id: 'links',
  label: 'Links',
  icon: Route,
  order: 50,
  component: LinksPage,
  keywords: ['links from other apps', 'external links', 'routing', 'rules', 'peek', 'mini window', 'shift-click'],
} satisfies SettingsSection
