import { type MouseEvent, memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { SpaceId } from '../../../../shared/state'
import { SidebarItems } from '../sidebar/SidebarItems'
import { scrollMemory } from './scroll-memory'
import { openSpaceMenu, StaleContext, TitleRow } from './TitleRow'

/**
 * The active Space's real, interactive sidebar content (SB-02 regions 3–9), in
 * slot 0 of the strip: the tabs lane's SidebarItems (Favorites, title row,
 * pinned, divider, "+ New Tab", Today, drag and drop) with this lane's title
 * row as its header. Favorites sit in SidebarItems' `data-favorites-layer`,
 * which the switcher holds still or cross-fades during a swipe (PR-06).
 */
export const SpaceContent = memo(function SpaceContent({
  spaceId,
  stale = false,
}: {
  spaceId: SpaceId
  /** Hidden behind the stand-in while the new Space renders: its title steps aside (one space-name). */
  stale?: boolean
}) {
  const rootRef = useRef<HTMLDivElement>(null)

  // The swipe previews draw a Space at the scroll position it had here (SP-10). SidebarItems
  // restores the real list; this mirrors the positions for the previews.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onScroll = (e: Event) => {
      const el = e.target as HTMLElement
      if (el.classList?.contains('sidebar__scroll')) scrollMemory.set(spaceId, el.scrollTop)
    }
    root.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => root.removeEventListener('scroll', onScroll, { capture: true })
  }, [spaceId])

  // Right-click on empty sidebar space: the Space menu plus sidebar items (SP-04, SB-08).
  const onContextMenu = useCallback(
    (e: MouseEvent) => {
      e.preventDefault()
      openSpaceMenu(spaceId, e.clientX, e.clientY, true)
    },
    [spaceId],
  )
  const header = useMemo(() => <TitleRow spaceId={spaceId} />, [spaceId])

  return (
    <div className="space-page" ref={rootRef} data-testid="space-page" data-page-space={spaceId}>
      {/* Context, not props: the stale flag reaches the title row without re-rendering the list. */}
      <StaleContext.Provider value={stale}>
        <SidebarItems spaceId={spaceId} header={header} onContextMenu={onContextMenu} />
      </StaleContext.Provider>
    </div>
  )
})
