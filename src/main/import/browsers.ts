import { access, open, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type {
  BookmarkNode,
  BrowserKind,
  ImportDataType,
  ImportSource,
  ProfileContents,
} from '../../shared/commands/import'
import { chromiumBookmarks, chromiumProfiles } from './chromium'
import { LockedError, type Scratch, withDatabase } from './copy'
import { firefoxProfiles, readFirefoxBookmarks } from './firefox'
import { countHistory, historySql } from './history'
import { countBookmarks } from './netscape'
import type { Place } from './places'
import { parseBplist, safariBookmarks } from './safari'

/** Each browser's name: on its tile, and in "Imported from <Browser>" (IM-05). */
export const BROWSER_NAMES: Record<BrowserKind, string> = {
  chrome: 'Chrome',
  chromium: 'Chromium',
  brave: 'Brave',
  edge: 'Edge',
  vivaldi: 'Vivaldi',
  opera: 'Opera',
  'opera-gx': 'Opera GX',
  firefox: 'Firefox',
  safari: 'Safari',
}

/** Safari's files need Full Disk Access on macOS; this is the way round it (IM-02). */
export const SAFARI_BLOCKED =
  'Needs Full Disk Access. Or export bookmarks from Safari (File → Export → Bookmarks) and import that file.'

/** A profile found on this computer. Its folder stays in the main process. */
export interface FoundProfile {
  id: string
  name: string
  dir: string
}

export interface FoundSource extends Omit<ImportSource, 'profiles'> {
  profiles: FoundProfile[]
}

/** What the import window may know of a source: no folders. */
export function publicSource({ profiles, ...source }: FoundSource): ImportSource {
  return { ...source, profiles: profiles.map(({ id, name }) => ({ id, name })) }
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

/** Whether a file opens for reading: false when it's missing, 'denied' without permission. */
async function readable(path: string): Promise<boolean | 'denied'> {
  try {
    await (await open(path, 'r')).close()
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'EPERM' || code === 'EACCES' ? 'denied' : false
  }
}

const hasChromiumData = async (dir: string) =>
  (await exists(join(dir, 'Bookmarks'))) || (await exists(join(dir, 'History')))

/** The browser at a place and its profiles, or undefined when nothing there can be read. */
async function findAt({ browser, dir }: Place): Promise<Omit<FoundSource, 'id' | 'name'> | undefined> {
  if (browser === 'firefox') {
    const ini = await readFile(join(dir, 'profiles.ini'), 'utf8').catch(() => undefined)
    if (ini === undefined) return undefined
    const profiles: FoundProfile[] = []
    for (const p of firefoxProfiles(ini)) {
      const at = p.relative || !isAbsolute(p.path) ? join(dir, p.path) : p.path
      if (await exists(join(at, 'places.sqlite'))) profiles.push({ id: p.path, name: p.name, dir: at })
    }
    return profiles.length > 0 ? { browser, profiles } : undefined
  }
  if (browser === 'safari') {
    const marks = await readable(join(dir, 'Bookmarks.plist'))
    const history = await readable(join(dir, 'History.db'))
    if (marks === 'denied' || history === 'denied') return { browser, profiles: [], blocked: SAFARI_BLOCKED }
    return marks || history ? { browser, profiles: [{ id: '.', name: 'Safari', dir }] } : undefined
  }
  // The Chromium family: `Local State` names the profiles. A browser without one has a single
  // profile, in "Default" or in its own folder (as Opera keeps it).
  const listed = chromiumProfiles(await readFile(join(dir, 'Local State'), 'utf8').catch(() => ''))
  const profiles: FoundProfile[] = []
  for (const p of listed) {
    const at = join(dir, p.folder)
    if (await hasChromiumData(at)) profiles.push({ id: p.folder, name: p.name, dir: at })
  }
  for (const folder of profiles.length > 0 ? [] : ['Default', '.']) {
    if (!(await hasChromiumData(join(dir, folder)))) continue
    profiles.push({ id: folder, name: 'Default', dir: join(dir, folder) })
    break
  }
  return profiles.length > 0 ? { browser, profiles } : undefined
}

/** The browsers installed at these places, with their profiles (IM-02). Places with nothing are left out. */
export async function findSources(places: readonly Place[]): Promise<FoundSource[]> {
  const out: FoundSource[] = []
  const seen = new Map<BrowserKind, number>()
  for (const place of places) {
    const found = await findAt(place).catch((err: unknown) => {
      console.warn(`[import] couldn’t look for ${BROWSER_NAMES[place.browser]}:`, (err as Error).message)
      return undefined
    })
    if (!found) continue
    const n = (seen.get(place.browser) ?? 0) + 1
    seen.set(place.browser, n)
    const name = BROWSER_NAMES[place.browser]
    out.push({
      id: n === 1 ? place.browser : `${place.browser}-${n}`,
      name: n === 1 ? name : `${name} (${n})`,
      ...found,
    })
  }
  return out
}

/** Reads types of a profile from one file: a held file marks them locked (IM-14); a broken one leaves them out. */
async function part(
  out: ProfileContents,
  source: FoundSource,
  types: ImportDataType[],
  read: () => Promise<unknown>,
): Promise<void> {
  try {
    await read()
  } catch (err) {
    if (err instanceof LockedError) out.locked.push(...types)
    else console.warn(`[import] couldn’t read ${source.name}’s ${types.join(' and ')}:`, (err as Error).message)
  }
}

/** One type read from a file that was copied: if it's broken, the file's other types are still read. */
async function quietly(source: FoundSource, type: ImportDataType, read: () => unknown): Promise<void> {
  try {
    await read()
  } catch (err) {
    console.warn(`[import] couldn’t read ${source.name}’s ${type}:`, (err as Error).message)
  }
}

/** What a profile holds (IM-03): each type read from copies; types it can't provide are left out. */
export async function inspectProfile(
  source: FoundSource,
  profile: FoundProfile,
  scratch: Scratch,
): Promise<ProfileContents> {
  const out: ProfileContents = { profileId: profile.id, name: profile.name, locked: [] }
  const setBookmarks = (tree: BookmarkNode[] | undefined) => {
    const count = tree ? countBookmarks(tree) : 0
    if (tree && count > 0) out.bookmarks = { count, tree }
  }
  const setHistory = (count: number) => {
    if (count > 0) out.history = { count }
  }
  const file = (name: string) => join(profile.dir, name)
  const history = historySql(source.browser)
  if (source.browser === 'firefox') {
    // Bookmarks and history share one file: one copy serves both.
    await part(out, source, ['bookmarks', 'history'], () =>
      withDatabase(scratch, file(history.file), async (db) => {
        await quietly(source, 'bookmarks', () => setBookmarks(readFirefoxBookmarks(db)))
        await quietly(source, 'history', async () => setHistory(await countHistory(db, history)))
      }),
    )
    return out
  }
  if (source.browser === 'safari') {
    await part(out, source, ['bookmarks'], async () => {
      const copy = await scratch.take(file('Bookmarks.plist'))
      if (copy) setBookmarks(safariBookmarks(parseBplist(await readFile(copy))))
    })
  } else {
    await part(out, source, ['bookmarks'], async () => {
      const copy = await scratch.take(file('Bookmarks'))
      if (copy) setBookmarks(chromiumBookmarks(await readFile(copy, 'utf8')))
    })
  }
  await part(out, source, ['history'], () =>
    withDatabase(scratch, file(history.file), async (db) => setHistory(await countHistory(db, history))),
  )
  return out
}
