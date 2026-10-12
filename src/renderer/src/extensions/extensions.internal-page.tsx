import { type ReactNode, useEffect, useState } from 'react'
import { EXTENSIONS_PAGE, type ExtensionsPageInfo } from '../../../shared/commands/extensions'
import { extensionsOf, permissionLines, siteAccessText } from '../../../shared/extensions'
import { isPrivateProfileId } from '../../../shared/private'
import type { InstalledExtension } from '../../../shared/state'
import { invoke } from '../api'
import type { InternalPage } from '../internal/registry'
import { useOrbit, useOrbitShallow } from '../store'
import { ExtensionIcon } from './ExtensionIcon'
import './extensions.css'

const SOURCE_TEXT: Record<InstalledExtension['source'], string> = {
  crx: 'Added from a file',
  store: 'Added from the Chrome Web Store',
  folder: 'Loaded from a folder (Developer mode)',
}

/** An on/off switch of the page's own (the page is a tab, not the Settings window). */
function Switch({
  checked,
  onChange,
  label,
  disabled,
  testId,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  testId?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      className="ext-switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      onClick={() => onChange(!checked)}
    >
      <span className="ext-switch__knob" />
    </button>
  )
}

/** A row of an extension's Details: a label, then what it says or a switch. */
function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="ext-fact" data-testid={testId}>
      <dt className="ext-fact__label">{label}</dt>
      <dd className="ext-fact__value">{children}</dd>
    </div>
  )
}

/** Details (EX-07): what it is, what it may do, where it runs, and its switches. */
function Details({ ext }: { ext: InstalledExtension }) {
  const lines = permissionLines(ext.permissions, ext.hosts)
  return (
    <dl className="ext-details" data-testid="ext-details-panel">
      {ext.description && <Fact label="Description">{ext.description}</Fact>}
      <Fact label="Version">{ext.version}</Fact>
      <Fact label="Permissions" testId="ext-permissions">
        {lines.length > 0 ? (
          <ul className="ext-details__list">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          'No special permissions'
        )}
      </Fact>
      <Fact label="Site access" testId="ext-site-access">
        {siteAccessText(ext.hosts)}
      </Fact>
      <Fact label="Allow in private windows">
        <Switch
          checked={ext.allowPrivate}
          label={`Allow ${ext.name} in private windows`}
          testId="ext-allow-private"
          onChange={(allowed) => void invoke('extensions.setAllowed', { id: ext.id, what: 'private', allowed })}
        />
      </Fact>
      <Fact label="Allow access to file URLs">
        <Switch
          checked={ext.allowFileAccess}
          label={`Allow ${ext.name} access to file URLs`}
          testId="ext-allow-files"
          onChange={(allowed) => void invoke('extensions.setAllowed', { id: ext.id, what: 'files', allowed })}
        />
      </Fact>
      <Fact label="Options">
        {ext.options ? (
          <button
            type="button"
            className="ext-link"
            data-testid="ext-options"
            disabled={!ext.enabled || !!ext.error}
            onClick={() => void invoke('extensions.openOptions', { id: ext.id })}
          >
            Extension options
          </button>
        ) : (
          'None'
        )}
      </Fact>
      <Fact label="Errors" testId="ext-errors">
        {ext.error ?? 'None'}
      </Fact>
      <Fact label="Source">{SOURCE_TEXT[ext.source]}</Fact>
    </dl>
  )
}

/** One extension: its icon, name and description, its switch, Details and Remove (EX-07, EX-08). */
function ExtensionCard({ ext, devMode }: { ext: InstalledExtension; devMode: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <li
      className="ext-card"
      data-testid="ext-card"
      data-id={ext.id}
      data-enabled={ext.enabled ? 'true' : 'false'}
      data-error={ext.error ? 'true' : 'false'}
    >
      <div className="ext-card__row">
        <ExtensionIcon icon={ext.icon} size={32} />
        <div className="ext-card__main">
          <div className="ext-card__name" data-testid="ext-name">
            {ext.name}
            <span className="ext-card__version">{ext.version}</span>
          </div>
          {ext.description && <div className="ext-card__desc">{ext.description}</div>}
          {ext.error && (
            <div className="ext-card__error" role="alert" data-testid="ext-error">
              {ext.error}
            </div>
          )}
          {devMode && (
            <div className="ext-card__dev" data-testid="ext-dev-info">
              <span>
                ID <code>{ext.id}</code>
              </span>
              {ext.source === 'folder' && (
                <span>
                  Folder <code>{ext.path}</code>
                </span>
              )}
            </div>
          )}
        </div>
        <Switch
          checked={ext.enabled}
          label={`${ext.name} on or off`}
          testId="ext-toggle"
          onChange={(enabled) => void invoke('extensions.setEnabled', { id: ext.id, enabled })}
        />
      </div>
      <div className="ext-card__actions">
        <button
          type="button"
          className="ext-button"
          aria-expanded={open}
          data-testid="ext-details"
          onClick={() => setOpen((o) => !o)}
        >
          Details
        </button>
        <button
          type="button"
          className="ext-button"
          data-testid="ext-remove"
          onClick={() => void invoke('extensions.remove', { id: ext.id })}
        >
          Remove
        </button>
        {devMode && ext.source === 'folder' && (
          <button
            type="button"
            className="ext-button"
            data-testid="ext-reload"
            onClick={() => void invoke('extensions.reload', { id: ext.id })}
          >
            Reload
          </button>
        )}
      </div>
      {open && <Details ext={ext} />}
    </li>
  )
}

/**
 * `orbit://extensions/` (EX-07): the extensions of the profile the tab is in (EX-09), each with its
 * switch, which acts at once, Details and Remove. Install from file adds a .crx; Developer mode
 * shows IDs and folders and adds Load unpacked. Main answers about this tab's own profile only (D53).
 */
function ExtensionsPage() {
  const [info, setInfo] = useState<ExtensionsPageInfo | null>(null)
  useEffect(() => {
    void invoke('extensions.pageInfo', {}).then(setInfo)
  }, [])
  const profileId = info?.profileId
  const list = useOrbitShallow((s) => (profileId ? extensionsOf(s.extensions, profileId) : []))
  const devMode = useOrbit((s) => s.settings.extensionsDevMode)
  const profiles = useOrbit((s) => Object.keys(s.profiles).filter((id) => !isPrivateProfileId(id)).length)
  return (
    <div
      className="ext-page"
      data-testid="ext-page"
      data-ready={info ? 'true' : 'false'}
      data-profile={profileId ?? ''}
    >
      <header className="ext-page__head">
        <div>
          <h1 className="internal__title ext-page__title">Extensions</h1>
          {info && profiles > 1 && (
            <p className="ext-page__profile" data-testid="ext-profile">
              In the {info.profileName} profile
            </p>
          )}
        </div>
        <div className="ext-page__dev">
          <span>Developer mode</span>
          <Switch
            checked={devMode}
            label="Developer mode"
            testId="ext-dev-mode"
            onChange={(on) => void invoke('extensions.setDevMode', { on })}
          />
        </div>
      </header>
      <div className="ext-page__actions">
        <button
          type="button"
          className="ext-button"
          data-testid="ext-install-file"
          onClick={() => void invoke('extensions.installFile', {})}
        >
          Install from file…
        </button>
        {devMode && (
          <button
            type="button"
            className="ext-button"
            data-testid="ext-load-unpacked"
            onClick={() => void invoke('extensions.loadUnpacked', {})}
          >
            Load unpacked…
          </button>
        )}
      </div>
      {info && list.length === 0 && (
        <p className="internal__text ext-page__empty" data-testid="ext-empty">
          No extensions in this profile yet.
        </p>
      )}
      {list.length > 0 && (
        <ul className="ext-list" data-testid="ext-list">
          {list.map((ext) => (
            <ExtensionCard key={ext.id} ext={ext} devMode={devMode} />
          ))}
        </ul>
      )}
    </div>
  )
}

export const page: InternalPage = {
  name: EXTENSIONS_PAGE,
  title: 'Extensions',
  description: 'The extensions of this tab’s profile: turn them on or off, see their details, remove them.',
  component: ExtensionsPage,
}
