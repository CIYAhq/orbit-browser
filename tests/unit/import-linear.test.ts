import { describe, expect, it } from 'vitest'
import { parseFile } from '../../src/main/import/files'
import { parseLinkList } from '../../src/shared/commands/import'

/**
 * D58 (1): a bookmarks file, a list of links or a pasted text may be hostile, so every scan of it is linear in its
 * size. Each shape below is read at two sizes, four times apart: the second may take at most twice that factor (8×)
 * the first's CPU time, where a scan that grows with the square of the size takes 16×. Small sizes keep the test
 * quick even when a scan isn't linear; the shapes and their effects are the import review's (M1).
 *
 * Timed in this thread's CPU time (D51): parsing never waits, so that is its whole cost. A round that misses a budget
 * is measured again, up to three rounds (D46).
 */

const HEAD = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<TITLE>Bookmarks</TITLE>\n<DL><p>\n'
const fill = (unit: string, bytes: number) => unit.repeat(Math.ceil(bytes / unit.length))

interface Shape {
  name: string
  read: (bytes: number) => unknown
}

const asFile = (name: string, text: (bytes: number) => string) => (bytes: number) => parseFile(name, text(bytes))

const SHAPES: Shape[] = [
  // The review's table.
  {
    name: 'links with </A> left out',
    read: asFile('bookmarks.htm', (b) => HEAD + fill('<DT><A HREF="https://example.com/page">A page\n', b)),
  },
  {
    name: 'folders with </H3> left out',
    read: asFile('bookmarks.htm', (b) =>
      fill('<DT><H3>A folder\n<DL><p>\n<DT><A HREF="https://example.com/">A page</A>\n</DL><p>\n', b),
    ),
  },
  { name: '"<a " with no ">"', read: asFile('bookmarks.htm', (b) => `${HEAD}<DT>${fill('<a ', b)}`) },
  {
    name: 'one title of "<"',
    read: asFile('bookmarks.htm', (b) => `${HEAD}<DT><A HREF="https://example.com/">${'<'.repeat(b)}</A>\n</DL>`),
  },
  { name: 'a .txt line of "]("', read: asFile('links.txt', (b) => `[${fill('](', b)}`) },
  { name: 'that line pasted (the sidebar)', read: (b) => parseLinkList(`[${fill('](', b)}`) },
  // Other patterns in the same scans.
  {
    name: 'a title of "&amp" with no ";"',
    read: asFile('bookmarks.htm', (b) => `${HEAD}<DT><A HREF="https://example.com/">${fill('&amp', b)}</A>`),
  },
  {
    name: 'an address whose quote never closes',
    read: asFile('bookmarks.htm', (b) => `${HEAD}<DT><A HREF="${'x'.repeat(b)}>A page</A>`),
  },
  { name: 'a .txt line of "<" with no ">"', read: asFile('links.txt', (b) => `<${'a'.repeat(b)}`) },
  { name: 'a .txt line of " - " separators', read: asFile('links.txt', (b) => fill('a - ', b)) },
  { name: 'a .txt line of dotted names', read: asFile('links.txt', (b) => `${fill('a.', b)}!`) },
  {
    name: 'a pasted line of "](" with a closing ")"',
    read: (b) => parseLinkList(`[${fill('](', b)})`),
  },
]

const SMALL = 64 * 1024
const LARGE = 4 * SMALL
/** The small size's budget, and the large size's: far above a linear scan, far below a quadratic one. */
const SMALL_MS = 50
const LARGE_MS = 100
/** CPU time moves in steps of a scheduler tick, so a tiny first time counts as this much. */
const FLOOR_MS = 2

const cpuUsage = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage : process.cpuUsage
const cpuMs = () => {
  const { user, system } = cpuUsage.call(process)
  return (user + system) / 1000
}

function timed(read: () => unknown): { cpu: number; wall: number } {
  const c0 = cpuMs()
  const t0 = performance.now()
  read()
  const t1 = performance.now()
  return { cpu: cpuMs() - c0, wall: t1 - t0 }
}

describe('[IM-13][IM-12] reading a hostile file or paste takes time in proportion to its size (D58)', () => {
  it.each(SHAPES)(
    '$name',
    ({ name, read }) => {
      read(1024) // warms the JIT
      let passed = false
      const rounds: string[] = []
      for (let round = 1; round <= 3 && !passed; round++) {
        const small = timed(() => read(SMALL))
        // A small size far over its budget fails the round without the large one (which would take 16× as long).
        const large = small.cpu <= SMALL_MS ? timed(() => read(LARGE)) : undefined
        passed =
          !!large && small.cpu <= SMALL_MS && large.cpu <= LARGE_MS && large.cpu <= 8 * Math.max(small.cpu, FLOOR_MS)
        rounds.push(
          `round ${round}: ${SMALL / 1024} KB ${small.cpu.toFixed(1)} ms CPU (wall ${small.wall.toFixed(1)}), ` +
            (large
              ? `${LARGE / 1024} KB ${large.cpu.toFixed(1)} ms CPU (wall ${large.wall.toFixed(1)}), ×${(large.cpu / Math.max(small.cpu, FLOOR_MS)).toFixed(1)}`
              : `${LARGE / 1024} KB not read`),
        )
      }
      console.info(`[import linear] ${name}: ${rounds.join('; ')}`)
      expect(passed, rounds.join('\n')).toBe(true)
    },
    120_000,
  )
})
