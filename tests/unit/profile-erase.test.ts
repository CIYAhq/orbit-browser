import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { eraseLeftovers, erasePartition, isPartitionDir } from '../../src/main/spaces/erase'

/** A deleted profile's folder on disk (PR-08). */

function userData() {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-erase-'))
  const part = join(dir, 'Partitions', 'orbit-p-work')
  mkdirSync(part, { recursive: true })
  writeFileSync(join(part, 'Cookies'), 'kept')
  return { dir, part }
}

describe('a deleted profile’s partition folder (PR-08)', () => {
  it('[PR-08] goes at once, and again at the next launch when its session wrote to it before Orbit quit', async () => {
    const { dir, part } = userData()
    await erasePartition(dir, part)
    expect(existsSync(part)).toBe(false)
    // The session writes its folder again as Orbit quits.
    mkdirSync(part, { recursive: true })
    writeFileSync(join(part, 'Cookies'), 'again')
    eraseLeftovers(dir)
    expect(existsSync(part)).toBe(false)
    // Nothing is left to do at the launch after.
    expect(existsSync(join(dir, 'orbit-erase.json'))).toBe(false)
    eraseLeftovers(dir)
  })

  it('[PR-08] never removes anything but a folder right inside Partitions, whatever the list says', async () => {
    const { dir, part } = userData()
    for (const p of [
      dir,
      join(dir, 'Partitions'),
      join(dir, 'history'),
      join(part, 'Local Storage'),
      join(dir, '..', 'Partitions', 'orbit-p-work'),
    ]) {
      expect(isPartitionDir(dir, p), p).toBe(false)
    }
    expect(isPartitionDir(dir, part)).toBe(true)
    mkdirSync(join(dir, 'history'))
    await erasePartition(dir, join(dir, 'history'))
    await erasePartition(dir, null)
    expect(existsSync(join(dir, 'history'))).toBe(true)
    // A list edited by hand.
    writeFileSync(join(dir, 'orbit-erase.json'), JSON.stringify([join(dir, 'history'), 42]))
    eraseLeftovers(dir)
    expect(existsSync(join(dir, 'history'))).toBe(true)
    expect(existsSync(part)).toBe(true)
  })
})
