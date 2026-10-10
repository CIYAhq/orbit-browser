import { useEffect, useState } from 'react'
import type { VersionInfo } from '../../../shared/commands/devtools'
import { invoke } from '../api'
import type { InternalPage } from './registry'

const ROWS: [keyof VersionInfo, string][] = [
  ['orbit', 'Orbit'],
  ['electron', 'Electron'],
  ['chromium', 'Chromium'],
  ['v8', 'V8'],
  ['node', 'Node.js'],
  ['os', 'Operating system'],
  ['arch', 'Architecture'],
]

/** `orbit://version/`: what Orbit runs on, to quote in a bug report (the text can be selected). */
function VersionPage() {
  const [info, setInfo] = useState<VersionInfo | null>(null)
  useEffect(() => {
    void invoke('devtools.version', {}).then(setInfo)
  }, [])
  return (
    <>
      <h1 className="internal__title">Version</h1>
      <dl className="internal__facts" data-testid="version-facts" data-answered={info ? 'true' : 'false'}>
        {ROWS.map(([key, label]) => (
          <div key={key} className="internal__fact">
            <dt>{label}</dt>
            <dd data-testid={`version-${key}`}>{info?.[key] ?? ''}</dd>
          </div>
        ))}
      </dl>
    </>
  )
}

export const page: InternalPage = {
  name: 'version',
  title: 'Version',
  description: 'The versions of Orbit, its engine and the operating system.',
  component: VersionPage,
}
