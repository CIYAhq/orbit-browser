import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

/**
 * A deleted profile's partition folder (PR-08): its cookies, logins, site data and cache on disk.
 * Its session may write there again until Orbit quits (or hold it, on Windows), so the folder is
 * removed at once as far as it can be, and again at the next launch; this file lists the folders
 * still to remove.
 */
const LIST = 'orbit-erase.json'

function listed(userData: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(userData, LIST), 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

function list(userData: string, dirs: string[]): void {
  const file = join(userData, LIST)
  if (dirs.length === 0) rmSync(file, { force: true })
  else writeFileSync(file, JSON.stringify(dirs))
}

/** Only a folder right inside `userData/Partitions` is ever removed. */
export function isPartitionDir(userData: string, dir: string): boolean {
  const rel = relative(join(userData, 'Partitions'), dir)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(sep)
}

/** Removes a deleted profile's partition folder now, and lists it to go again at the next launch. */
export async function erasePartition(userData: string, dir: string | null | undefined): Promise<void> {
  if (!dir || !isPartitionDir(userData, dir)) return
  list(userData, [...new Set([...listed(userData), dir])])
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

/** At launch, before any page loads: removes the listed folders; one that can't go yet stays listed. */
export function eraseLeftovers(userData: string): void {
  const before = listed(userData)
  if (before.length === 0) return
  const left = before.filter((dir) => {
    if (!isPartitionDir(userData, dir)) return false
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Held (Windows): the next launch tries again.
    }
    return existsSync(dir)
  })
  list(userData, left)
}
