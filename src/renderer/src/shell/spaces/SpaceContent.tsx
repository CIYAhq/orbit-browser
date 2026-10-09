import { Plus } from 'lucide-react'
import { type MouseEvent, memo, useLayoutEffect, useRef } from 'react'
import type { SpaceId } from '../../../../shared/state'
import { invoke, runAction } from '../../api'
import { useOrbit } from '../../store'
import { Favorites } from '../sidebar/Favorites'
import { ItemList } from '../sidebar/ItemList'
import { scrollMemory } from './scroll-memory'
import { openSpaceMenu, TitleRow } from './TitleRow'

/**
 * The active Space's real, interactive sidebar content (SB-02 regions 3–9):
 * Favorites, then one scrolling list with the title row, pinned items, the
 * divider with Clear, "+ New Tab" and Today. Rendered in slot 0 of the strip.
 *
 * Favorites sit in a `data-favorites-layer` wrapper: during a swipe the
 * switcher holds that layer still (same profile) or cross-fades it (PR-06).
 */
export const SpaceContent = memo(function SpaceContent({ spaceId }: { spaceId: SpaceId }) {
  const profileId = useOrbit((s) => s.spaces[spaceId]?.profileId)
  const pinned = useOrbit((s) => s.spaces[spaceId]?.pinned)
  const today = useOrbit((s) => s.spaces[spaceId]?.today)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Each Space comes back at the scroll position it had in this window (SP-10).
  // (Only touch scrollTop when it must change: setting it forces a layout.)
  const shownTop = useRef(0)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const top = scrollMemory.get(spaceId) ?? 0
    if (top !== shownTop.current || top !== 0) el.scrollTop = top
    shownTop.current = top
    const onScroll = () => {
      shownTop.current = el.scrollTop
      scrollMemory.set(spaceId, el.scrollTop)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [spaceId])

  if (!profileId || !pinned || !today) return null

  // Right-click on empty sidebar space: the Space menu plus sidebar items (SP-04, SB-08).
  const onContextMenu = (e: MouseEvent) => {
    if (e.defaultPrevented) return
    e.preventDefault()
    openSpaceMenu(spaceId, e.clientX, e.clientY, true)
  }

  return (
    <div className="space-page" data-testid="space-page" data-space-id={spaceId}>
      <div className="space-page__favorites" data-favorites-layer>
        <Favorites profileId={profileId} />
      </div>
      <div className="sidebar__scroll" ref={scrollRef} data-testid="sidebar-scroll" onContextMenu={onContextMenu}>
        <TitleRow spaceId={spaceId} />
        <ItemList container={{ kind: 'pinned', spaceId }} items={pinned} testId="pinned-list" />
        <div className="sidebar__divider" data-testid="today-divider">
          <span className="sidebar__divider-line" />
          {today.length > 0 && (
            <button
              type="button"
              className="sidebar__clear"
              data-testid="clear-today"
              onClick={() => void invoke('tabs.clearToday', { spaceId })}
            >
              Clear
            </button>
          )}
        </div>
        <button
          type="button"
          className="new-tab-button"
          data-testid="new-tab-button"
          onClick={() => runAction('tab.new')}
        >
          <Plus size={16} strokeWidth={2} />
          <span>New Tab</span>
        </button>
        <ItemList container={{ kind: 'today', spaceId }} items={today} testId="today-list" />
        <div className="space-page__fill" data-testid="sidebar-empty-area" onDoubleClick={() => runAction('tab.new')} />
      </div>
    </div>
  )
})
