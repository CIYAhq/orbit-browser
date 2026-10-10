import { Copy, ExternalLink, Info } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { BuildInfo } from '../../../../shared/commands/settings'
import { LICENSE_URL, PROJECT_URL, RELEASES_URL } from '../../../../shared/project'
import { invoke } from '../../api'
import { Button, SettingGroup, SettingRow } from '../controls'
import type { SettingsSection } from '../registry'

function AboutPage() {
  const [info, setInfo] = useState<BuildInfo>()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    void invoke('settings.buildInfo', {}).then(setInfo)
  }, [])
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <>
      <SettingGroup title="Orbit">
        <SettingRow
          id="version"
          label="Version"
          description="An open-source browser. Everything stays on this computer: Orbit has no accounts and no servers."
        >
          <span data-testid="about-version">{info?.version ?? ''}</span>
        </SettingRow>
        <SettingRow id="engine" label="Engine">
          <span className="st-muted" data-testid="about-engine">
            {info ? `Chromium ${info.chrome} · Electron ${info.electron}` : ''}
          </span>
        </SettingRow>
        <SettingRow id="system" label="System">
          <span className="st-muted">{info ? `${info.os} (${info.arch})` : ''}</span>
        </SettingRow>
        <SettingRow
          id="build-info"
          label="Build info"
          description="Version, engine, system and processor, for a bug report."
        >
          <Button
            testId="copy-build-info"
            onClick={() => void invoke('settings.copyBuildInfo', {}).then(() => setCopied(true))}
          >
            <Copy size={13} />
            {copied ? 'Copied' : 'Copy build info'}
          </Button>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="More">
        <SettingRow id="release-notes" label="Release notes" description="What changed in each version.">
          <OpenLink url={RELEASES_URL} label="Release notes" />
        </SettingRow>
        <SettingRow id="licence" label="Licence" description="Orbit is free software under the MIT licence.">
          <OpenLink url={LICENSE_URL} label="Licence" />
        </SettingRow>
        <SettingRow
          id="credits"
          label="Open-source credits"
          description="Orbit is built on Chromium, Electron, React and other open-source projects."
        >
          <OpenLink url={PROJECT_URL} label="Open-source credits" />
        </SettingRow>
      </SettingGroup>
    </>
  )
}

/** Opens a page in a tab of the browser window Settings belongs to. */
export function OpenLink({ url, label }: { url: string; label: string }) {
  return (
    <Button title={url} onClick={() => void invoke('settings.openUrl', { url })}>
      <ExternalLink size={13} aria-hidden="true" />
      <span className="st-sr">{label}</span>
      Open
    </Button>
  )
}

export default {
  id: 'about',
  label: 'About Orbit',
  icon: Info,
  order: 90,
  component: AboutPage,
  keywords: ['version', 'about', 'build', 'engine', 'chromium', 'electron'],
} satisfies SettingsSection
