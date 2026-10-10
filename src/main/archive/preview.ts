import type { ArchivedTab, OrbitState, ProfileId, TabId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import type { ArchiveStore } from './store'

/** Previews remembered at once; the oldest are forgotten first. */
const MAX_PREVIEWS = 20

/** An address without its fragment: the same page. */
export function pageKey(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    return u.toString()
  } catch {
    return url
  }
}

interface Preview {
  windowId: WindowId
  entryId: string
  profileId: ProfileId
  /** The pages it shows: the entry's address, and where each of its Peeks first landed (a redirect). */
  pages: Set<string>
  /** Its Peek tabs: the one the row opened, and a reopen of it (⌘Z, ⌘⇧T) over the Library. */
  tabs: Set<TabId>
}

/**
 * Previews of Archive entries (AR-06). A row clicked in the Library opens its page in a Peek over
 * the Library (the link-preview component, src/main/peek/) without restoring it. ⌘W and Esc close
 * the Peek only: the Library yields its keys to a Peek over it and takes them back after (library.ts).
 * The card's Open as Tab (⌘O) opens the page as a new tab and the entry stays, as with the row
 * menu's Open in New Tab. The Peek carries the entry's id (`overlay.archiveEntry`), and
 * `restore()` puts the entry back and closes the Peek.
 *
 * A closed Peek is archived like a closed tab (PK-09). A preview's page is in the Archive already,
 * so `isEcho()` tells the Archive to leave out the entry its close adds: one from a preview's Peek,
 * of the page previewed, while the entry previewed is still archived. A page the preview went on
 * to (a link followed in it) is archived as usual.
 */
export class ArchivePreviews {
  private previews: Preview[] = []

  constructor(
    private ctx: Pick<MainContext, 'store' | 'tabs'>,
    private archive: Pick<ArchiveStore, 'has'>,
    /** Whether the Library is open in a window (a Peek over it can be a reopened preview). */
    private libraryOpen: (windowId: WindowId) => boolean,
  ) {
    ctx.store.subscribe((next) => this.onState(next))
  }

  /** Remembers that a window's Peek `tabId` previews `entry`, and marks the Peek for its card. */
  track(windowId: WindowId, entry: Pick<ArchivedTab, 'id' | 'url' | 'profileId'>, tabId: TabId): void {
    let p = this.previews.find((x) => x.windowId === windowId && x.entryId === entry.id)
    if (!p) {
      p = { windowId, entryId: entry.id, profileId: entry.profileId, pages: new Set(), tabs: new Set() }
      this.previews.push(p)
      if (this.previews.length > MAX_PREVIEWS) this.previews.shift()
    }
    p.pages.add(pageKey(entry.url))
    this.adopt(p, tabId)
  }

  /** The Archive entry a window's open Peek previews, if any. */
  entryOf(windowId: WindowId | undefined): string | undefined {
    const overlay = windowId ? this.ctx.store.state.windows[windowId]?.overlay : undefined
    if (overlay?.kind !== 'peek' || overlay.phase) return undefined
    return this.previews.find((p) => p.windowId === windowId && p.tabs.has(overlay.tabId))?.entryId
  }

  /** Whether an entry just added to the Archive is a preview's page coming back as its Peek closes. */
  isEcho(state: OrbitState, e: ArchivedTab): boolean {
    if (e.from !== 'peek' || this.previews.length === 0) return false
    const page = pageKey(e.url)
    return this.previews.some(
      (p) =>
        p.profileId === e.profileId &&
        p.pages.has(page) &&
        this.archive.has(p.entryId) &&
        [...p.tabs].some((id) => {
          const tab = state.tabs[id]
          return tab?.floating === 'peek' && tab.spaceId === e.spaceId
        }),
    )
  }

  private adopt(p: Preview, tabId: TabId): void {
    p.tabs.add(tabId)
    // Where the page first lands is the same page (an address that redirects).
    const contents = this.ctx.tabs.contents(tabId)
    if (contents && !contents.isDestroyed()) {
      contents.once('did-navigate', (_event, url: string) => {
        if (p.tabs.has(tabId)) p.pages.add(pageKey(url))
      })
    }
    this.ctx.store.update((d) => {
      const overlay = d.windows[p.windowId]?.overlay
      if (overlay?.kind === 'peek' && overlay.tabId === tabId) overlay.archiveEntry = p.entryId
    })
  }

  private onState(next: OrbitState): void {
    if (this.previews.length === 0) return
    for (const p of [...this.previews]) {
      const win = next.windows[p.windowId]
      if (!win) {
        this.previews.splice(this.previews.indexOf(p), 1)
        continue
      }
      for (const id of p.tabs) if (!next.tabs[id]) p.tabs.delete(id)
      const open = this.libraryOpen(p.windowId)
      // A preview reopened over the Library (⌘Z, ⌘⇧T) is a preview again.
      const overlay = win.overlay
      if (open && overlay.kind === 'peek' && !overlay.phase && !p.tabs.has(overlay.tabId)) {
        const tab = next.tabs[overlay.tabId]
        const ours = this.previews.some((x) => x.tabs.has(overlay.tabId))
        if (!ours && tab?.floating === 'peek' && p.pages.has(pageKey(tab.url)) && this.archive.has(p.entryId)) {
          this.adopt(p, overlay.tabId)
        }
      }
      // Forgotten once its Peeks are gone and the Library closed.
      if (p.tabs.size === 0 && !open) this.previews.splice(this.previews.indexOf(p), 1)
    }
  }
}
