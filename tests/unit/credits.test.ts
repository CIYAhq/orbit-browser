import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CREDITS_SCRIPT,
  type Credit,
  creditOf,
  creditsHtml,
  importedPackages,
  packageDirOf,
  runtimeClosure,
} from '../../scripts/credits'

const root = join(import.meta.dirname, '../..')
const credit = (name: string, text = 'MIT License'): Credit => ({ name, version: '1.0.0', license: 'MIT', text })

describe('[ST-17][UP-07] the open-source credits that come with Orbit (D43)', () => {
  it('finds the package a bundled module came from, the innermost one', () => {
    expect(packageDirOf('/w/node_modules/react/cjs/react.production.js')).toBe('/w/node_modules/react')
    expect(packageDirOf('\0/w/node_modules/react-dom/index.js?commonjs-module')).toBe('/w/node_modules/react-dom')
    expect(packageDirOf('/w/node_modules/@scope/pkg/dist/a.js')).toBe('/w/node_modules/@scope/pkg')
    expect(packageDirOf('/w/node_modules/a/node_modules/b/index.js')).toBe('/w/node_modules/a/node_modules/b')
    expect(packageDirOf('C:\\w\\node_modules\\zustand\\esm\\index.mjs')).toBe('C:/w/node_modules/zustand')
    expect(packageDirOf('/w/src/renderer/src/main.tsx')).toBeUndefined()
  })

  it("reads a package's licence and the packages it needs at run time, not the ones it installs with", () => {
    const immer = creditOf(join(root, 'node_modules/immer'))
    expect(immer).toMatchObject({ name: 'immer', license: 'MIT' })
    expect(immer?.text).toMatch(/MIT License|Permission is hereby granted/)
    const names = runtimeClosure(['react-dom'], root).map((dir) => creditOf(dir)?.name)
    expect(names.sort()).toEqual(['react-dom', 'scheduler'])
    expect(importedPackages([join(root, 'src/renderer/src')])).toEqual(expect.arrayContaining(['react', 'zustand']))
    expect(importedPackages([join(root, 'src/preload')])).not.toContain('electron')
  })

  it('gives every licence in full, as text, and runs only its own script', () => {
    const html = creditsHtml(credit('Orbit'), credit('Electron'), [credit('zeta'), credit('<b>alpha</b>', 'a < b & c')])
    expect(html).toContain('<pre>a &lt; b &amp; c</pre>')
    expect(html).toContain('&lt;b&gt;alpha&lt;/b&gt;')
    expect(html).not.toContain('<b>alpha</b>')
    expect(html.indexOf('&lt;b&gt;alpha')).toBeLessThan(html.indexOf('zeta'))
    expect(html).toContain('npm packages (2)')
    const hash = createHash('sha256').update(CREDITS_SCRIPT).digest('base64')
    expect(html).toContain(`script-src 'sha256-${hash}'`)
    expect(html).toContain(`<script>${CREDITS_SCRIPT}</script>`)
    expect(html).toContain("default-src 'none'")
  })
})
