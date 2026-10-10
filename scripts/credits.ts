import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Plugin } from 'vite'

/**
 * Orbit's open-source credits (ST-17, UP-07, D43): a page that comes with the app, so the Licence and
 * Open-source credits rows of About open it offline and for anyone. It gives Orbit's licence,
 * Electron's, a link to Chromium's (Electron ships them as LICENSES.chromium.html, 20 MB, which main
 * finds at run time) and the licence of every npm package whose code ships: the ones the renderer
 * bundle took code from, and package.json's dependencies (main loads them from node_modules) with
 * the packages they need. The renderer build emits it as credits.html beside index.html; the
 * development server serves it at /credits.html.
 */

export interface Credit {
  name: string
  version: string
  /** The licence package.json names (an SPDX expression, usually). */
  license: string
  /** The package's licence file, or '' when it ships none. */
  text: string
  homepage?: string
}

const PACKAGE_IN_PATH = /\/node_modules\/(?:@[^/]+\/)?[^/]+(?=\/)/g
const LICENCE_FILE = /^(licen[cs]e|copying)([.-].*)?$/i
/** A value import of a package (not `import type`): `react-dom` from `react-dom/client`. */
const PACKAGE_IMPORT = /^import (?!type )[^;]*? from '((?:@[^/']+\/)?[^./'][^/']*)/gm

/** The directory of the npm package a bundled module came from (the innermost node_modules), if any. */
export function packageDirOf(id: string): string | undefined {
  const path = id.replace(/^\0/, '').replace(/\?.*$/, '').replaceAll('\\', '/')
  let dir: string | undefined
  for (const m of path.matchAll(PACKAGE_IN_PATH)) dir = path.slice(0, m.index + m[0].length)
  return dir
}

/** A package's credit, from its package.json and licence file. */
export function creditOf(dir: string, licenceFile?: string): Credit | undefined {
  let pkg: { name?: unknown; version?: unknown; license?: unknown; homepage?: unknown }
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  if (typeof pkg.name !== 'string') return undefined
  const file =
    licenceFile ??
    readdirSync(dir)
      .filter((f) => LICENCE_FILE.test(f))
      .sort()[0]
  const declared = pkg.license as { type?: unknown } | string | undefined
  const license =
    typeof declared === 'string' ? declared : typeof declared?.type === 'string' ? declared.type : 'Not stated'
  return {
    name: pkg.name,
    version: typeof pkg.version === 'string' ? pkg.version : '',
    license,
    text: file && existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8').trim() : '',
    homepage: typeof pkg.homepage === 'string' ? pkg.homepage : undefined,
  }
}

/** The directories of packages and of the packages they need at run time, found the way Node finds them. */
export function runtimeClosure(names: readonly string[], from: string): string[] {
  const dirs = new Set<string>()
  const visit = (name: string, start: string) => {
    for (let at = start; ; at = dirname(at)) {
      const dir = join(at, 'node_modules', name)
      if (existsSync(join(dir, 'package.json'))) {
        if (dirs.has(dir)) return
        dirs.add(dir)
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: object }
        for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, dir)
        return
      }
      if (dirname(at) === at) return
    }
  }
  for (const name of names) visit(name, from)
  return [...dirs]
}

/** The packages code under these folders imports, for the development server (no bundle to read there). */
export function importedPackages(dirs: readonly string[]): string[] {
  const names = new Set<string>()
  for (const dir of dirs) {
    for (const file of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      if (!/\.tsx?$/.test(file)) continue
      for (const m of readFileSync(join(dir, file), 'utf8').matchAll(PACKAGE_IMPORT)) names.add(m[1] as string)
    }
  }
  // Electron has its own entry, and what its npm package needs only installs it.
  names.delete('electron')
  return [...names]
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

const anchor = (name: string) => `pkg-${name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`

/** Main opens the page with ?chromium=<file URL of LICENSES.chromium.html> when it finds that file. */
export const CREDITS_SCRIPT = `const to = new URLSearchParams(location.search).get('chromium');
const link = document.getElementById('chromium-link');
if (link && to && to.startsWith('file:')) link.href = to;`

function section(id: string, credit: Credit, heading: 'h2' | 'h3'): string {
  const site = credit.homepage?.startsWith('https://')
    ? ` · <a href="${escapeHtml(credit.homepage)}">${escapeHtml(credit.homepage)}</a>`
    : ''
  const text = credit.text
    ? `<pre>${escapeHtml(credit.text)}</pre>`
    : '<p class="muted">The package comes with no licence file; its licence is the one named above.</p>'
  return `<section id="${id}"><${heading}>${escapeHtml(credit.name)} <span class="muted">${escapeHtml(credit.version)}</span></${heading}>
<p class="licence">${escapeHtml(credit.license)}${site}</p>
${text}</section>`
}

/** The credits page: Orbit, Electron, Chromium, then the npm packages by name. */
export function creditsHtml(orbit: Credit, electron: Credit, packages: readonly Credit[]): string {
  const sorted = [...packages].sort((a, b) => a.name.localeCompare(b.name))
  const hash = createHash('sha256').update(CREDITS_SCRIPT).digest('base64')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'">
<title>Open-source credits · Orbit</title>
<style>
:root { color-scheme: light dark; --text: #1d1d22; --muted: #6b6b76; --line: #e4e4ea; --code: #f4f4f7; }
@media (prefers-color-scheme: dark) { :root { --text: #ececf1; --muted: #9a9aa6; --line: #34343c; --code: #202026; } }
body { margin: 0; font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--text); background: Canvas; }
main { max-width: 760px; margin: 0 auto; padding: 40px 16px 80px; }
h1 { font-size: 28px; margin: 0 0 8px; }
h2 { font-size: 20px; margin: 40px 0 4px; padding-top: 16px; border-top: 1px solid var(--line); }
h3 { font-size: 16px; margin: 28px 0 2px; }
.muted { color: var(--muted); font-weight: normal; }
.licence { margin: 0 0 8px; color: var(--muted); }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.5; background: var(--code); padding: 12px 14px; border-radius: 8px; }
a { color: LinkText; }
</style>
</head>
<body>
<main>
<h1>Open-source credits</h1>
<p>Orbit is free software, made with the open-source projects below. Each one's licence is given in full.</p>
<ul>
<li><a href="#orbit">Orbit</a></li>
<li><a href="#electron">Electron</a></li>
<li><a href="#chromium">Chromium</a></li>
<li><a href="#packages">npm packages (${sorted.length})</a></li>
</ul>
${section('orbit', orbit, 'h2')}
${section('electron', electron, 'h2')}
<section id="chromium"><h2>Chromium</h2>
<p>Electron is built on Chromium, whose own code is under a BSD-style licence, and Chromium uses many other open-source projects. Their licences all come with Orbit, in <a id="chromium-link">LICENSES.chromium.html</a>.</p></section>
<section id="packages"><h2>npm packages</h2>
<p>The packages whose code is part of Orbit.</p>
${sorted.map((credit) => section(anchor(credit.name), credit, 'h3')).join('\n')}
</section>
</main>
<script>${CREDITS_SCRIPT}</script>
</body>
</html>
`
}

/** The page, for these package directories plus package.json's dependencies and what they need. */
function creditsFor(root: string, packageDirs: Iterable<string>): string {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: object }
  const dirs = new Set([...packageDirs].map((dir) => resolve(dir)))
  for (const dir of runtimeClosure(Object.keys(pkg.dependencies ?? {}), root)) dirs.add(resolve(dir))
  const orbit = creditOf(root, 'LICENSE')
  const electron = creditOf(join(root, 'node_modules', 'electron'))
  if (!orbit || !electron) throw new Error('credits: no package.json for Orbit or Electron')
  const packages = [...dirs].map((dir) => creditOf(dir)).filter((credit): credit is Credit => !!credit)
  return creditsHtml({ ...orbit, name: 'Orbit' }, { ...electron, name: 'Electron' }, packages)
}

/** The Vite plugin: credits.html in the renderer build, and at /credits.html on the development server. */
export function creditsPage(root = process.cwd()): Plugin {
  return {
    name: 'orbit-credits',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split(/[?#]/)[0] !== '/credits.html') return next()
        const imported = importedPackages([join(root, 'src/renderer/src'), join(root, 'src/shared')])
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(creditsFor(root, runtimeClosure(imported, root)))
      })
    },
    generateBundle(_options, bundle) {
      const dirs = new Set<string>()
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue
        for (const [id, info] of Object.entries(chunk.modules)) {
          const dir = info.renderedLength > 0 ? packageDirOf(id) : undefined
          if (dir) dirs.add(dir)
        }
      }
      this.emitFile({ type: 'asset', fileName: 'credits.html', source: creditsFor(root, dirs) })
    },
  }
}
