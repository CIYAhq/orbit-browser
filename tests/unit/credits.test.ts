import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CREDITS_SCRIPT,
  type Credit,
  creditOf,
  creditsHtml,
  creditsPage,
  importedPackages,
  packageDirOf,
  runtimeClosure,
  VITE_PRELOAD_HELPER,
  viteCredit,
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

  it('says Chromium’s licences aren’t in this copy, with no link, until main gives their file', () => {
    const html = creditsHtml(credit('Orbit'), credit('Electron'), [])
    expect(html).toContain('<span id="chromium-found" hidden>')
    expect(html).toContain('<a id="chromium-link">LICENSES.chromium.html</a>')
    expect(html).toMatch(/<span id="chromium-missing">[^<]*isn’t in this copy of Orbit\.<\/span>/)
  })

  it('credits Vite, with its own licence only, when the bundle has its preload helper', () => {
    const vite = viteCredit(join(root, 'node_modules/vite'))
    expect(vite).toMatchObject({ name: 'vite', license: 'MIT' })
    expect(vite?.text).toMatch(/^# Vite core license[\s\S]*Permission is hereby granted/)
    expect(vite?.text).not.toContain('bundled dependencies')
    const page = (modules: Record<string, { renderedLength: number }>) => {
      let source = ''
      const hook = creditsPage(root).generateBundle as (this: unknown, options: unknown, bundle: unknown) => void
      hook.call(
        { emitFile: (file: { source: string }) => (source = file.source) },
        {},
        { 'index.js': { type: 'chunk', modules } },
      )
      return source
    }
    expect(page({ [VITE_PRELOAD_HELPER]: { renderedLength: 120 } })).toContain('<section id="pkg-vite">')
    expect(page({ [VITE_PRELOAD_HELPER]: { renderedLength: 0 } })).not.toContain('<section id="pkg-vite">')
    expect(page({})).not.toContain('<section id="pkg-vite">')
  })
})
