import { peekShown, shownTabId } from '../../../shared/nav'
import type { OrbitState, TabId } from '../../../shared/state'
import { tweakHostOf, tweaksFor } from '../../../shared/tweaks'
import { useOrbitShallow } from '../store'

/** What the entry points know of the Tweaks of a page's site (BO-01, BO-14, BO-16). */
export interface TweakSite {
  /** Tweaks are on as a whole (BO-16). */
  allowed: boolean
  /** The site's host, where the page is a website Tweaks can change; null elsewhere. */
  host: string | null
  /** The site's Tweaks, and how many of them are on. */
  total: number
  on: number
}

/** The Tweaks of a tab's site, as primitives (the caller re-renders only when one changes). */
export function tweakSiteOf(state: OrbitState, tabId: TabId | null): TweakSite {
  const tab = tabId ? state.tabs[tabId] : undefined
  const host = tab && !tab.error ? tweakHostOf(tab.url) : null
  const list = tweaksFor(state.tweaks, host)
  let on = 0
  for (const tweak of list) if (tweak.enabled) on++
  return { allowed: state.settings.tweaksEnabled, host, total: list.length, on }
}

/** The Tweaks of the site a window shows; none while a Peek shows (the panel can't go over one). */
export function useTweakSite(windowId: string): TweakSite {
  return useOrbitShallow((s) =>
    peekShown(s, windowId) ? tweakSiteOf(s, null) : tweakSiteOf(s, shownTabId(s, windowId)),
  )
}
