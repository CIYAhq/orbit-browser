import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { ArchivePreviews, pageKey } from '../../src/main/archive/preview'
import { ArchiveSync } from '../../src/main/archive/service'
import { ArchiveStore } from '../../src/main/archive/store'
import type { MainContext } from '../../src/main/context'
import { archiveFloating, floatingTab } from '../../src/main/peek/floating'
import { Store } from '../../src/main/store'
import { createInitialState, createWindowState, DEFAULT_PROFILE_ID } from '../../src/shared/defaults'
import type { ArchivedTab } from '../../src/shared/state'

const syncs: ArchiveSync[] = []
afterEach(() => {
  for (const s of syncs.splice(0)) s.stop()
})

/** A window with the Library open over an archived page, and Peeks opened and closed as the peek code does. */
async function world() {
  const state = createInitialState(0)
  const spaceId = state.spaceOrder[0] as string
  const win = createWindowState(spaceId)
  state.windows[win.id] = win
  const store = new Store(state)
  /** Pages of Peek tabs, so a test can say where one landed. */
  const pages = new Map<string, EventEmitter & { isDestroyed(): boolean }>()
  const ctx = { store, tabs: { contents: (id: string) => pages.get(id) } } as unknown as MainContext
  const archive = new ArchiveStore(null)
  await archive.load()
  const sync = new ArchiveSync(ctx, archive)
  syncs.push(sync)
  sync.start()
  const library = { open: true }
  const previews = new ArchivePreviews(ctx, archive, () => library.open)
  sync.skip = (s, e) => previews.isEcho(s, e)

  const entry: ArchivedTab = {
    id: 'a-entry',
    url: 'https://site.test/page',
    title: 'Page',
    spaceId,
    profileId: DEFAULT_PROFILE_ID,
    archivedAt: 1000,
    reason: 'closed',
    section: 'today',
  }
  store.update((d) => {
    d.archive.push(entry)
  })

  let nonce = 0
  /** A Peek over the window: its floating tab and the overlay. */
  const openPeek = (url: string): string => {
    const tab = floatingTab('peek', { spaceId, profileId: DEFAULT_PROFILE_ID, url })
    pages.set(tab.id, Object.assign(new EventEmitter(), { isDestroyed: () => false }))
    store.update((d) => {
      d.tabs[tab.id] = tab
      const w = d.windows[win.id]
      if (w) w.overlay = { kind: 'peek', tabId: tab.id, nonce: ++nonce }
    })
    return tab.id
  }
  /** Closes it: its page is archived (PK-09), then the tab and the overlay go. */
  const closePeek = (tabId: string, url?: string) => {
    store.update((d) => {
      const tab = d.tabs[tabId]
      if (tab) archiveFloating(d, { ...tab, url: url ?? tab.url }, 'peek', 'closed')
    })
    store.update((d) => {
      delete d.tabs[tabId]
      const w = d.windows[win.id]
      if (w) w.overlay = { kind: 'none' }
    })
  }
  const overlay = () => store.state.windows[win.id]?.overlay
  /** What the Archive holds (addresses, newest first); the store and OrbitState agree. */
  const urls = () => {
    const inStore = [...archive.newestFirst(DEFAULT_PROFILE_ID)].map((i) => i.e)
    expect(store.state.archive.map((a) => a.id).filter((id) => !inStore.some((e) => e.id === id))).toEqual([])
    return inStore.map((e) => e.url)
  }
  return { store, win, archive, sync, previews, library, entry, pages, openPeek, closePeek, overlay, urls }
}

describe('Archive previews (AR-06)', () => {
  it('[AR-06] a preview marks its Peek; closing it adds no second entry, but a page it went on to is archived', async () => {
    const w = await world()
    const peek = w.openPeek(w.entry.url)
    w.previews.track(w.win.id, w.entry, peek)
    expect(w.overlay()).toMatchObject({ kind: 'peek', tabId: peek, archiveEntry: w.entry.id })
    expect(w.previews.entryOf(w.win.id)).toBe(w.entry.id)
    w.closePeek(peek)
    expect(w.urls()).toEqual([w.entry.url])
    expect(w.store.state.archive.map((a) => a.id)).toEqual([w.entry.id])
    expect(w.previews.entryOf(w.win.id)).toBeUndefined()
    // Where the page first landed (a redirect) and its fragment are the same page.
    const again = w.openPeek(w.entry.url)
    w.previews.track(w.win.id, w.entry, again)
    w.pages.get(again)?.emit('did-navigate', {}, 'https://site.test/page/')
    w.closePeek(again, 'https://site.test/page/#reviews')
    expect(w.urls()).toEqual([w.entry.url])
    // A link followed inside the preview: that page is a closed Peek like any other.
    const third = w.openPeek(w.entry.url)
    w.previews.track(w.win.id, w.entry, third)
    w.closePeek(third, 'https://site.test/elsewhere')
    expect(w.urls()).toEqual(['https://site.test/elsewhere', w.entry.url])
  })

  it('[AR-06] a preview reopened over the Library is one again; once its entry is gone, or the Library closed, a closed Peek is archived', async () => {
    const w = await world()
    const peek = w.openPeek(w.entry.url)
    w.previews.track(w.win.id, w.entry, peek)
    w.closePeek(peek)
    // ⌘Z / ⌘⇧T reopen it over the Library: the peek code opens a new Peek of the page.
    const reopened = w.openPeek(w.entry.url)
    expect(w.overlay()).toMatchObject({ tabId: reopened, archiveEntry: w.entry.id })
    w.closePeek(reopened)
    expect(w.urls()).toEqual([w.entry.url])
    // Another page in a Peek over the Library is not a preview.
    const other = w.openPeek('https://other.test/')
    expect(w.overlay()).not.toHaveProperty('archiveEntry')
    w.closePeek(other)
    expect(w.urls()).toEqual(['https://other.test/', w.entry.url])
    // The entry deleted: its page in a Peek is archived again (the only entry for it).
    w.sync.remove([w.entry.id])
    const after = w.openPeek(w.entry.url)
    w.closePeek(after)
    expect(w.urls()).toEqual([w.entry.url, 'https://other.test/'])
    expect(w.store.state.archive.some((a) => a.id === w.entry.id)).toBe(false)
  })

  it('[AR-06] previews are forgotten once their Peeks are gone and the Library closed', async () => {
    const w = await world()
    const peek = w.openPeek(w.entry.url)
    w.previews.track(w.win.id, w.entry, peek)
    // The Library closes first (another tab was selected), then the Peek: still no second entry.
    w.library.open = false
    w.store.update((d) => {
      d.settings.archiveKeepDays = 90
    })
    w.closePeek(peek)
    expect(w.urls()).toEqual([w.entry.url])
    // Forgotten now: the page opened in a Peek elsewhere later is archived as usual.
    const later = w.openPeek(w.entry.url)
    expect(w.overlay()).not.toHaveProperty('archiveEntry')
    w.closePeek(later)
    expect(w.urls()).toEqual([w.entry.url, w.entry.url])
  })

  it('[AR-06] the same page: the address without its fragment', () => {
    expect(pageKey('https://a.test/x?q=1#part')).toBe('https://a.test/x?q=1')
    expect(pageKey('https://a.test')).toBe('https://a.test/')
    expect(pageKey('not a url')).toBe('not a url')
  })
})
