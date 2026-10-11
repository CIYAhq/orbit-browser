import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { removeScratch, setScratchFolder, withDatabase, withScratch } from '../../src/main/import/copy'

/**
 * D58 (2): copies of another browser's files go in a folder under Orbit's user data. The ones being
 * read are closed and removed at quit; whatever a crash left is removed at startup.
 */

const home = mkdtempSync(join(tmpdir(), 'orbit-copy-test-'))
const folder = join(home, 'import-scratch')
afterAll(() => rmSync(home, { recursive: true, force: true }))

/** A small SQLite file standing in for another browser's History. */
function history(path: string): string {
  const db = new DatabaseSync(path)
  db.exec("CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT); INSERT INTO urls (url) VALUES ('https://example.com/')")
  db.close()
  return path
}

describe('[IM-14] scratch copies (D58)', () => {
  it('clears at startup what a crash left, and puts new copies under user data', async () => {
    mkdirSync(join(folder, 'read-left'), { recursive: true })
    writeFileSync(join(folder, 'read-left', '0-History'), 'a copy of another browser’s history')
    setScratchFolder(folder)
    const source = history(join(home, 'History'))
    const seen = await withScratch(async (scratch) => {
      await withDatabase(scratch, source, (db) => db.prepare('SELECT url FROM urls').get())
      return readdirSync(folder, { recursive: true })
    })
    expect(seen).toHaveLength(2)
    expect(seen.filter((f) => String(f).endsWith('0-History'))).toHaveLength(1)
    expect(seen.some((f) => String(f).includes('read-left'))).toBe(false)
    // Done: removed.
    expect(readdirSync(folder)).toEqual([])
  })

  it('at quit, closes the copy being read and removes it at once; the read fails at its next step', async () => {
    setScratchFolder(folder)
    const source = history(join(home, 'History-2'))
    let dir = ''
    let goneAtQuit = false
    const read = withScratch((scratch) => {
      dir = scratch.dir
      return withDatabase(scratch, source, (db) => {
        expect(db.prepare('SELECT url FROM urls').get()).toEqual({ url: 'https://example.com/' })
        removeScratch() // the will-quit handler
        goneAtQuit = !existsSync(dir)
        return db.prepare('SELECT url FROM urls').get()
      })
    })
    await expect(read).rejects.toThrow(/not open/)
    expect(goneAtQuit).toBe(true)
    expect(readdirSync(folder)).toEqual([])
  })
})
