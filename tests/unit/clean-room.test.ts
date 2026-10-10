import { readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The clean-room rule (D57): Orbit's code, every string it shows and its feature checklist never name
 * the browser the spec describes. The spec and the clean-room notes in the docs may; this test reads
 * only `src/` and the generated checklist. The name is spelled out here so this file doesn't hold it.
 */
const NAME = new RegExp(`\\b${['A', 'r', 'c'].join('')}\\b`)

const TEXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.html', '.css', '.json', '.md', '.svg', '.txt'])

function textFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return textFilesUnder(path)
    return TEXT.has(extname(entry.name)) ? [path] : []
  })
}

/** Each line that names it, as `file:line`. */
function namings(files: string[]): string[] {
  return files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) => (NAME.test(line) ? [`${file}:${i + 1}`] : [])),
  )
}

describe('clean room', () => {
  it("names no other browser's product in Orbit's code, UI strings or feature checklist (D57)", () => {
    expect(namings([...textFilesUnder('src'), 'FEATURES.md'])).toEqual([])
  })

  it('finds a naming when there is one', () => {
    // Guards the test itself: a pattern that matched nothing would pass any tree.
    expect(NAME.test(`from ${['A', 'r', 'c'].join('')}’s menu`)).toBe(true)
    expect(NAME.test('Archive, search, arcs')).toBe(false)
  })
})
