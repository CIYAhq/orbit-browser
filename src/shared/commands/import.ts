import type { ActionDef } from '../actions'
import type { FolderId, ProfileId, SpaceId } from '../state'

/**
 * Import (IM-*): bookmarks, history, extensions and cookies from other browsers on this computer,
 * from standard files, and from link lists the user pastes. Owned by the import lane.
 */

/** Browsers Orbit can read (IM-02). */
export type BrowserKind =
  | 'chrome'
  | 'chromium'
  | 'brave'
  | 'edge'
  | 'vivaldi'
  | 'opera'
  | 'opera-gx'
  | 'firefox'
  | 'safari'

/** What can come over from a browser (IM-03). Never passwords or cards (D52). */
export type ImportDataType = 'bookmarks' | 'history' | 'extensions' | 'cookies'

/** A bookmark (with `url`) or a folder (with `children`) read from a browser or a file. */
export interface BookmarkNode {
  /** Unique within its tree. */
  id: string
  title: string
  url?: string
  children?: BookmarkNode[]
  /** Why this bookmark can't become a pinned tab (a bookmarklet, a browser's own page…). */
  skip?: string
}

/** A browser profile on this computer, as the browser names it. */
export interface SourceProfile {
  id: string
  name: string
}

/** A browser found on this computer (IM-02). */
export interface ImportSource {
  id: string
  browser: BrowserKind
  name: string
  profiles: SourceProfile[]
  /** Set when Orbit may not read it (Safari without Full Disk Access): what to do instead. */
  blocked?: string
}

/** An extension installed in a source profile (IM-09). */
export interface SourceExtension {
  id: string
  name: string
  pinned: boolean
  /** Installed from the browser's store (unpacked and policy-installed ones are not). */
  fromStore: boolean
  /** An ad or content blocker (IM-09's de-duplication). */
  blocker: boolean
}

/** What one source profile holds (IM-03). A type it can't provide is left out. */
export interface ProfileContents {
  profileId: string
  name: string
  bookmarks?: { count: number; tree: BookmarkNode[] }
  history?: { count: number }
  extensions?: { items: SourceExtension[] }
  cookies?: { count: number; unavailable?: string }
  /** Types whose files couldn't be copied because the browser holds them (IM-14). */
  locked: ImportDataType[]
}

export interface Inspection {
  sourceId: string
  browser: BrowserKind
  name: string
  profiles: ProfileContents[]
}

/** Where imported things go (IM-06): bookmarks to a Space's pinned section, the rest to its profile. */
export type ImportTarget =
  | { kind: 'space'; spaceId: SpaceId }
  | { kind: 'new-space'; name: string; profileId: ProfileId }
  /** A new Orbit profile and Space for each source profile, named after it. */
  | { kind: 'matching' }

export type ImportPlan = (
  | {
      kind: 'browser'
      sourceId: string
      profiles: { profileId: string; types: ImportDataType[]; bookmarks?: BookmarkNode[] }[]
    }
  | { kind: 'file'; name: string; bookmarks: BookmarkNode[] }
  /** A pasted list of links (IM-12), or a .txt file's (`name`, IM-13). */
  | { kind: 'links'; folderName: string; text: string; name?: string }
) & {
  target: ImportTarget
  /** Onboarding: read now, add when onboarding finishes (Skip setup imports nothing, OB-14). */
  hold?: boolean
}

/** One line of the progress view (IM-14). */
export interface ImportProgressItem {
  type: ImportDataType | 'links'
  state: 'waiting' | 'running' | 'done' | 'skipped' | 'failed'
  done: number
  total?: number
  note?: string
}

/** Things left out, with the reason (IM-14). */
export interface ImportSkip {
  what: string
  count: number
  reason: string
}

/** A site proposed as a Favorite or pinned tab from imported history (IM-16). */
export interface StarterSuggestion {
  url: string
  title: string
  kind: 'favorite' | 'pinned'
  accepted: boolean
}

export interface ImportJob {
  id: string
  /** Reading (Cancel imports nothing), held (onboarding), adding, then an end. */
  phase: 'reading' | 'held' | 'adding' | 'done' | 'failed' | 'cancelled'
  /** "Google Chrome", a file's name, "Pasted links". */
  source: string
  items: ImportProgressItem[]
  skipped: ImportSkip[]
  /** The folders made (Done shows the first). */
  folders: { folderId: FolderId; spaceId: SpaceId }[]
  /** Files the source browser held (IM-14): quit it and try again. */
  locked?: { browser: string; types: ImportDataType[] }
  error?: string
  /** How long it took and the main thread's longest stall while it ran, in ms. */
  stats?: { ms: number; longestTaskMs: number }
  suggestions?: StarterSuggestion[]
}

/** A file dropped or chosen (IM-13), read. */
export type ParsedFile =
  | { kind: 'bookmarks'; name: string; tree: BookmarkNode[]; count: number }
  | { kind: 'links'; name: string; text: string; count: number }
  | { kind: 'error'; name: string; message: string }

/** Where the import window starts (a dropped file, a paste in the sidebar). */
export type ImportStart = { kind: 'links'; text: string } | { kind: 'file'; file: ParsedFile }

/** What the import window shows when it opens or is asked again (`import.session`). */
export interface ImportSession {
  start?: ImportStart
  /** The browser window's Space and profile: the default target (IM-06). */
  spaceId?: SpaceId
  profileId?: ProfileId
  job: ImportJob | null
  nonce: number
}

export interface ImportCommands {
  /** Opens the import window for the calling browser window (IM-01), optionally at a route. */
  'import.open': { args: { start?: ImportStart }; result: void }
  /** The import window's starting point. */
  'import.session': { args: Record<string, never>; result: ImportSession }
  /** Browsers on this computer and their profiles (IM-02). */
  'import.sources': { args: Record<string, never>; result: ImportSource[] }
  /** What the chosen profiles hold: types, counts, bookmark trees (IM-03, IM-04). */
  'import.inspect': { args: { sourceId: string; profileIds: string[] }; result: Inspection }
  /** Reads a dropped file (IM-13). */
  'import.parseFile': { args: { name: string; text: string }; result: ParsedFile }
  /** "From a file…": the system's file picker, then the file read. Null when cancelled. */
  'import.chooseFile': { args: Record<string, never>; result: ParsedFile | null }
  /** Starts an import; returns its id. */
  'import.start': { args: { plan: ImportPlan }; result: string }
  /** The import running or last finished (or `jobId`'s). */
  'import.status': { args: { jobId?: string }; result: ImportJob | null }
  /** Stops an import that hasn't added anything yet, or drops a held one. */
  'import.cancel': { args: { jobId: string }; result: void }
  /** Adds a held import (onboarding's Start browsing). */
  'import.commit': { args: { jobId: string }; result: void }
  /** Done: shows the imported folder in the browser window (IM-14). */
  'import.reveal': { args: { jobId: string }; result: void }
  'import.close': { args: Record<string, never>; result: void }
  /** Accepts or declines a starter suggestion of a held import (IM-16). */
  'import.suggest': { args: { jobId: string; url: string; accepted: boolean }; result: void }
  /** Writes pinned items as a bookmarks file (IM-17). Returns the path, or null when cancelled. */
  'import.exportPinned': { args: { profileId?: ProfileId; includeToday?: boolean }; result: string | null }
}

/** Import actions for the app menu and the command bar (IM-01, IM-17). */
export const IMPORT_ACTIONS: ActionDef[] = [
  {
    id: 'app.import',
    title: 'Import from Another Browser',
    category: 'App',
    keywords: ['import', 'bookmarks', 'history', 'chrome', 'firefox', 'safari', 'edge', 'brave', 'paste links'],
  },
  {
    id: 'app.exportPinned',
    title: 'Export Pinned Items as Bookmarks',
    category: 'App',
    keywords: ['export', 'bookmarks', 'html', 'backup', 'pinned tabs'],
  },
]

export interface ParsedLink {
  url: string
  title?: string
}

const TITLE_SEPARATORS = [' — ', ' – ', ' - ', '\t', ' | ']
const SCHEME_URL = /^https?:\/\/[^\s/$.?#][^\s]*$/i
const BARE_URL = /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?(?:[/?#][^\s]*)?$/i

function asUrl(text: string): string | undefined {
  const t = text.trim().replace(/^<(.+)>$/, '$1')
  if (SCHEME_URL.test(t)) return t
  if (BARE_URL.test(t)) return `https://${t}`
  return undefined
}

/**
 * A pasted list of links (IM-12): one URL per line, or "Title — URL" lines (an em or en dash, a
 * hyphen, a bar or a tab between), or Markdown links. Lines that aren't links are counted, not kept.
 */
export function parseLinkList(text: string): { links: ParsedLink[]; skipped: number } {
  const links: ParsedLink[] = []
  let skipped = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*•]\s+/, '')
    if (!line) continue
    const md = /^\[(.*)\]\((\S+)\)$/.exec(line)
    const whole = md ? asUrl(md[2] as string) : asUrl(line)
    if (whole) {
      links.push(md?.[1] ? { url: whole, title: md[1] } : { url: whole })
      continue
    }
    let found: ParsedLink | undefined
    for (const sep of TITLE_SEPARATORS) {
      const i = line.lastIndexOf(sep)
      if (i <= 0) continue
      const url = asUrl(line.slice(i + sep.length))
      const title = line.slice(0, i).trim()
      if (url) {
        found = title ? { url, title } : { url }
        break
      }
    }
    if (found) links.push(found)
    else skipped++
  }
  return { links, skipped }
}
