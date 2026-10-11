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
  /** Types whose files are there but couldn't be read, with why ("the file is damaged", IM-14). */
  unreadable?: Partial<Record<ImportDataType, string>>
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
  /** `cut`: the file's bookmarks past the limit of one import, left out when it was read (IM-14). */
  | { kind: 'file'; name: string; bookmarks: BookmarkNode[]; cut?: number }
  /**
   * A pasted list of links (IM-12), or a .txt file's (`name`, IM-13): its text, or the id main holds a long one by
   * (`held`, D62 (5)).
   */
  | { kind: 'links'; folderName: string; text?: string; held?: string; name?: string }
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

/**
 * Things left out, with the reason (IM-14): `count` of them ("3 bookmarks: …"), or with no count, a
 * whole type of one profile ("Work: history couldn’t be read (the file is damaged)").
 */
export interface ImportSkip {
  what: string
  count?: number
  reason: string
}

/** A profile's type that couldn't be read, as the types step and the summary name it (IM-14). */
export function unreadableSkip(profile: string, type: ImportDataType, why: string): ImportSkip {
  return { what: profile, reason: `${type} couldn’t be read (${why})` }
}

/** A summary line as the import window shows it. */
export function skipText(s: ImportSkip): string {
  return s.count === undefined ? `${s.what}: ${s.reason}` : `${s.count.toLocaleString()} ${s.what}: ${s.reason}`
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

/** Files larger than this aren't bookmark files (IM-13); a pasted list is capped at it too (D62 (5)). */
export const MAX_FILE_BYTES = 64 * 1024 * 1024
/** What every route says of a file or a paste over `MAX_FILE_BYTES`, before reading it (F2, D62 (5)). */
export const TOO_LARGE = 'This is too large to import (the limit is 64 MB)'
/** A paste's name where the import window names a file. */
export const PASTED_LIST = 'Pasted list'
/** Why an import stopped part-way when Restore Data replaced the sidebar (D65 (3)): its window says so. */
export const STOPPED_BY_RESTORE = 'data was restored from a backup'

/**
 * A pasted list as UTF-8, to send to main; undefined when that's over MAX_FILE_BYTES. The windows count bytes, as main
 * does, and never encode past the cap (D62 (5), fix check 2 N3).
 */
export function listBytes(text: string): Uint8Array | undefined {
  // Every UTF-16 unit takes one to three bytes: a text this long can't fit, and this much room holds any that does.
  if (text.length > MAX_FILE_BYTES) return undefined
  const room = new Uint8Array(Math.min(MAX_FILE_BYTES, text.length * 3))
  // Stops when the room is full: a text that doesn't fit is never encoded whole.
  const { read, written } = new TextEncoder().encodeInto(text, room)
  if (read < text.length) return undefined
  // Exactly its bytes: a view of the larger buffer would carry all of it to main.
  return written === room.length ? room : room.slice(0, written)
}

/** A list of links longer than this (in characters, or lines) is never held as editable text (D62 (5)). */
export const LONG_LIST_CHARS = 1_000_000
export const LONG_LIST_LINES = 10_000

/** Whether a list of links is too long to edit (D62 (5)). Lines are counted only up to LONG_LIST_CHARS. */
export function isLongList(text: string): boolean {
  if (text.length > LONG_LIST_CHARS) return true
  let lines = 1
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) if (++lines > LONG_LIST_LINES) return true
  return false
}

/**
 * A list of links too long to edit (D62 (5)): main holds its text, which `import.start` takes by `id`; the import
 * window shows only its count and its first lines, read-only.
 */
export interface HeldLinks {
  id: string
  /** The links in it, counted once, in the reader (D58). */
  count: number
  /** Its first lines as written, each cut short. */
  preview: string[]
}

/**
 * A file dropped or chosen (IM-13), read in a worker (D58). A bookmarks file's tree comes as JSON text (`json`, a
 * `BookmarkNode[]`): main passes it on without reading it, so a big tree costs main's thread only a copy. `cut`: its
 * bookmarks past the limit of one import, left out (IM-14). A list of links comes as its text, or held in main when
 * it is too long to edit (`held`, D62 (5)).
 */
export type ParsedFile =
  | { kind: 'bookmarks'; name: string; json: string; count: number; cut: number }
  | { kind: 'links'; name: string; text: string; count: number }
  | { kind: 'links'; name: string; held: HeldLinks; count: number }
  | { kind: 'error'; name: string; message: string }

/** Where the import window starts (a dropped file, a paste in the sidebar: main holds a long one, D62 (5)). */
export type ImportStart =
  | { kind: 'links'; text: string }
  | { kind: 'links'; held: HeldLinks }
  | { kind: 'file'; file: ParsedFile }

/**
 * Where a browser window asks the import window to start: a file it read, or a pasted list as its UTF-8 bytes, which
 * main passes to the reader without making text of them (D62 (5)).
 */
export type ImportOpening = { kind: 'links'; bytes: Uint8Array } | { kind: 'file'; file: ParsedFile }

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
  'import.open': { args: { start?: ImportOpening }; result: void }
  /** The import window's starting point. */
  'import.session': { args: Record<string, never>; result: ImportSession }
  /** Browsers on this computer and their profiles (IM-02). */
  'import.sources': { args: Record<string, never>; result: ImportSource[] }
  /** What the chosen profiles hold: types, counts, bookmark trees (IM-03, IM-04). */
  'import.inspect': { args: { sourceId: string; profileIds: string[] }; result: Inspection }
  /** Reads a dropped file (IM-13): its bytes, as they are, which the reader takes (D58, D62 (5)). */
  'import.parseFile': { args: { name: string; bytes: Uint8Array }; result: ParsedFile }
  /** Takes a list of links too long to edit, pasted in the import window, as UTF-8: main holds it (D62 (5)). */
  'import.holdLinks': { args: { bytes: Uint8Array }; result: ParsedFile }
  /** The import window let a held list go (Clear): main does too (fix check 2 N5). */
  'import.letGo': { args: { id: string }; result: void }
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
  /** Accepts or declines a starter suggestion of a held import (IM-16); without a url, dismisses them all. */
  'import.suggest': { args: { jobId: string; url?: string; accepted: boolean }; result: void }
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

/** "[title](address)": the last "](" splits it, so a line is searched once, not once per "](" (D58). */
function markdownLink(line: string): { title: string; target: string } | undefined {
  if (!line.startsWith('[') || !line.endsWith(')')) return undefined
  const mid = line.lastIndexOf('](')
  if (mid < 1) return undefined
  const target = line.slice(mid + 2, -1)
  return target && !/\s/.test(target) ? { title: line.slice(1, mid), target } : undefined
}

function asUrl(text: string): string | undefined {
  const t = text.trim().replace(/^<(.+)>$/, '$1')
  if (SCHEME_URL.test(t)) return t
  if (BARE_URL.test(t)) return `https://${t}`
  return undefined
}

/**
 * A pasted list of links (IM-12): one URL per line, or "Title — URL" lines (an em or en dash, a
 * hyphen, a bar or a tab between), or Markdown links. Lines that aren't links are counted, not kept.
 * Linear in the text's size (D58): each line is read a fixed number of times. `upTo` stops once that many links
 * are found.
 */
export function parseLinkList(text: string, upTo = Number.POSITIVE_INFINITY): { links: ParsedLink[]; skipped: number } {
  const links: ParsedLink[] = []
  let skipped = 0
  for (const raw of text.split(/\r?\n/)) {
    if (links.length >= upTo) break
    const line = raw.trim().replace(/^[-*•]\s+/, '')
    if (!line) continue
    const md = markdownLink(line)
    const whole = asUrl(md ? md.target : line)
    if (whole) {
      links.push(md?.title ? { url: whole, title: md.title } : { url: whole })
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
