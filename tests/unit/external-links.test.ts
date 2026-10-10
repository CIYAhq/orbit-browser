import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { linksFromArgv, privateSwitchIn, urlsInArgv } from '../../src/main/external-links'

describe('links from another launch (review F10)', () => {
  it('keeps web and file URLs and existing page files, skipping switches and the app path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-links-'))
    writeFileSync(join(dir, 'page.html'), '<p>hi</p>')
    writeFileSync(join(dir, 'notes.md'), '# not a page')
    const argv = [
      '/opt/Orbit/orbit',
      '--no-sandbox',
      '--original-process-start-time=1',
      '/opt/Orbit/resources/app.asar/out/main/index.js',
      'https://example.com/a?b=1',
      'HTTP://EXAMPLE.ORG',
      'page.html',
      'notes.md',
      'missing.html',
      'mailto:someone@example.com',
      'file:///tmp/x.html',
    ]
    expect(linksFromArgv(argv, dir)).toEqual([
      'https://example.com/a?b=1',
      'HTTP://EXAMPLE.ORG',
      pathToFileURL(join(dir, 'page.html')).href,
      'file:///tmp/x.html',
    ])
  })

  it('leaves the links of a launch for a private window to that window (review B-F6)', () => {
    const argv = ['/opt/Orbit/orbit', '--private-window', 'https://example.com/a', 'https://example.org/b']
    expect(linksFromArgv(argv, '/')).toEqual([])
    expect(urlsInArgv(argv, '/')).toEqual(['https://example.com/a', 'https://example.org/b'])
    expect(privateSwitchIn(['orbit', 'https://example.com/a', '--Private-Window'])).toBe(true)
    expect(privateSwitchIn(['orbit', 'https://example.com/--private-window'])).toBe(false)
  })
})
