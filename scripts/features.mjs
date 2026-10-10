#!/usr/bin/env node
/**
 * Regenerates FEATURES.md, the parity checklist.
 *
 * - Feature IDs, titles and priorities come from the behaviour spec
 *   (`### XX-NN Title` headings followed by `Priority: P0|P1|P2`).
 *   Spec dir: first CLI arg, else $ORBIT_SPEC_DIR, else the Orca context path.
 * - "Tested" is derived: a unit or e2e test file mentions the ID (put IDs in test titles).
 * - "Built" and "Feels right" come from docs/feature-status.json, updated by build lanes
 *   ("built": "yes" | "partial") and by the lead after a feel review ("feel": true).
 * - Out of scope: rows the spec marks `Priority: OOS`, and rows the lead has ruled out
 *   ("scope": "out" with a note saying why). They are listed but left out of the totals.
 * - Warnings (printed, not fatal): an out-of-scope row that is also marked built or felt, or that a
 *   test names; a row ruled out with no note; a status entry whose ID matches no spec row.
 *
 * Usage: node scripts/features.mjs [specDir]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const specDir = process.argv[2] ?? process.env.ORBIT_SPEC_DIR ?? '/home/coder/orca/context/orbit/spec'
if (!existsSync(specDir)) {
  console.log(`Spec dir not found (${specDir}); FEATURES.md left unchanged.`)
  process.exit(0)
}

/** Spec files in reading order; anything else found is appended. */
const ORDER = [
  'sidebar.md',
  'tabs.md',
  'spaces.md',
  'commandbar.md',
  'split-view.md',
  'navigation.md',
  'peek.md',
  'mini-window.md',
  'media.md',
  'archive.md',
  'shortcuts.md',
  'feel.md',
  'appearance.md',
  'boosts.md',
  'extensions.md',
  'devtools.md',
  'downloads.md',
  'settings.md',
  'import.md',
  'onboarding.md',
  'updates.md',
  'easels-notes.md',
]
const ignore = (f) => f.startsWith('SOURCES') || f === 'FEATURES.md'
const found = readdirSync(specDir).filter((f) => f.endsWith('.md') && !ignore(f))
const files = [...ORDER.filter((f) => found.includes(f)), ...found.filter((f) => !ORDER.includes(f)).sort()]

/**
 * The spec's own product names stay in the spec; Orbit's checklist uses neutral names only (D57).
 * The name is spelled out, as in the clean-room test, so this file doesn't hold it.
 */
const NAME = ['A', 'r', 'c'].join('')
const neutral = (title) =>
  title
    .replace(new RegExp(`\\s*\\((?:${NAME}[^)]*|[^)]*\\b${NAME}\\b[^)]*)\\)`, 'g'), '')
    .replace(new RegExp(`\\s*\\[[^\\]]*\\b${NAME}\\b[^\\]]*\\]`, 'g'), '')
    .replace(new RegExp(`\\bfrom ${NAME}\\b`, 'g'), 'from a browser Orbit can’t read')
    .trim()

const sections = []
for (const file of files) {
  const text = readFileSync(join(specDir, file), 'utf8')
  const lines = text.split('\n')
  const heading = neutral(
    (lines.find((l) => l.startsWith('# ')) ?? file).replace(/^#\s+/, '').replace(/^Orbit spec:\s*/, ''),
  )
  const items = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^###\s+([A-Z]{2,3}-\d{2,3})\s+(.*)$/.exec(lines[i])
    if (!m) continue
    let priority = '?'
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
      const p = /^Priority:\s*(P\d|OOS)\b/.exec(lines[j])
      if (p) {
        priority = p[1]
        break
      }
    }
    items.push({ id: m[1], title: neutral(m[2]), priority })
  }
  if (items.length) sections.push({ file, heading, items })
}

/** Test files mentioning each ID. */
const tested = new Map()
const walk = (dir, kind) => {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, kind)
    else if (/\.(ts|tsx|mjs)$/.test(entry.name)) {
      for (const m of readFileSync(path, 'utf8').matchAll(/\b([A-Z]{2,3}-\d{2,3})\b/g)) {
        const kinds = tested.get(m[1]) ?? new Set()
        kinds.add(kind)
        tested.set(m[1], kinds)
      }
    }
  }
}
walk(join(root, 'tests/unit'), 'unit')
walk(join(root, 'tests/e2e'), 'e2e')

const statusFile = join(root, 'docs/feature-status.json')
const status = existsSync(statusFile) ? JSON.parse(readFileSync(statusFile, 'utf8')) : {}

const totals = { all: 0, built: 0, partial: 0, tested: 0, feel: 0, outOfScope: 0 }
/** Entries the checklist ignores or can't place; printed after writing, so they don't go unnoticed. */
const warnings = []
const byPriority = {}
const cell = (v) => v || '–'
const out = []
for (const s of sections) {
  out.push(`## ${s.heading}`, '', `Spec: \`spec/${s.file}\``, '')
  out.push('| ID | Feature | P | Built | Tested | Feels right | Notes |', '|---|---|---|---|---|---|---|')
  for (const it of s.items) {
    const st = status[it.id] ?? {}
    if (it.priority === 'OOS' || st.scope === 'out') {
      totals.outOfScope++
      const ignored = [
        st.built && `"built": "${st.built}"`,
        st.feel && '"feel"',
        tested.has(it.id) && 'a test naming it',
      ]
      for (const what of ignored.filter(Boolean)) warnings.push(`${it.id} is out of scope, so ${what} is ignored.`)
      if (it.priority !== 'OOS' && !st.note) warnings.push(`${it.id} is ruled out with no note saying why.`)
      const note = st.note ?? (it.priority === 'OOS' ? 'the spec leaves it out' : 'ruled out by the lead')
      out.push(`| ${it.id} | ${it.title} | ${it.priority} | ⛔ out of scope | – | – | ${note} |`)
      continue
    }
    const kinds = tested.get(it.id)
    const built = st.built === 'yes' ? '✅' : st.built === 'partial' ? '🟡 partial' : ''
    const test = kinds ? `✅ ${[...kinds].sort().join('+')}` : ''
    const feel = st.feel ? '✅' : ''
    totals.all++
    if (st.built === 'yes') totals.built++
    if (st.built === 'partial') totals.partial++
    if (kinds) totals.tested++
    if (st.feel) totals.feel++
    byPriority[it.priority] ??= { all: 0, built: 0, tested: 0 }
    const p = byPriority[it.priority]
    p.all++
    if (st.built === 'yes') p.built++
    if (kinds) p.tested++
    out.push(
      `| ${it.id} | ${it.title} | ${it.priority} | ${cell(built)} | ${cell(test)} | ${cell(feel)} | ${st.note ?? ''} |`,
    )
  }
  out.push('')
}

const specIds = new Set(sections.flatMap((s) => s.items.map((it) => it.id)))
for (const id of Object.keys(status)) {
  if (!specIds.has(id)) warnings.push(`docs/feature-status.json has ${id}, which matches no spec row.`)
}

const pending = ORDER.filter((f) => !found.includes(f))
const header = [
  '# Orbit feature checklist',
  '',
  '<!-- Generated by `node scripts/features.mjs` from the behaviour spec, the tests and docs/feature-status.json. Do not edit by hand. -->',
  '',
  'Every row is one behaviour from the clean-room spec. Status per ID: **spec’d** (every row) → **built** → **tested** (a unit or e2e test names the ID) → **feels right** (lead sign-off after a hands-on review against `feel.md`).',
  '',
  `**Totals:** ${totals.all} spec’d · ${totals.built} built (${totals.partial} partial) · ${totals.tested} tested · ${totals.feel} feel right. ${totals.outOfScope} more are out of scope and not counted.`,
  '',
  '| Priority | Spec’d | Built | Tested |',
  '|---|---|---|---|',
  ...Object.keys(byPriority)
    .sort()
    .map((k) => `| ${k} | ${byPriority[k].all} | ${byPriority[k].built} | ${byPriority[k].tested} |`),
  '',
  'P0 = milestone-1 core experience, P1 = parity, P2 = later.',
  '',
]
if (pending.length) {
  header.push(
    `Spec files still being written (rows appear when they land): ${pending.map((f) => `\`${f}\``).join(', ')}.`,
    '',
  )
}
writeFileSync(join(root, 'FEATURES.md'), `${[...header, ...out].join('\n').trimEnd()}\n`)
console.log(`FEATURES.md: ${totals.all} features from ${sections.length} spec files (${pending.length} pending).`)
for (const w of warnings) console.warn(`warning: ${w}`)
