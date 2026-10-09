import type { ProfileId } from '../state'

/** One page in a profile's browsing history (one row per URL). */
export interface HistoryEntry {
  url: string
  title: string
  favicon?: string
  /** Number of visits recorded. */
  visitCount: number
  /** Visits that started from a typed or chosen command bar URL (boosts autocompletion). */
  typedCount: number
  firstVisit: number
  lastVisit: number
}

/** One visit, for chronological lists such as the History view. */
export interface HistoryVisit {
  url: string
  title: string
  favicon?: string
  /** Visit time (ms since epoch). */
  at: number
}

/**
 * Browsing history, per profile, kept out of OrbitState (src/main/history/).
 * `profileId` defaults to the profile of the calling window's current Space.
 * Private (non-persistent) sessions never record history.
 */
export interface HistoryCommands {
  /** Visits newest first, optionally filtered by text (title/URL) and paged with `before`. */
  'history.visits': {
    args: { profileId?: ProfileId; text?: string; before?: number; limit?: number }
    result: HistoryVisit[]
  }
  /** Pages (one per URL) matching `text`, best first (frecency), for search UIs. */
  'history.search': {
    args: { profileId?: ProfileId; text: string; limit?: number }
    result: HistoryEntry[]
  }
  /** Removes every visit to a URL. */
  'history.delete': { args: { profileId?: ProfileId; url: string }; result: void }
  /** Removes visits in [from, to) (default: everything). Entries left without visits are dropped. */
  'history.clear': { args: { profileId?: ProfileId; from?: number; to?: number }; result: void }
}
