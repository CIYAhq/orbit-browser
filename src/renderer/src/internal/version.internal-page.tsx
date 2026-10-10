import { useEffect, useState } from 'react'
import type { BuildInfo } from '../../../shared/commands/settings'
import { invoke } from '../api'
import type { InternalPage } from './registry'

const ROWS: [keyof BuildInfo, string][] = [
  ['version', 'Orbit'],
  ['built', 'Built'],
  ['electron', 'Electron'],
  ['chrome', 'Chromium'],
  ['v8', 'V8'],
  ['node', 'Node.js'],
  ['os', 'Operating system'],
  ['arch', 'Architecture'],
]

/** `orbit://version/`: what Orbit runs on (the build info About shows), to quote in a bug report. */
function VersionPage() {
  const [info, setInfo] = useState<BuildInfo | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    void invoke('settings.buildInfo', {}).then(setInfo)
  }, [])
  return (
    <>
      <h1 className="internal__title">Version</h1>
      <dl className="internal__facts" data-testid="version-facts" data-answered={info ? 'true' : 'false'}>
        {ROWS.filter(([key]) => !info || info[key]).map(([key, label]) => (
          <div key={key} className="internal__fact">
            <dt>{label}</dt>
            <dd data-testid={`version-${key}`}>{info?.[key] ?? ''}</dd>
          </div>
        ))}
      </dl>
      <p className="internal__actions">
        <button
          type="button"
          className="internal__button"
          data-testid="version-copy"
          onClick={() => void invoke('settings.copyBuildInfo', {}).then(() => setCopied(true))}
        >
          {copied ? 'Copied' : 'Copy build info'}
        </button>
      </p>
    </>
  )
}

export const page: InternalPage = {
  name: 'version',
  title: 'Version',
  description: 'The versions of Orbit, its engine and the operating system.',
  component: VersionPage,
}
