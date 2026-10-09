import { newId } from '../../shared/ids'
import type { ArchivedTab, OrbitState, ProfileId, SpaceId, Tab } from '../../shared/state'
import { fallbackTitle } from '../../shared/url'
import type { MainContext } from '../context'

/** A tab that lives outside the sidebar: a Peek card's page or a Mini Window's page. */
export function floatingTab(
  kind: 'peek' | 'mini',
  fields: { spaceId: SpaceId; profileId: ProfileId; url: string },
  now = Date.now(),
): Tab {
  return {
    id: newId('t'),
    title: fallbackTitle(fields.url),
    createdAt: now,
    lastActiveAt: now,
    loading: false,
    audible: false,
    muted: false,
    canGoBack: false,
    canGoForward: false,
    asleep: true,
    floating: kind,
    ...fields,
  }
}

const MAX_ARCHIVE = 5000
const ARCHIVE_TRIM_CHUNK = 500

/**
 * Records a closed floating page in the Archive, tagged with where it was (AR-01). Entries are
 * appended, newest last, and trimmed in chunks, as the tabs lane does. Returns the entry id.
 * Draft helper.
 */
export function archiveFloating(
  d: OrbitState,
  tab: Tab,
  from: 'peek' | 'mini',
  reason: ArchivedTab['reason'],
): string | undefined {
  if (!tab.url || tab.url === 'about:blank') return undefined
  const id = newId('a')
  d.archive.push({
    id,
    url: tab.url,
    title: tab.title,
    spaceId: tab.spaceId,
    profileId: tab.profileId,
    archivedAt: Date.now(),
    reason,
    from,
  })
  if (d.archive.length > MAX_ARCHIVE + ARCHIVE_TRIM_CHUNK) d.archive.splice(0, d.archive.length - MAX_ARCHIVE)
  return id
}

const guarded = new WeakSet<object>()

/**
 * A floating page that closes itself (window.close()) takes its Peek card or Mini Window with it
 * (each owner listens for that); it is not closed and archived like a sidebar tab, which would
 * hand its window another tab first. Idempotent; call after the tabs lane registered.
 */
export function keepFloatingPagesOutOfTabClose(ctx: MainContext): void {
  if (guarded.has(ctx.tabs)) return
  guarded.add(ctx.tabs)
  const pageClosed = ctx.tabs.onPageClosed
  ctx.tabs.onPageClosed = (tabId) => {
    if (ctx.store.state.tabs[tabId]?.floating) return
    pageClosed?.(tabId)
  }
}
