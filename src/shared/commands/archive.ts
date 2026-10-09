import type { ArchivedTab, ProfileId, SpaceId, TabId } from '../state'

/**
 * Which archived pages a list shows (AR-03): everything, tabs that left the sidebar, or pages
 * closed in a Mini Window.
 */
export type ArchiveSource = 'all' | 'sidebar' | 'mini'

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
  /** Tabs put back into the sidebar, in the order given. */
  tabIds: TabId[]
  /** The Space the last of them went to. */
  spaceId?: SpaceId
}

/** Why the Library opens: the shortcut, menu or command bar route (AR-02, AR-07, AR-10). */
export interface LibraryOpenArgs {
  /** Section to show; default: the one used last (AR-02, DL-09). */
  section?: string
  /** Ask to clear the Archive as soon as it shows (AR-07 from the menu or the command bar). */
  confirmClear?: boolean
}

/** A sidebar snapshot (AR-11), newest first in lists. */
export interface BackupInfo {
  id: string
  at: number
  spaces: number
  tabs: number
}

/** Owned by the archive lane: the Archive, the Library container, history view and backups. */
export interface ArchiveCommands {
  /** Archived tabs of one profile, filtered, newest first, a page at a time (AR-03, AR-04). */
  'archive.query': { args: ArchiveQuery; result: ArchivePage }
  /**
   * Puts archived tabs back at the top of the Space they came from, with their history when the
   * profile still matches (AR-05, PR-05). `open` also selects the (last) tab in the calling window.
   * Entries already restored are skipped, so repeated clicks never restore twice.
   */
  'archive.restore': { args: { id?: string; ids?: string[]; open?: boolean }; result: ArchiveRestoreResult }
  /** Removes entries without restoring them (AR-07, row menu). Returns how many went. */
  'archive.delete': { args: { ids: string[] }; result: number }
  /** Removes every entry of a profile (default: the calling window's) (AR-07). Returns how many went. */
  'archive.clear': { args: { profileId?: ProfileId }; result: number }
  /** Shows the row's context menu (Restore, Open in New Tab, Copy URL, Delete) at a point of the Library. */
  'archive.contextMenu': { args: { ids: string[]; x: number; y: number }; result: void }
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
  /** Is the Library open in the calling window, and on which section. */
  'library.status': { args: Record<string, never>; result: { open: boolean; section: string } }
  /** Remembers the section shown, so the Library reopens there (AR-02). */
  'library.setSection': { args: { section: string }; result: void }

  /** Sidebar snapshots, newest first (AR-11). */
  'backups.list': { args: Record<string, never>; result: BackupInfo[] }
  /** Puts the sidebar back as it was in a snapshot (AR-11). Takes a snapshot of the current one first. */
  'backups.restore': { args: { id: string }; result: boolean }
  /** Takes a snapshot now (Restore Data takes one before restoring; also used by tests). */
  'backups.take': { args: Record<string, never>; result: BackupInfo | null }
}
