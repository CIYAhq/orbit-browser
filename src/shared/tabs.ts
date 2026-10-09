/**
 * Pure tab helpers shared by the main process and the sidebar (owned by the tabs lane).
 */
import type { Tab } from './state'

/** Compares two URLs as the same document (ignores the fragment and a bare trailing slash). */
export function sameDocUrl(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const norm = (u: string) => {
    const noHash = u.split('#')[0] ?? u
    return noHash.endsWith('/') ? noHash.slice(0, -1) : noHash
  }
  return norm(a) === norm(b)
}

/** A pinned tab or Favorite that shows something other than its pinned page (PN-03, FV-06). */
export function isAwayFromPinned(tab: Pick<Tab, 'url' | 'pinnedUrl' | 'pinnedResolvedUrl'>): boolean {
  if (!tab.pinnedUrl || !tab.url || tab.url === 'about:blank') return false
  if (sameDocUrl(tab.url, tab.pinnedUrl)) return false
  if (tab.pinnedResolvedUrl && sameDocUrl(tab.url, tab.pinnedResolvedUrl)) return false
  return true
}

function hostOf(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** The title shown for a tab: its custom name, else the page title (TB-12). */
export function tabTitle(tab: Pick<Tab, 'title' | 'customTitle' | 'url'>): string {
  return tab.customTitle || tab.title || hostOf(tab.url) || 'New Tab'
}

/**
 * Title parts for a sidebar row. A pinned tab that navigated away shows a breadcrumb:
 * the pinned (or custom) name, then the current page title (PN-03, PN-08).
 */
export function rowTitle(
  tab: Pick<Tab, 'title' | 'customTitle' | 'url' | 'pinnedUrl' | 'pinnedResolvedUrl' | 'pinnedTitle'>,
): { prefix?: string; title: string } {
  if (isAwayFromPinned(tab)) {
    const prefix = tab.customTitle || tab.pinnedTitle || hostOf(tab.pinnedUrl)
    return { prefix, title: tab.title || hostOf(tab.url) }
  }
  return { title: tabTitle(tab) }
}

/** Query parameters that only track the visitor (stripped by Copy URL, TB-20). */
const TRACKING_PARAMS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^dclid$/i,
  /^msclkid$/i,
  /^mc_(cid|eid)$/i,
  /^igshid$/i,
  /^yclid$/i,
  /^_hs(enc|mi)$/i,
  /^ref_src$/i,
  /^si$/i,
]

export function cleanUrl(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return url
  }
  if (!/^https?:$/.test(u.protocol)) return url
  const keys = [...u.searchParams.keys()]
  let changed = false
  for (const key of keys) {
    if (TRACKING_PARAMS.some((re) => re.test(key))) {
      u.searchParams.delete(key)
      changed = true
    }
  }
  if (!changed) return url
  const out = u.toString()
  return out.endsWith('?') ? out.slice(0, -1) : out
}

/** `[title](url)` with brackets in the title escaped (TB-20). */
export function markdownLink(title: string, url: string): string {
  const safe = title.replace(/([[\]\\])/g, '\\$1')
  return `[${safe}](${url})`
}
