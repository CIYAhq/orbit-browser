import { newId } from '../../shared/ids'
import type { ArchivedTab, OrbitState, ProfileId, SpaceId, Tab } from '../../shared/state'
import { fallbackTitle } from '../../shared/url'

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

/** Records a closed floating page in the Archive, tagged with where it was (AR-01). Draft helper. */
export function archiveFloating(d: OrbitState, tab: Tab, from: 'peek' | 'mini', reason: ArchivedTab['reason']): void {
  if (!tab.url || tab.url === 'about:blank') return
  d.archive.unshift({
    id: newId('a'),
    url: tab.url,
    title: tab.title,
    spaceId: tab.spaceId,
    profileId: tab.profileId,
    archivedAt: Date.now(),
    reason,
    from,
  })
  if (d.archive.length > 5000) d.archive.length = 5000
}
