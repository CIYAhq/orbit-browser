import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, type NavigationEntry } from 'electron'
import { isPrivateTab } from '../../shared/private'
import type { OrbitState, TabId } from '../../shared/state'
import type { MainContext } from '../context'
import type { SavedHistory } from '../tabs/runtime'

/** The file each quit writes: every tab's back/forward list with its pages' state. */
export const SESSION_HISTORY_FILE = 'orbit-session-history.json'

/** The most entries kept per tab, around the page it shows: enough for Back and Forward, never megabytes. */
const MAX_ENTRIES = 25

interface SessionHistoryFile {
  version: 1
  tabs: Record<TabId, SavedHistory>
}

const isEntry = (e: unknown): e is NavigationEntry =>
  !!e &&
  typeof (e as NavigationEntry).url === 'string' &&
  typeof (e as NavigationEntry).title === 'string' &&
  ((e as NavigationEntry).pageState === undefined || typeof (e as NavigationEntry).pageState === 'string')

/** A tab's list, cut to MAX_ENTRIES around the page it shows. */
export function trimHistory(history: SavedHistory): SavedHistory {
  const { entries, index } = history
  if (entries.length <= MAX_ENTRIES) return { entries, index }
  const start = Math.max(0, Math.min(index - Math.floor(MAX_ENTRIES / 2), entries.length - MAX_ENTRIES))
  return { entries: entries.slice(start, start + MAX_ENTRIES), index: index - start }
}

/**
 * The lists a quit saved that still belong to the tab they were saved for: a tab's page must be the
 * one its list shows (the state file may be newer, after a crash). Private tabs are never kept.
 */
export function historiesToRestore(state: OrbitState, raw: unknown): Map<TabId, SavedHistory> {
  const out = new Map<TabId, SavedHistory>()
  const file = raw as Partial<SessionHistoryFile> | null
  if (file?.version !== 1 || typeof file.tabs !== 'object' || file.tabs === null) return out
  for (const [tabId, history] of Object.entries(file.tabs)) {
    const tab = state.tabs[tabId]
    if (!tab || isPrivateTab(state, tabId) || !history || !Array.isArray(history.entries)) continue
    const { entries, index } = history
    if (!entries.every(isEntry) || !Number.isInteger(index) || index < 0 || index >= entries.length) continue
    if (entries[index]?.url !== tab.url) continue
    out.set(tabId, trimHistory({ entries, index }))
  }
  return out
}

/**
 * Session restore (ST-16). The state file brings back windows (size, position, maximized), Spaces,
 * tabs and split views, and only the tab each window shows loads at launch (TB-22). This adds what a
 * page was showing: each quit saves every tab's back/forward list with its pages' state (scroll
 * position, what was typed in forms), and at launch a tab that wakes restores it, so the page comes
 * back where it was, with Back and Forward. Private tabs are never saved.
 */
export function registerSessionRestore(ctx: MainContext): void {
  const { store, tabs } = ctx
  const file = join(ctx.paths.userData, SESSION_HISTORY_FILE)
  let raw: unknown = null
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // No file yet (a first run, or a crash before any quit), or unreadable: tabs load their address.
  }
  // Before any window opens: the tab a window shows wakes with its list.
  for (const [tabId, history] of historiesToRestore(store.state, raw)) {
    if (!tabs.savedHistory.has(tabId)) tabs.savedHistory.set(tabId, history)
  }

  const save = () => {
    const state = store.state
    const out: SessionHistoryFile = { version: 1, tabs: {} }
    for (const tab of Object.values(state.tabs)) {
      if (isPrivateTab(state, tab.id)) continue
      const contents = tabs.contents(tab.id)
      const history =
        contents && contents.navigationHistory.length() > 0
          ? { entries: contents.navigationHistory.getAllEntries(), index: contents.navigationHistory.getActiveIndex() }
          : tabs.savedHistory.get(tab.id)
      if (history && history.entries.length > 0) out.tabs[tab.id] = trimHistory(history)
    }
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(out))
      renameSync(tmp, file)
    } catch (err) {
      console.error('[session-restore] could not save', err)
    }
  }
  app.on('before-quit', (event) => {
    // A quit something stopped (downloads in progress, DL-01) saves nothing yet.
    if (!event.defaultPrevented) save()
  })
}
