import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The clean-room rule (D57): Orbit's code, every string it shows, its tests and their fixtures, its
 * scripts and its feature checklist never name the browser the spec describes. The spec and the
 * clean-room notes in the docs may; this test reads `src/`, `tests/` (fixtures included), `scripts/`,
 * the feature status file and the generated checklist. The name is spelled out here so this file
 * doesn't hold it.
 */
const NAME = ['a', 'r', 'c'].join('')

/**
 * Lines where those letters stand as a word of their own and mean something else (a canvas drawing
 * call, say), each with why. Empty: nothing in the tree needs one yet.
 */
const ALLOWED: { file: RegExp; line: RegExp; why: string }[] = []

/**
 * A line's words, compared without case: split at anything but letters and digits, at a regular
 * expression's escapes (`\b`), and at each hump of a camelCase or PascalCase name (`fromXy`, `XyBar`).
 */
function words(line: string): string[] {
  return line
    .replace(/\\[a-zA-Z]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
}

const names = (line: string) => words(line).some((w) => w.toLowerCase() === NAME)

/** Every file under `dir`, binary ones included (a fixture's SQLite or plist file holds text too). */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  })
}

/** Each line that names it and isn't allowed, as `file:line`. */
function namings(files: string[]): string[] {
  return files.flatMap((file) =>
    // latin1: any byte reads as a character, so a binary file's text is seen as it is.
    readFileSync(file, 'latin1')
      .split(/\r?\n|\r/)
      .flatMap((line, i) =>
        names(line) && !ALLOWED.some((a) => a.file.test(file) && a.line.test(line)) ? [`${file}:${i + 1}`] : [],
      ),
  )
}

describe('clean room', () => {
  it("names no other browser's product in Orbit's code, tests, fixtures, scripts or feature checklist (D57)", () => {
    const files = [
      ...filesUnder('src'),
      ...filesUnder('tests'),
      ...filesUnder('scripts'),
      'docs/feature-status.json',
      'FEATURES.md',
    ]
    expect(files.length).toBeGreaterThan(100)
    expect(namings(files)).toEqual([])
  })

  it('finds a naming in any case, in a name or a pattern; not in a longer word', () => {
    // Guards the test itself: a pattern that matched nothing would pass any tree.
    const cap = `${NAME.charAt(0).toUpperCase()}${NAME.slice(1)}`
    const upper = NAME.toUpperCase()
    for (const line of [
      `from ${cap}’s menu`,
      `THE ${upper} SIDEBAR`,
      `const from${cap} = 1`,
      `class ${cap}Sidebar {}`,
      `const ${NAME}Spaces = []`,
      `/\\b${cap}\\b/`,
      `${upper}_STATE`,
      `XML${cap}`,
    ]) {
      expect(names(line), line).toBe(true)
    }
    for (const line of ['Archive, search, arcs', 'ARCHIVE', 'Marc and Darcy', 'searchResult', 'archived_at']) {
      expect(names(line), line).toBe(false)
    }
  })
})
