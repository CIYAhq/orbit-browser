import type { MenuItemConstructorOptions } from 'electron'
import type { LibraryHistoryQuery } from '../../shared/commands/archive'
import type { HistoryVisit } from '../../shared/commands/history'
import type { ProfileId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'

/** Visits per request: the History section asks for pages as it scrolls (AR-10). */
export const HISTORY_LIMIT_MAX = 500
const TEXT_MAX = 500

/** The `history.visits` query for a History section request, with its limits applied. */
export function historyQuery(
  q: LibraryHistoryQuery,
  profileId: ProfileId,
): { profileId: ProfileId; text?: string; before?: number; limit: number } {
  const text = typeof q.text === 'string' ? q.text.trim().slice(0, TEXT_MAX) : ''
  const limit = typeof q.limit === 'number' && Number.isFinite(q.limit) ? Math.floor(q.limit) : 100
  return {
    profileId,
    ...(text ? { text } : {}),
    ...(typeof q.before === 'number' && Number.isFinite(q.before) ? { before: q.before } : {}),
    limit: Math.max(1, Math.min(HISTORY_LIMIT_MAX, limit)),
  }
}

/**
 * Visits as the History section shows them: the site's remembered icon (a data URL; the Library
 * page loads no remote images), else none and the row shows the globe.
 */
export function historyRows(visits: readonly HistoryVisit[], faviconFor: (url: string) => string | undefined) {
  return visits.map((v): HistoryVisit => {
    const favicon = faviconFor(v.url) ?? (v.favicon?.startsWith('data:image/') ? v.favicon : undefined)
    return { url: v.url, title: v.title, at: v.at, ...(favicon ? { favicon } : {}) }
  })
}

/**
 * A History row's menu (AR-10): open the page in a new tab (shown, or behind the Library), copy
 * its address, or remove every visit to it from the profile's history.
 */
export function historyMenuItems(
  ctx: Pick<MainContext, 'commands'>,
  opts: {
    url: string
    profileId: ProfileId
    windowId: WindowId | undefined
    /** Tells the Library view (a toast, rows that went). */
    send: (channel: string, payload: unknown) => void
    /** Puts text on the clipboard. */
    copy: (text: string) => void
  },
): MenuItemConstructorOptions[] {
  const { url, profileId, windowId, send } = opts
  const fail = (what: string) => (err: unknown) => console.error(`[archive] could not ${what}`, err)
  const open = (activate: boolean) => {
    ctx.commands
      .run('tabs.create', { url, activate }, { windowId })
      .then(() => {
        if (!activate) send('library:toast', { message: 'Opened in a new tab' })
      })
      .catch(fail('open a page from History'))
  }
  return [
    { label: 'Open in New Tab', click: () => open(true) },
    { label: 'Open in Background', click: () => open(false) },
    {
      label: 'Copy Link',
      click: () => {
        opts.copy(url)
        send('library:toast', { message: 'Copied link' })
      },
    },
    { type: 'separator' },
    {
      label: 'Remove from History',
      click: () => {
        ctx.commands
          .run('history.delete', { profileId, url })
          .then(() => send('library:history.removed', { url }))
          .catch(fail('remove a page from History'))
      },
    },
  ]
}
