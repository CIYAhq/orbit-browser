import { join } from 'node:path'
import { app } from 'electron'
import type { ArchiveQuery } from '../../shared/commands/archive'
import { DEFAULT_PROFILE_ID } from '../../shared/defaults'
import { newId } from '../../shared/ids'
import type { ArchivedTab, ProfileId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import type { CallContext } from '../registry'
import { ArchiveSync } from './service'
import { ArchiveStore } from './store'

/** How long after start-up the Archive log is read (off the cold-start path). */
const LOAD_DELAY_MS = 300
/** Renderers hear about Archive changes at most this often. */
const CHANGED_DEBOUNCE_MS = 40

export interface ArchiveApi {
  store: ArchiveStore
  sync: ArchiveSync
}

/**
 * The Archive (AR-*), main-process side.
 *
 * - `state.archive` is the recent window other features write to; `ArchiveSync` mirrors it into
 *   the `ArchiveStore` (every entry and its history, userData/archive/archive.jsonl).
 * - Commands (`archive.*`) query, restore, delete and clear; renderers hear `orbit:archive.changed`
 *   ({ version }) when the Archive changes and fetch again.
 */
export function registerArchive(ctx: MainContext): ArchiveApi {
  const { store: state, commands, windows } = ctx
  const store = new ArchiveStore(join(ctx.paths.userData, 'archive', 'archive.jsonl'))
  const sync = new ArchiveSync(ctx, store)
  sync.start()
  setTimeout(() => void store.load(), LOAD_DELAY_MS)
  app.on('before-quit', () => store.close())

  let changedTimer: ReturnType<typeof setTimeout> | undefined
  store.onChange = () => {
    if (changedTimer) return
    changedTimer = setTimeout(() => {
      changedTimer = undefined
      windows.broadcast('orbit:archive.changed', { version: store.version })
    }, CHANGED_DEBOUNCE_MS)
  }

  const windowOf = (c: CallContext): WindowId | undefined => c.windowId ?? windows.focusedWindowId()
  /** The profile a call is about: given, or the calling window's current Space's (PR-05). */
  const profileOf = (profileId: ProfileId | undefined, c: CallContext): ProfileId => {
    if (profileId) return profileId
    const s = state.state
    const windowId = windowOf(c)
    const win = windowId ? s.windows[windowId] : undefined
    const space = win ? s.spaces[win.spaceId] : undefined
    return space?.profileId ?? Object.keys(s.profiles)[0] ?? DEFAULT_PROFILE_ID
  }

  commands.register('archive.query', async (args: ArchiveQuery, c) => {
    await store.load()
    return store.query({ ...args, profileId: profileOf(args.profileId, c) }, (url) => ctx.tabs.faviconFor(url))
  })

  commands.register('archive.delete', async ({ ids }) => {
    await store.load()
    return sync.remove(Array.isArray(ids) ? ids : []).length
  })

  if (ctx.e2e) {
    // Fills the Archive for tests (lists, search at scale) without growing OrbitState.
    commands.register('archive.testSeed', async ({ count, days = 30, profileId, spaceId, prefix = 'Seeded' }, c) => {
      await store.load()
      const s = state.state
      const profile = profileOf(profileId, c)
      const space = spaceId ?? s.spaceOrder.find((id) => s.spaces[id]?.profileId === profile) ?? s.spaceOrder[0] ?? ''
      const now = Date.now()
      const words = [
        'alpha',
        'budget',
        'cinema',
        'delta',
        'garden',
        'harbor',
        'island',
        'journal',
        'kitchen',
        'lantern',
      ]
      const span = Math.max(1, days) * 24 * 3600_000
      const entries: ArchivedTab[] = []
      for (let i = 0; i < count; i++) {
        const word = words[i % words.length] as string
        entries.push({
          id: newId('a'),
          url: `https://${word}${i % 97}.example.test/page/${i}`,
          title: `${prefix} ${word} ${i}`,
          spaceId: space,
          profileId: profile,
          // Oldest first, spread evenly over the span, the newest a minute ago.
          archivedAt: now - 60_000 - Math.round(((count - 1 - i) / Math.max(1, count)) * span),
          reason: i % 3 === 0 ? 'auto' : 'closed',
          section: 'today',
        })
      }
      return store.add(entries).length
    })
  }

  return { store, sync }
}
