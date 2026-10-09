import { ChevronRight, Folder, FolderOpen, Undo2, Volume2, VolumeX, X } from 'lucide-react'
import { AnimatePresence, animate, motion, useIsPresent, useMotionValue, type Variants } from 'motion/react'
import {
  memo,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { isFolderId, isSplitId, isTabId } from '../../../../shared/ids'
import type { ItemId, TabId } from '../../../../shared/state'
import { isAwayFromPinned, rowTitle } from '../../../../shared/tabs'
import { splitLeaves, tabsInItem, visibleTabOrder } from '../../../../shared/tree'
import { invoke, isMac } from '../../api'
import { activeTabId } from '../../selectors'
import { getOrbitState, useOrbit } from '../../store'
import { Favicon } from '../../ui/Favicon'
import { pressItem } from './drag'
import { QUICK_EASE, reducedMotion, SNAPPY, SNAPPY_EASE } from './motion-tokens'
import { RenameField } from './RenameField'
import { clearSelection, startRename, useDrag, useKeyboardFocus, useRename, useSelection } from './ui-state'

/** Indent per folder level (FD-06). */
export const INDENT = 14

const ROW_SPRING = SNAPPY
const EASE_OUT = SNAPPY_EASE
/** Rows beyond this many in a batch leave together (FL-11 caps the sweep at about 450 ms). */
const MAX_STAGGER_ROWS = 12

/**
 * Row enter/exit (FL-06, FL-09, FL-11): the row's height grows or collapses with the snappy
 * spring so neighbours glide; content fades in over the last part of the growth; a closing
 * row slides left 12 px as it fades; a Clear batch sweeps 24 px, 25 ms apart.
 */
const rowVariants: Variants = {
  hidden: { height: 0, opacity: 0 },
  shown: {
    height: 'auto',
    opacity: 1,
    transition: { height: ROW_SPRING, opacity: { duration: 0.12, delay: 0.07, ease: QUICK_EASE } },
  },
  exit: (c: { stagger?: boolean; index?: number } | undefined) => {
    const delay = c?.stagger ? Math.min(c.index ?? 0, MAX_STAGGER_ROWS) * 0.025 : 0
    return {
      height: 0,
      opacity: 0,
      x: c?.stagger ? -24 : -12,
      transition: {
        height: { ...ROW_SPRING, delay: delay + 0.04 },
        opacity: { duration: c?.stagger ? 0.16 : 0.13, ease: QUICK_EASE, delay },
        x: { duration: c?.stagger ? 0.16 : 0.13, ease: QUICK_EASE, delay },
      },
    }
  },
}

/** Rows leaving together, in list order (drives the cascade delay). */
const exitOrder = new Map<string, number>()

/** A list of sidebar items (tabs, folders, split views) in one container. */
export const ItemList = memo(function ItemList({
  containerKey,
  items,
  depth = 0,
  ancestors = '',
  testId,
}: {
  containerKey: string
  items: ItemId[]
  depth?: number
  ancestors?: string
  testId?: string
}) {
  // Several rows leaving at once (Clear, archive below) sweep out in a cascade (TD-04).
  const prev = useRef(items)
  if (prev.current !== items) {
    const removed = prev.current.filter((id) => !items.includes(id))
    if (removed.length > 1) {
      for (const [k, id] of removed.entries()) exitOrder.set(id, k)
    }
    prev.current = items
  }
  return (
    <div className="item-list" data-testid={testId} data-list={containerKey}>
      <AnimatePresence initial={false}>
        {items.map((id, index) => {
          if (isTabId(id))
            return (
              <TabRow
                key={id}
                tabId={id}
                depth={depth}
                containerKey={containerKey}
                index={index}
                ancestors={ancestors}
              />
            )
          if (isFolderId(id))
            return (
              <FolderRow
                key={id}
                folderId={id}
                depth={depth}
                containerKey={containerKey}
                index={index}
                ancestors={ancestors}
              />
            )
          if (isSplitId(id))
            return (
              <SplitRow
                key={id}
                splitId={id}
                depth={depth}
                containerKey={containerKey}
                index={index}
                ancestors={ancestors}
              />
            )
          return null
        })}
      </AnimatePresence>
    </div>
  )
})

/** Row offset while a drag opens a gap; jumps (no animation) when the drop commits. */
export function useRowShift(key: string) {
  const shift = useDrag((s) => s.shifts[key] ?? 0)
  const animated = useDrag((s) => s.phase === 'dragging' || s.phase === 'cancelling')
  const y = useMotionValue(0)
  useLayoutEffect(() => {
    if (animated && !reducedMotion()) {
      const controls = animate(y, shift, ROW_SPRING)
      return () => controls.stop()
    }
    y.jump(shift)
    return undefined
  }, [shift, animated, y])
  return y
}

interface SlotProps {
  depth: number
  containerKey: string
  index: number
  ancestors: string
}

/** Wrapper that animates a row in and out and carries its drag-and-drop slot data. */
function RowSlot({
  id,
  folder,
  children,
  depth,
  containerKey,
  index,
  ancestors,
  className = 'row-slot',
}: SlotProps & { id: string; folder?: 'open' | 'closed'; children: React.ReactNode; className?: string }) {
  const y = useRowShift(id)
  const hidden = useDrag((s) => !!s.hidden[id])
  const present = useIsPresent()
  // Rows that arrive or leave through a drag appear/disappear at once (the ghost covers them).
  const [instant] = useState(() => hidden)
  if (!present && hidden) return null
  const order = present ? undefined : exitOrder.get(id)
  return (
    <motion.div
      className={`${className}${hidden ? ' is-drag-hidden' : ''}`}
      style={{ y }}
      variants={rowVariants}
      custom={{ stagger: order !== undefined, index: order }}
      onAnimationComplete={() => {
        if (!present) exitOrder.delete(id)
      }}
      initial={instant || reducedMotion() ? false : 'hidden'}
      animate="shown"
      exit="exit"
      data-slot="item"
      data-key={id}
      data-container={containerKey}
      data-index={index}
      data-depth={depth}
      data-folder={folder}
      data-ancestors={ancestors || undefined}
      data-exiting={present ? undefined : '1'}
    >
      {children}
    </motion.div>
  )
}

function onRowPointerDown(e: ReactPointerEvent<HTMLElement>, tabId: TabId) {
  if (e.button !== 0) return
  const sel = useSelection.getState()
  if ((isMac ? e.metaKey : e.ctrlKey) && !e.altKey) {
    // ⌘-click toggles a row in the multi-selection (TB-13).
    e.preventDefault()
    const active = activeTabId(getOrbitState())
    const base = sel.ids.length > 0 ? sel.ids : active && active !== tabId ? [active] : []
    const ids = base.includes(tabId) ? base.filter((id) => id !== tabId) : [...base, tabId]
    useSelection.setState({ ids, anchor: tabId })
    return
  }
  if (e.shiftKey) {
    // ⇧-click selects a contiguous range in sidebar order (TB-13).
    e.preventDefault()
    const state = getOrbitState()
    const win = state.windows[window.orbit.windowId]
    const active = activeTabId(state)
    const order = win ? visibleTabOrder(state, win.spaceId, { activeTabId: active, includeFavorites: false }) : []
    const anchor = sel.anchor ?? active ?? tabId
    const a = order.indexOf(anchor)
    const b = order.indexOf(tabId)
    if (a >= 0 && b >= 0) {
      // The range joins what is already selected (⌘-clicked rows stay).
      const range = order.slice(Math.min(a, b), Math.max(a, b) + 1)
      const base = sel.ids.length > 0 ? sel.ids : active ? [active] : []
      useSelection.setState({ ids: [...new Set([...base, ...range])], anchor })
    }
    return
  }
  // A press on a selected row keeps the selection (to drag the group); a plain click clears it.
  const inSelection = useSelection.getState().ids.includes(tabId)
  if (!inSelection) clearSelection()
  void invoke('tabs.activate', { tabId })
  pressItem(e, tabId, 'list', inSelection ? clearSelection : undefined)
}

function openContextMenu(e: ReactMouseEvent, id: ItemId) {
  e.preventDefault()
  const sel = useSelection.getState().ids
  void invoke('tabs.contextMenu', { id, selection: sel.includes(id) ? sel : [] })
}

export const TabRow = memo(function TabRow({
  tabId,
  depth,
  containerKey,
  index,
  ancestors,
}: { tabId: string } & SlotProps) {
  return (
    <RowSlot id={tabId} depth={depth} containerKey={containerKey} index={index} ancestors={ancestors}>
      <TabRowBody tabId={tabId} depth={depth} />
    </RowSlot>
  )
})

/** The row itself (TB-01): icon, title (or breadcrumb, PN-03), audio, close. */
export const TabRowBody = memo(function TabRowBody({ tabId, depth }: { tabId: string; depth: number }) {
  const tab = useOrbit((s) => s.tabs[tabId])
  const active = useOrbit((s) => activeTabId(s) === tabId)
  const selected = useSelection((s) => s.ids.includes(tabId))
  const focused = useKeyboardFocus((s) => s.id === tabId)
  const renaming = useRename((s) => (s.id === tabId ? s.mode : null))
  const [iconHover, setIconHover] = useState(false)
  // A tab that just opened in the background glows once so the eye finds it (FL-06).
  const [fresh] = useState(() => !!tab && !active && Date.now() - tab.createdAt < 1500)
  if (!tab) return null
  const { prefix, title } = rowTitle(tab)
  const away = isAwayFromPinned(tab)
  const showReset = away && iconHover
  return (
    <div
      role="treeitem"
      tabIndex={-1}
      aria-selected={active}
      aria-label={prefix ? `${prefix} / ${title}` : title}
      className={`tab-row${active ? ' is-active' : ''}${selected ? ' is-selected' : ''}${tab.asleep ? ' is-asleep' : ''}${tab.loading ? ' is-loading' : ''}${away ? ' is-away' : ''}${focused ? ' is-focused' : ''}${fresh ? ' is-new-background' : ''}`}
      style={{ paddingLeft: 8 + depth * INDENT }}
      data-testid="tab-row"
      data-tab-id={tabId}
      onPointerDown={(e) => onRowPointerDown(e, tabId)}
      onAuxClick={(e) => {
        if (e.button === 1) void invoke('tabs.close', { tabId })
      }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('button')) return
        startRename(tabId)
      }}
      onContextMenu={(e) => openContextMenu(e, tabId)}
    >
      <span
        className={`tab-row__icon${away ? ' tab-row__icon--resettable' : ''}`}
        data-testid="tab-icon"
        onMouseEnter={() => setIconHover(true)}
        onMouseLeave={() => setIconHover(false)}
        onPointerDown={(e) => {
          if (!away || e.button !== 0) return
          // Click the favicon of a pinned tab that wandered off: back to its pinned page (PN-04).
          e.stopPropagation()
          void invoke('tabs.activate', { tabId })
          void invoke('tabs.resetToPinned', { tabId, keepCurrent: isMac ? e.metaKey : e.ctrlKey })
        }}
      >
        {showReset ? (
          <Undo2 size={14} strokeWidth={2.2} className="tab-row__reset-glyph" data-testid="reset-pinned" />
        ) : tab.icon ? (
          <span className="tab-row__emoji">{tab.icon}</span>
        ) : (
          <Favicon src={tab.favicon} />
        )}
      </span>
      {renaming ? (
        <RenameField
          id={tabId}
          mode={renaming}
          initial={renaming === 'url' ? (tab.pinnedUrl ?? tab.url) : (tab.customTitle ?? tab.title)}
        />
      ) : (
        <span className="tab-row__title" data-testid="tab-title">
          {showReset ? (
            <span className="tab-row__hint">Return to pinned page</span>
          ) : (
            <>
              {prefix && (
                <span className="tab-row__crumb" data-testid="tab-crumb">
                  {prefix}
                  <span className="tab-row__slash"> / </span>
                </span>
              )}
              {title}
            </>
          )}
        </span>
      )}
      {(tab.audible || tab.muted) && (
        <button
          type="button"
          className="tab-row__audio"
          data-testid="tab-audio"
          aria-label={tab.muted ? 'Unmute tab' : 'Mute tab'}
          title={tab.muted ? 'Unmute' : 'Mute'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => void invoke('tabs.setMuted', { tabId, muted: !tab.muted })}
        >
          {tab.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
        </button>
      )}
      <button
        type="button"
        className="tab-row__close"
        aria-label="Close tab"
        title="Close"
        data-testid="tab-close"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => void invoke('tabs.close', { tabId })}
      >
        <X size={13} strokeWidth={2.2} />
      </button>
    </div>
  )
})

const FolderRow = memo(function FolderRow({
  folderId,
  depth,
  containerKey,
  index,
  ancestors,
}: { folderId: string } & SlotProps) {
  const folder = useOrbit((s) => s.folders[folderId])
  // FD-04: the selected tab stays visible under a closed folder ("peeking").
  const peek = useOrbit((s) => {
    const f = s.folders[folderId]
    if (!f?.collapsed) return null
    const active = activeTabId(s)
    return active && tabsInItem(s, folderId).includes(active) ? active : null
  })
  const into = useDrag((s) => s.intoFolder === folderId)
  const focused = useKeyboardFocus((s) => s.id === folderId)
  const renaming = useRename((s) => s.id === folderId)
  const hidden = useDrag((s) => !!s.hidden[folderId])
  const collapsedBefore = useRef<boolean | null>(null)
  if (!folder) return null
  const childAncestors = ancestors ? `${ancestors},${folderId}` : folderId
  const open = !folder.collapsed
  const FolderIcon = open ? FolderOpen : Folder
  return (
    <div className={`folder${hidden ? ' is-drag-hidden' : ''}`} data-testid="folder" data-folder-id={folderId}>
      <RowSlot
        id={folderId}
        folder={open ? 'open' : 'closed'}
        depth={depth}
        containerKey={containerKey}
        index={index}
        ancestors={ancestors}
      >
        <div
          role="treeitem"
          tabIndex={-1}
          aria-expanded={open}
          className={`folder-row${into ? ' is-drop-into' : ''}${focused ? ' is-focused' : ''}`}
          style={{ paddingLeft: 8 + depth * INDENT }}
          data-testid="folder-row"
          onPointerDown={(e) => {
            if (e.button !== 0 || renaming) return
            clearSelection()
            pressItem(e, folderId, 'list')
          }}
          onClick={(e) => {
            if (renaming || e.detail > 1) return
            collapsedBefore.current = folder.collapsed
            void invoke('folders.setCollapsed', { folderId, collapsed: open })
          }}
          onDoubleClick={() => {
            // A double-click renames (FD-03); undo the toggle its first click made.
            const before = collapsedBefore.current
            if (before !== null) void invoke('folders.setCollapsed', { folderId, collapsed: before })
            collapsedBefore.current = null
            startRename(folderId)
          }}
          onContextMenu={(e) => openContextMenu(e, folderId)}
        >
          <motion.span
            className="folder-row__chevron-wrap"
            initial={false}
            animate={{ rotate: open ? 90 : 0 }}
            transition={{ duration: 0.16, ease: EASE_OUT }}
          >
            <ChevronRight size={13} />
          </motion.span>
          <span className="folder-row__icon">
            {folder.icon ? (
              <span className="tab-row__emoji">{folder.icon}</span>
            ) : (
              <FolderIcon size={15} strokeWidth={1.7} />
            )}
          </span>
          {renaming ? (
            <RenameField id={folderId} mode="name" initial={folder.name} />
          ) : (
            <span className="folder-row__title" data-testid="folder-title">
              {folder.name}
            </span>
          )}
        </div>
      </RowSlot>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="children"
            className="folder__children"
            initial={reducedMotion() ? false : { height: 0, opacity: 0 }}
            animate={{
              height: 'auto',
              opacity: 1,
              transition: { height: { duration: 0.2, ease: EASE_OUT }, opacity: { duration: 0.12 } },
            }}
            exit={{
              height: 0,
              opacity: 0,
              transition: { height: { duration: 0.18, ease: EASE_OUT }, opacity: { duration: 0.1 } },
            }}
          >
            <ItemList
              containerKey={`folder:${folderId}`}
              items={folder.children}
              depth={depth + 1}
              ancestors={childAncestors}
            />
          </motion.div>
        )}
      </AnimatePresence>
      {!open && peek && (
        <div className="folder__peek" data-testid="folder-peek">
          <TabRow
            tabId={peek}
            depth={depth + 1}
            containerKey={`folder:${folderId}`}
            index={folder.children.indexOf(peek)}
            ancestors={childAncestors}
          />
        </div>
      )}
    </div>
  )
})

const SplitRow = memo(function SplitRow({
  splitId,
  depth,
  containerKey,
  index,
  ancestors,
}: { splitId: string } & SlotProps) {
  const leaves = useOrbit((s) => {
    const split = s.splits[splitId]
    return split ? splitLeaves(split.layout).join(',') : ''
  })
  if (!leaves) return null
  return (
    <RowSlot
      id={splitId}
      depth={depth}
      containerKey={containerKey}
      index={index}
      ancestors={ancestors}
      className="row-slot row-slot--split"
    >
      <div
        className="split-row"
        data-testid="split-row"
        data-split-id={splitId}
        onContextMenu={(e) => openContextMenu(e, leaves.split(',')[0] as string)}
      >
        {leaves.split(',').map((tabId) => (
          <TabRowBody key={tabId} tabId={tabId} depth={depth} />
        ))}
      </div>
    </RowSlot>
  )
})
