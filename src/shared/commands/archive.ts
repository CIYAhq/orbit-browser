import type { ArchivedTab, ProfileId, SpaceId, TabId } from '../state'
import type { HistoryVisit } from './history'

/**
 * Which archived pages a list shows (AR-03): everything, tabs that left the sidebar, or pages
 * closed in a Mini Window.
 */
export type ArchiveSource = 'all' | 'sidebar' | 'mini'

/** How the tabs left (DL-09): any way, closed or cleared by the user, or archived automatically. */
export type ArchiveClosedBy = 'any' | 'manual' | 'auto'

/** One Archive row as the Library lists it (AR-03). */
export interface ArchiveRow {
  id: string
  url: string
  title: string
  /** The remembered icon of the page's site (a small data URL), when there is one. */
  favicon?: string
  spaceId: SpaceId
  /** Name of the Space at archive time (shown when that Space is gone). */
  spaceName?: string
  archivedAt: number
  reason: ArchivedTab['reason']
  section?: ArchivedTab['section']
  from?: ArchivedTab['from']
  /** The tab's back/forward history is kept: a restore brings it back (AR-01). */
  hasHistory?: boolean
}

export interface ArchiveQuery {
  /** Title or URL words, case-insensitive; every word must match (AR-04). */
  text?: string
  spaceId?: SpaceId
  source?: ArchiveSource
  closedBy?: ArchiveClosedBy
  /** Defaults to the profile of the calling window's current Space (PR-05). */
  profileId?: ProfileId
  /** Rows to skip (newest first) and how many to return (default 100, at most 500). */
  offset?: number
  limit?: number
}

/** A page of matching entries, newest first, with the day groups of the whole match. */
export interface ArchivePage {
  profileId: ProfileId
  /** Changes whenever the Archive changes; pages of the same version line up. */
  version: number
  /** All matching entries. */
  total: number
  /** Matching entries per local day, newest day first: [start of the day (ms), count]. */
  days: [number, number][]
  offset: number
  rows: ArchiveRow[]
}

export interface ArchiveRestoreResult {
  /** Entries restored, in the order given (entries restored already or deleted are left out). */
  ids: string[]
  /** The tabs put back into the sidebar, in the same order. */
  tabIds: TabId[]
  /** The Space each went to, in the same order. */
  spaceIds: SpaceId[]
}

export interface ArchiveRestoreArgs {
  id?: string
  ids?: string[]
  /** Also select the (first) tab in the calling window, switching to its Space when needed… */
  open?: boolean
  /** …unless `stay`: then only when it lands in the current Space; else a toast offers to go there (CB-19). */
  stay?: boolean
  /** Into the calling window's current Space instead of the Space each came from (the command bar, CB-19). */
  here?: boolean
}

/** Why the Library opens: the shortcut, menu or command bar route (AR-02, AR-07, AR-10). */
export interface LibraryOpenArgs {
  /** Section to show; default: the one used last (AR-02, DL-09). */
  section?: string
  /** Ask to clear the Archive as soon as it shows (AR-07 from the menu or the command bar). */
  confirmClear?: boolean
}

/** What the Library shows; sent to its view on each open (`library:show`) and returned by `library.status`. */
export interface LibraryShow {
  section: string
  /** Changes with every open, so the view can tell a new open from a repeated message. */
  nonce: number
  /** Ask to clear the Archive right away (AR-07 from the menu or the command bar). */
  confirmClear?: boolean
  /** The Library was closed before this open: play the entrance (FL-24). */
  entering?: boolean
}

/** Which visits the Library's History section asks for (AR-10): the `history.visits` query. */
export interface LibraryHistoryQuery {
  /** Default: the profile of the calling window's Space. */
  profileId?: ProfileId
  /** Words that must all be in the title or the address. */
  text?: string
  /** Visits before this time (ms), for the next page. */
  before?: number
  /** At most this many (1–500, default 100). */
  limit?: number
}

/** A sidebar backup (AR-11), newest first in lists. */
export interface BackupInfo {
  id: string
  /** When it was taken (ms). */
  at: number
  /** How many Spaces and tabs it holds. */
  spaces: number
  tabs: number
}

/** What Restore Data did (AR-11). */
export interface BackupRestoreResult {
  /** The sidebar is back as the backup has it. */
  restored: boolean
  /**
   * Why nothing changed: there is no such backup or it can't be read (`unreadable`), or the sidebar
   * as it is couldn't be backed up first (`backup-failed`).
   */
  reason?: 'unreadable' | 'backup-failed'
  /**
   * The restore's step on the sidebar's undo stack (⌘Z takes it back), for the toast's Undo
   * (`backups.undoRestore`). None when the restore changed nothing.
   */
  undoStep?: number
  /** Tabs that came back, and tabs that went to the Archive. */
  added?: number
  archived?: number
}

/**
 * What the restore toast's Undo did: took the restore back (`undone`), or left it because changes
 * were made since (`later`) or it was undone already (`gone`).
 */
export type BackupUndoResult = 'undone' | 'later' | 'gone'

/** Owned by the archive lane: the Archive, the Library container, history view and backups. */
export interface ArchiveCommands {
  /** Archived tabs of one profile, filtered, newest first, a page at a time (AR-03, AR-04). */
  'archive.query': { args: ArchiveQuery; result: ArchivePage }
  /**
   * Puts archived tabs back at the top of Today in the Space they came from (a link-routing rule
   * wins; the current Space when theirs is gone), with their history when the profile still
   * matches (AR-05, PR-05). Entries already restored are skipped, so repeated clicks never restore twice.
   */
  'archive.restore': { args: ArchiveRestoreArgs; result: ArchiveRestoreResult }
  /**
   * Previews an entry without restoring it (AR-06): its page opens in a Peek over the calling
   * window's Library (`peek: true`), or in a new tab when there is no tab to preview over. The entry
   * stays archived. Null when the entry is gone or of another profile than the window's Space.
   */
  'archive.preview': { args: { id: string }; result: { tabId: TabId; peek: boolean } | null }
  /** Restores the entry the calling window's Peek previews and closes the Peek (AR-06). */
  'archive.restorePreview': { args: Record<string, never>; result: ArchiveRestoreResult }
  /** Removes entries without restoring them (AR-07, row menu). Returns how many went. */
  'archive.delete': { args: { ids: string[] }; result: number }
  /**
   * Removes every entry of a profile (default: the calling window's) (AR-07); browsing history
   * stays. The Library asks first (`confirmClear`). Returns how many went.
   */
  'archive.clear': { args: { profileId?: ProfileId }; result: number }
  /** How many days Archive entries are kept (AR-08): 30, 90, 365, or 0 for forever. */
  'archive.setKeepDays': { args: { days: number }; result: void }
  /**
   * Shows the row's context menu (Restore, Open in New Tab, Copy URL, Delete) at a point of the
   * Library. With no ids, the Archive section's own menu (Clear Archive…, Keep Archived Tabs For).
   */
  'archive.contextMenu': { args: { ids: string[]; x: number; y: number }; result: void }
  /**
   * Test-only (ORBIT_E2E=1): the labels of the last Archive menu; `click` runs an item ("Delete").
   * With `appMenu`, the labels in the app menu's File > Recently Closed (none without an app menu).
   */
  'archive.testMenu': { args: { click?: string; appMenu?: boolean }; result: string[] }
  /** Test-only (ORBIT_E2E=1): adds `count` entries spread over `days` days for one profile. */
  'archive.testSeed': {
    args: { count: number; days?: number; profileId?: ProfileId; spaceId?: SpaceId; prefix?: string }
    result: number
  }

  /** Opens the Library in the calling window (AR-02, DL-09). */
  'library.open': { args: LibraryOpenArgs; result: void }
  /** Closes the Library (Esc, ⌘W, the Library button again). */
  'library.close': { args: Record<string, never>; result: void }
  /** The Library button: opens or closes it (SB-09). */
  'library.toggle': { args: Record<string, never>; result: void }
  /** Loads the calling window's Library view ahead of an open (the pointer is on the Library button). */
  'library.prepare': { args: Record<string, never>; result: void }
  /** Is the Library open in the calling window, and what it shows (a view that loads late asks this). */
  'library.status': { args: Record<string, never>; result: LibraryShow & { open: boolean } }
  /** Remembers the section shown, so the Library reopens there (AR-02). */
  'library.setSection': { args: { section: string }; result: void }
  /**
   * Shows the Recently Closed list (AR-09) as a menu at a point of the Library view (under its
   * button); choosing an entry reopens that tab.
   */
  'archive.recentlyClosedMenu': { args: { x?: number; y?: number }; result: void }
  /**
   * Browsing history for the Library's History section (AR-10): the history store's visits, newest
   * first (one row per visit), each with its site's remembered icon when there is one.
   */
  'library.history': { args: LibraryHistoryQuery; result: HistoryVisit[] }
  /**
   * Shows a History row's menu (Open in New Tab, Open in Background, Copy Link, Remove from
   * History). Removing tells the Library view (`library:history.removed`).
   */
  'library.historyMenu': { args: { url: string; profileId?: ProfileId; x?: number; y?: number }; result: void }
  /** Test-only (ORBIT_E2E=1): where the calling window's Library view is and whether it has focus. */
  'library.testInfo': {
    args: Record<string, never>
    result: {
      open: boolean
      visible: boolean
      bounds?: { x: number; y: number; width: number; height: number }
      aboveTabs: boolean
      focused: boolean
    }
  }

  /** Sidebar backups, newest first (AR-11). */
  'backups.list': { args: Record<string, never>; result: BackupInfo[] }
  /**
   * Puts the sidebar back as it was in a backup (AR-11): Spaces, Favorites, pinned and Today tabs,
   * folders and split views. Backs up the sidebar as it is first, and changes nothing when that
   * fails. Tabs opened since go to the Archive; tabs that come back leave it. One step on the
   * sidebar's undo stack: ⌘Z takes it back, ⌘⇧Z restores again.
   */
  'backups.restore': { args: { id: string }; result: BackupRestoreResult }
  /** The restore toast's Undo: takes restore `step` back while it is the sidebar's newest change. */
  'backups.undoRestore': { args: { step: number }; result: BackupUndoResult }
  /**
   * Backs up the sidebar now, unless the newest backup holds the same sidebar: returns the new
   * backup or that one (null when backups cannot be written).
   */
  'backups.take': { args: Record<string, never>; result: BackupInfo | null }
}
