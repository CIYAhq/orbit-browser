import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * FL-28's guard (feel review M1 and follow-up 6): reduced motion, the OS setting or Orbit's own
 * (`settings.reduceMotion`), reaches every animation in the renderer.
 *
 * - motion's components (`motion.*`, `m.*`, `AnimatePresence`, `LayoutGroup`) reduce their motion
 *   only under `OrbitMotionConfig`. A component that renders them sits under it wherever it is
 *   rendered, or reads reduced motion itself (`useReducedMotion()`, `reducedMotion()`).
 * - motion's `animate()` follows no config: a file that calls it reads reduced motion.
 * - Stylesheets key their reduced rules off the root's `reduce-motion` class (motion/reduced.ts),
 *   never off the `prefers-reduced-motion` media query alone, which misses Orbit's switch.
 *
 * The code is read as text, one top-level declaration at a time (Biome starts each at the start of a
 * line). Who renders whom comes from JSX tags and imports; a component nothing renders by a tag (a
 * view's app, mounted by main.tsx) is a root, rendered under no config.
 */
const RENDERER = resolve(__dirname, '../../src/renderer')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else out.push(path)
  }
  return out
}

const files = walk(RENDERER)
const code = files.filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'))
const text = new Map(code.map((f) => [f, readFileSync(f, 'utf8')]))
const rel = (f: string) => relative(join(RENDERER, 'src'), f)

const MOTION_JSX = /<(?:motion|m)\.[a-z]\w*|<AnimatePresence\b|<LayoutGroup\b|<Reorder\.\w+/g
/** A motion element that animates (not one that only carries motion values in its style). */
const ANIMATES = /\b(?:animate|initial|exit|layout|layoutId|variants|transition|drag|while[A-Z]\w*)\b/
const READS_REDUCED = /\b(?:useReducedMotion|reducedMotion|prefersReducedMotion)\(/
/** A JSX tag naming a component: `<Name` not right after a name (that's a type argument: `useRef<Name>`). */
const TAG = /(?<![\w$.)\]])<([A-Z]\w*)(?=[\s>/.])/g

interface Unit {
  file: string
  name: string
  text: string
}

/** A file's top-level declarations: each starts at a line that starts with a letter. */
function unitsOf(file: string, src: string): Unit[] {
  const units: Unit[] = []
  let current: Unit | null = null
  for (const line of src.split('\n')) {
    if (/^[A-Za-z_$@]/.test(line)) {
      const m =
        /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+(\w+)|(?:const|let|var)\s+(\w+)|class\s+(\w+))/.exec(
          line,
        )
      current = { file, name: m?.[1] ?? m?.[2] ?? m?.[3] ?? '', text: '' }
      units.push(current)
    }
    if (current) current.text += `${line}\n`
  }
  return units
}

/** Where an opening tag that starts at `from` (its `<`) ends, and whether it closes itself. */
function openTag(src: string, from: number): { end: number; self: boolean } {
  let depth = 0
  let quote: string | null = null
  for (let i = from + 1; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === quote && src[i - 1] !== '\\') quote = null
      continue
    }
    if (depth > 0 && (c === "'" || c === '"' || c === '`')) quote = c
    else if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0) return { end: i + 1, self: src[i - 1] === '/' }
  }
  return { end: src.length, self: true }
}

/** The spans of `src` inside an element of one of `wrappers` (between its opening and closing tags). */
function regions(src: string, wrappers: Set<string>): [number, number][] {
  const out: [number, number][] = []
  for (const m of src.matchAll(TAG)) {
    const name = m[1] as string
    if (!wrappers.has(name)) continue
    const open = openTag(src, m.index)
    if (open.self) continue
    let depth = 1
    const tags = new RegExp(`<(/?)${name}(?=[\\s>/])`, 'g')
    tags.lastIndex = open.end
    let close = src.length
    for (let t = tags.exec(src); t; t = tags.exec(src)) {
      if (t[1]) depth--
      else if (!openTag(src, t.index).self) depth++
      if (depth === 0) {
        close = t.index
        break
      }
    }
    out.push([open.end, close])
  }
  return out
}

const inside = (spans: [number, number][], at: number) => spans.some(([a, b]) => at >= a && at < b)

/** Files a module specifier names, barrels (`export * from`) followed. */
function moduleFiles(from: string, spec: string, seen = new Set<string>()): string[] {
  if (!spec.startsWith('.')) return []
  const base = resolve(dirname(from), spec)
  const file = [`${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')].find((f) => text.has(f))
  if (!file || seen.has(file)) return []
  seen.add(file)
  const out = [file]
  for (const m of (text.get(file) as string).matchAll(/^export\s+(?:\*|\{[^}]*\})\s+from\s+'([^']+)'/gm))
    out.push(...moduleFiles(file, m[1] as string, seen))
  return out
}

/** A file's imported names: local name → the files that may define it. */
function importsOf(file: string, src: string): Map<string, { name: string; files: string[] }> {
  const out = new Map<string, { name: string; files: string[] }>()
  for (const m of src.matchAll(/^import\s+(?:type\s+)?([\s\S]*?)\s+from\s+'([^']+)'/gm)) {
    const clause = m[1] as string
    const files = moduleFiles(file, m[2] as string)
    if (files.length === 0) continue
    const named = /\{([\s\S]*)\}/.exec(clause)?.[1] ?? ''
    for (const part of named.split(',')) {
      const [imported, local] = part
        .replace(/^\s*type\s+/, '')
        .split(/\s+as\s+/)
        .map((s) => s.trim())
      if (imported) out.set(local || imported, { name: imported, files })
    }
  }
  return out
}

interface Graph {
  units: Unit[]
  /** Who renders whom, and whether under OrbitMotionConfig there. */
  edges: Map<Unit, { to: Unit; covered: boolean }[]>
  wrappers: Set<string>
}

function graph(): Graph {
  const units = code.flatMap((f) => unitsOf(f, text.get(f) as string))
  const byFile = new Map<string, Unit[]>()
  for (const u of units) byFile.set(u.file, [...(byFile.get(u.file) ?? []), u])
  // Components that render their children under OrbitMotionConfig wrap them as it does.
  const wrappers = new Set(['OrbitMotionConfig'])
  for (let grew = true; grew; ) {
    grew = false
    for (const u of units) {
      if (!/^[A-Z]/.test(u.name) || wrappers.has(u.name)) continue
      const spans = regions(u.text, wrappers)
      const children = [...u.text.matchAll(/\{(?:props\.)?children\}/g)]
      if (children.length > 0 && children.every((c) => inside(spans, c.index))) {
        wrappers.add(u.name)
        grew = true
      }
    }
  }
  const edges = new Map<Unit, { to: Unit; covered: boolean }[]>()
  for (const u of units) {
    const spans = regions(u.text, wrappers)
    const own = byFile.get(u.file) ?? []
    const imports = importsOf(u.file, text.get(u.file) as string)
    const list: { to: Unit; covered: boolean }[] = []
    const add = (targets: Unit[], at: number) => {
      for (const to of targets) if (to !== u) list.push({ to, covered: inside(spans, at) })
    }
    for (const m of u.text.matchAll(TAG)) {
      const name = m[1] as string
      const local = own.filter((o) => o.name === name)
      if (local.length > 0) add(local, m.index)
      else {
        const imported = imports.get(name)
        if (imported)
          add(
            units.filter((o) => o.name === imported.name && imported.files.includes(o.file)),
            m.index,
          )
      }
    }
    // Helpers in the same file that return JSX, called by name.
    for (const helper of own) {
      if (!/^[a-z]/.test(helper.name) || helper === u || !/<[A-Za-z]/.test(helper.text)) continue
      for (const m of u.text.matchAll(new RegExp(`\\b${helper.name}\\(`, 'g'))) add([helper], m.index)
    }
    edges.set(u, list)
  }
  return { units, edges, wrappers }
}

/** Components that render motion's components, outside OrbitMotionConfig somewhere, without reading reduced motion. */
function unguarded(g: Graph): string[] {
  const rendered = new Set<Unit>()
  for (const list of g.edges.values()) for (const e of list) rendered.add(e.to)
  // Rendered under no config: the roots, and whatever an exposed component renders outside one.
  const exposed = new Set(g.units.filter((u) => !rendered.has(u)))
  const queue = [...exposed]
  for (let u = queue.shift(); u; u = queue.shift()) {
    for (const e of g.edges.get(u) ?? []) {
      if (e.covered || exposed.has(e.to)) continue
      exposed.add(e.to)
      queue.push(e.to)
    }
  }
  const out: string[] = []
  for (const u of exposed) {
    const spans = regions(u.text, g.wrappers)
    const bare = [...u.text.matchAll(MOTION_JSX)].some(
      (m) =>
        !inside(spans, m.index) &&
        (!/^<(?:motion|m)\./.test(m[0]) || ANIMATES.test(u.text.slice(m.index, openTag(u.text, m.index).end))),
    )
    if (bare && !READS_REDUCED.test(u.text)) out.push(`${rel(u.file)}: ${u.name || '(top level)'}`)
  }
  return out.sort()
}

describe('[FL-28] reduced motion reaches every animation (feel review follow-up 6)', () => {
  const g = graph()

  it('reads the render tree: the sidebar lists, the overlay and the toasts render under OrbitMotionConfig', () => {
    // The reader itself: these are known to sit under a config, and a reader that lost them would pass anything.
    expect(g.wrappers).toContain('ListScope')
    const covered = (name: string) =>
      [...g.edges.values()].flat().filter((e) => e.to.name === name && e.covered).length > 0
    for (const name of ['Favorites', 'FolderSearch', 'IconPicker', 'DragGhost', 'CommandBar', 'Toasts'])
      expect(covered(name), `${name} is rendered under OrbitMotionConfig`).toBe(true)
  })

  it("every component that renders motion's components sits under OrbitMotionConfig or reads reduced motion", () => {
    expect(unguarded(g)).toEqual([])
  })

  it("every file that calls motion's animate() reads reduced motion", () => {
    const bare = code.filter((f) => {
      const src = text.get(f) as string
      const animates = /^import\s*\{[^}]*\b(?:animate|animateMini|useAnimate)\b[^}]*\}\s*from\s*'motion(?:\/react)?'/m
      return animates.test(src) && !READS_REDUCED.test(src)
    })
    expect(bare.map(rel)).toEqual([])
  })

  it('stylesheets key reduced rules off the reduce-motion class, not the media query alone', () => {
    const css = files.filter((f) => f.endsWith('.css'))
    expect(css.length).toBeGreaterThan(10)
    const media = css.filter((f) => /prefers-reduced-motion/.test(readFileSync(f, 'utf8')))
    expect(media.map(rel)).toEqual([])
    // Scripts ask reducedMotion(); only motion/reduced.ts reads the media query.
    const scripts = code.filter(
      (f) => !f.endsWith(join('motion', 'reduced.ts')) && /\(prefers-reduced-motion/.test(text.get(f) as string),
    )
    expect(scripts.map(rel)).toEqual([])
  })
})

describe('the guard catches what it should', () => {
  it('a component rendering motion outside any config, rendered by a root, is caught; under the config, or reading reduced motion, it is not', () => {
    // Toasts as M1 found them: outside the config, reading nothing.
    const shell = join(RENDERER, 'src/shell/ShellApp.tsx')
    const toasts = join(RENDERER, 'src/shell/Toasts.tsx')
    const src = text.get(shell) as string
    const own = text.get(toasts) as string
    expect(src).toContain('<OrbitMotionConfig>')
    expect(own).toContain('useReducedMotion()')
    const bare = src.replace(/<OrbitMotionConfig>\s*(<Toasts \/>)\s*<\/OrbitMotionConfig>/, '$1')
    try {
      text.set(shell, bare)
      text.set(toasts, own.replace('useReducedMotion()', 'false'))
      expect(unguarded(graph())).toContain('shell/Toasts.tsx: Toasts')
      text.set(toasts, own)
      expect(unguarded(graph())).not.toContain('shell/Toasts.tsx: Toasts')
    } finally {
      text.set(shell, src)
      text.set(toasts, own)
    }
    expect(unguarded(graph())).not.toContain('shell/Toasts.tsx: Toasts')
  })
})
