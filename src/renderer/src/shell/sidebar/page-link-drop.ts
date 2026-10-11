import type { Box, PaneBox } from '../../../../shared/split'
import type { TabId } from '../../../../shared/state'
import { invoke } from '../../api'
import { getOrbitState } from '../../store'

/** How long the split's preview waits for the pages to say where they take links. */
const ANSWER_MS = 150

/** What a sidebar row dragged over the page does at a point (TB-09). */
export type LinkDropMode = 'link' | 'split' | 'wait'

/**
 * A sidebar row dragged over the page offers the page its link (TB-09): over a place the page takes
 * links (a chat box, a search field), releasing drops the link there rather than making a split.
 * The pages are asked once where those places are, as soon as the row is lifted, while they are
 * drawn as they are: the split's preview then makes room and moves them, but the places asked stay
 * where the pages put them back when the row is over one. Until the pages answer, the preview waits.
 */
export interface PageLinks {
  /** The panes the row is or will be over (window coordinates); asks their pages again when they change. */
  panes(panes: readonly PaneBox[]): void
  /** At window point `x`, `y` over the page: drop the link (and tell the page), make a split, or wait. */
  at(x: number, y: number): LinkDropMode
  /** The row went off the page: the page is told, and keeps its places for the row's return. */
  away(): void
  /** Gives the page the link at `x`, `y`; false when nothing took it. Ends the drag. */
  drop(x: number, y: number): Promise<boolean>
  /** The drag ended without a drop on the page. */
  end(): void
}

const inside = (r: Box, x: number, y: number) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height

/** `onAnswer` runs when the pages answer. Undefined for a tab with no link a page could use. */
export function pageLinks(tabId: TabId, onAnswer: () => void): PageLinks | undefined {
  const url = getOrbitState().tabs[tabId]?.url
  if (!url || !/^(https?|file):/i.test(url)) return undefined
  let key = ''
  /** Null while the pages are being asked. */
  let targets: Box[] | null = []
  /** The page is told of the row: it is over one of the page's places. */
  let over = false
  let telling = false
  let next: { x: number; y: number } | null = null
  const tell = (x: number, y: number) => {
    if (telling) {
      next = { x, y }
      return
    }
    telling = true
    void invoke('tabs.dropLink', { x, y, phase: 'over' })
      .catch(() => false)
      .then(() => {
        telling = false
        const p = next
        next = null
        if (p && over) tell(p.x, p.y)
      })
  }
  const away = () => {
    next = null
    if (!over) return
    over = false
    void invoke('tabs.dropLink', { x: 0, y: 0, phase: 'leave' }).catch(() => false)
  }
  const forget = () => {
    const asked = key !== ''
    next = null
    over = false
    key = ''
    targets = []
    return asked
  }
  return {
    panes(panes) {
      const k = panes.map((p) => `${p.tabId}@${p.rect.x},${p.rect.y},${p.rect.width},${p.rect.height}`).join(';')
      if (!k || k === key) return
      away()
      key = k
      targets = null
      let done = false
      const settle = (answer: Box[]) => {
        if (done || key !== k) return
        done = true
        targets = answer
        onAnswer()
      }
      // A page that doesn't answer in time takes no links this time: the split's preview shows.
      setTimeout(() => settle([]), ANSWER_MS)
      void invoke('tabs.linkTargets', { tabId, panes: panes.map((p) => ({ tabId: p.tabId, rect: p.rect })) }).then(
        settle,
        () => settle([]),
      )
    },
    at(x, y) {
      if (!targets) return 'wait'
      if (!targets.some((r) => inside(r, x, y))) {
        away()
        return 'split'
      }
      over = true
      tell(x, y)
      return 'link'
    },
    away,
    async drop(x, y) {
      const hit = !!targets?.some((r) => inside(r, x, y))
      if (!forget()) return false
      // The page forgets the row (and its places) either way.
      return invoke('tabs.dropLink', { x, y, phase: hit ? 'drop' : 'end' }).catch(() => false)
    },
    end() {
      if (forget()) void invoke('tabs.dropLink', { x: 0, y: 0, phase: 'end' }).catch(() => false)
    },
  }
}
