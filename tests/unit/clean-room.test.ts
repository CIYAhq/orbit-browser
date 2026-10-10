import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The clean-room rule (D57): Orbit's code, every string it shows, its tests and their fixtures, its
 * scripts and its feature checklist never name the browser the spec describes. The spec and the
 * clean-room notes in the docs may; this test reads `src/`, `tests/` (fixtures included), `scripts/`,
 * the feature status file and the generated checklist: every file's text and every file's and folder's
 * name. The name is spelled out here so this file doesn't hold it.
 */
const NAME = ['a', 'r', 'c'].join('')

/**
 * Lines where those letters stand as a word of their own and mean something else (a canvas drawing
 * call, say), each with why. Empty: nothing in the tree needs one yet.
 */
const ALLOWED: { file: RegExp; line: RegExp; why: string }[] = []

/**
 * A line's words, compared without case: split at anything but letters and digits, and at each hump of a camelCase
 * or PascalCase name (`fromXy`, `XyBar`). A backslash is read both ways: as a regular expression's escape, whose
 * letter isn't part of the next word (`\bxy\b`), and as a separator, whose next letter is (`C:\Users\Xy`).
 */
function words(line: string): string[] {
  const split = (text: string) =>
    text
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
  return [...split(line.replace(/\\[a-zA-Z]/g, ' ')), ...split(line.replace(/\\/g, ' '))]
}

const names = (line: string) => words(line).some((w) => w.toLowerCase() === NAME)

/**
 * Ordinary words that hold the letters, where a binary file holds them, each with why. In a binary file the letters
 * are looked for alone (`bare`), and a place where they stand inside one of these words is allowed: the word must be
 * there around them, so its letters' place in it is checked, not just the word somewhere on the line.
 */
const ORDINARY: { word: string; why: string }[] = [
  { word: 'search', why: 'the history fixtures hold search pages: their addresses and titles' },
  { word: 'varchar', why: "SQLite's column type LONGVARCHAR, in the history and places fixtures' schemas" },
]

/**
 * Whether a line of a binary file holds the letters alone, in any case, other than inside an ordinary word. A binary
 * file's text values can sit side by side with nothing between them (two of a SQLite row's columns, say), so the name
 * may be glued to another word, where `words` would read the pair as one (fix check 2 N6).
 */
function bare(line: string): boolean {
  const lower = line.toLowerCase()
  for (let at = lower.indexOf(NAME); at >= 0; at = lower.indexOf(NAME, at + 1)) {
    const ordinary = ORDINARY.some(({ word }) => {
      const start = at - word.indexOf(NAME)
      return start >= 0 && lower.slice(start, start + word.length) === word
    })
    if (!ordinary) return true
  }
  return false
}

/** Every file and folder under `dir`, binary files included (a fixture's SQLite or plist file holds text too). */
function entriesUnder(dir: string): { path: string; folder: boolean }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? [{ path, folder: true }, ...entriesUnder(path)] : [{ path, folder: false }]
  })
}

/**
 * A file's text, every way it may hold it: as latin1, where any byte reads as a character, so a binary file's text is
 * seen as it is; and as UTF-16 (a Windows export, say) when it starts with a byte-order mark or an eighth of its bytes
 * are NULs, in both byte orders.
 */
function textsOf(bytes: Buffer): { how: string; text: string }[] {
  const texts = [{ how: '', text: bytes.toString('latin1') }]
  let nuls = 0
  for (const b of bytes) if (b === 0) nuls++
  const marked = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)
  if (marked || nuls * 8 > bytes.length) {
    texts.push({ how: ' (UTF-16)', text: bytes.toString('utf16le') })
    // Big-endian: each pair of bytes swapped (a last odd byte left out).
    const swapped = Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2))).swap16()
    texts.push({ how: ' (UTF-16)', text: swapped.toString('utf16le') })
  }
  return texts
}

/**
 * Each file or folder whose name names it, and each line that does and isn't allowed, as `file:line`. In a binary file
 * (one holding a NUL byte), a line that holds the letters alone outside an ordinary word does too.
 */
function namings(entries: { path: string; folder: boolean }[]): string[] {
  return entries.flatMap(({ path, folder }) => {
    const found = names(basename(path)) ? [`${path} (its name)`] : []
    if (folder) return found
    const bytes = readFileSync(path)
    const binary = bytes.includes(0)
    for (const { how, text } of textsOf(bytes)) {
      text.split(/\r?\n|\r/).forEach((line, i) => {
        if (names(line) && !ALLOWED.some((a) => a.file.test(path) && a.line.test(line)))
          found.push(`${path}:${i + 1}${how}`)
        else if (binary && bare(line)) found.push(`${path}:${i + 1}${how}`)
      })
    }
    return [...new Set(found)]
  })
}

describe('clean room', () => {
  it("names no other browser's product in Orbit's code, tests, fixtures, scripts or feature checklist (D57)", () => {
    const entries = [
      ...entriesUnder('src'),
      ...entriesUnder('tests'),
      ...entriesUnder('scripts'),
      { path: 'docs/feature-status.json', folder: false },
      { path: 'FEATURES.md', folder: false },
    ]
    expect(entries.length).toBeGreaterThan(100)
    expect(namings(entries)).toEqual([])
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

  it('finds it after a backslash, in UTF-16 text, and as a file’s or a folder’s name (fix check N6)', () => {
    const cap = `${NAME.charAt(0).toUpperCase()}${NAME.slice(1)}`
    // A Windows path in a .txt, the same path in a string (backslashes doubled) and in a regular expression, and the
    // name in lower case right after an escape.
    for (const line of [
      `C:\\Users\\me\\${cap}\\User Data`,
      `'C:\\\\Users\\\\me\\\\${cap}\\\\User Data'`,
      `/C:\\\\Users\\\\[^\\\\]+\\\\${cap}\\\\User Data/`,
      `/\\b${NAME}\\b/`,
      `\\${NAME}`,
    ]) {
      expect(names(line), line).toBe(true)
    }
    for (const line of ['C:\\Users\\me\\Archive', '/\\barchive\\b/', '"\\narcs"', '\\search']) {
      expect(names(line), line).toBe(false)
    }
    // UTF-16, as a Windows export would be: with a byte-order mark, either way round, or with none.
    const le = Buffer.from(`Exported from\r\n${cap}’s menu`, 'utf16le')
    const be = Buffer.from(le).swap16()
    for (const bytes of [
      Buffer.concat([Buffer.from([0xff, 0xfe]), le]),
      Buffer.concat([Buffer.from([0xfe, 0xff]), be]),
      le,
    ]) {
      expect(textsOf(bytes).some(({ text }) => text.split(/\r?\n/).some(names))).toBe(true)
    }
    expect(textsOf(Buffer.from('Exported from Archive’s menu', 'utf16le')).some(({ text }) => names(text))).toBe(false)
    // Files and folders named so, holding nothing that names it.
    const dir = mkdtempSync(join(tmpdir(), 'orbit-clean-room-'))
    try {
      mkdirSync(join(dir, cap))
      writeFileSync(join(dir, cap, 'notes.txt'), 'clean')
      writeFileSync(join(dir, `${NAME}-notes.txt`), 'clean')
      writeFileSync(join(dir, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), le]))
      expect(namings(entriesUnder(dir)).map((found) => found.slice(dir.length + 1))).toEqual([
        `${cap} (its name)`,
        `${NAME}-notes.txt (its name)`,
        'utf16.txt:2 (UTF-16)',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('finds it glued to another word in a binary file, in any case; not inside an ordinary word (fix check 2 N6)', () => {
    const cap = `${NAME.charAt(0).toUpperCase()}${NAME.slice(1)}`
    // As a SQLite row holds its text values: side by side, a record header before them.
    const row = (...values: string[]) => Buffer.concat([Buffer.from([0, 0, 0x03, 0x17]), Buffer.from(values.join(''))])
    const dir = mkdtempSync(join(tmpdir(), 'orbit-clean-room-'))
    try {
      const probes: Record<string, Buffer> = {
        // Each read by words as one longer word, which isn't the name: only the bare letters find them.
        'glued.db': row('Morning news', `${NAME}spaces`),
        'address.db': row('https://example.com/x', NAME),
        'start.db': row(`${cap}sidebar`, 'Notes'),
        'upper.db': row(`LONG${NAME.toUpperCase()}TEXT`),
        'utf16.db': Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from(`Notes${NAME}`, 'utf16le')]),
        // The ordinary words, the letters where each holds them: allowed.
        'ordinary.db': row('LONGVARCHAR', 'Search', 'Searchmoc', 'research', 'searchvarchar'),
        // A text file (no NUL byte) is read by words, as code is: a longer word isn't the name.
        'text.txt': Buffer.from(`const archived = research(${NAME}s)\n`),
      }
      for (const [name, bytes] of Object.entries(probes)) writeFileSync(join(dir, name), bytes)
      expect(
        namings(entriesUnder(dir))
          .map((found) => found.slice(dir.length + 1))
          .sort(),
      ).toEqual(['address.db:1', 'glued.db:1', 'start.db:1', 'upper.db:1', 'utf16.db:1 (UTF-16)'])
      // A word that only starts like an ordinary one is no cover: the letters must stand where that word holds them.
      for (const line of [`se${NAME}`, `v${NAME}`, `${NAME}har`, `x${NAME}h`]) expect(bare(line), line).toBe(true)
      for (const line of ['search', 'LONGVARCHAR', 'Searchmoc']) expect(bare(line), line).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
