import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The extension store (EX-01): its settings, what a listing page is, and main's check of the store
 * page's install call (D40 (3)). Only an extension ID crosses; main takes the frame and the profile
 * from the call itself, and downloads nothing for a frame that isn't the store's main frame.
 */

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) =>
      handlers.set(channel, fn),
  },
}))

const {
  isStoreFrame,
  STORE_DOWNLOAD_URL,
  STORE_ORIGIN,
  storeConfig,
  storeDownloadUrl,
  storeListingId,
  storePageOrigin,
} = await import('../../src/shared/extension-store')
const { registerStore } = await import('../../src/main/extensions/store')
const { PAGE_CHANNEL } = await import('../../src/shared/site')

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const LOCAL = 'http://localhost:3355'

describe('the store’s settings', () => {
  const test = { ORBIT_STORE_ORIGIN: `${LOCAL}/`, ORBIT_STORE_DOWNLOAD_URL: `${LOCAL}/crx/{id}` }

  it('a packaged build uses the store’s own; e2e and development builds only a store on this machine a test names', () => {
    expect(storeConfig({}, true)).toEqual({ origin: STORE_ORIGIN, downloadUrl: STORE_DOWNLOAD_URL })
    expect(storeConfig(test, true)).toEqual({ origin: STORE_ORIGIN, downloadUrl: STORE_DOWNLOAD_URL })
    expect(storeConfig({ ORBIT_E2E: '1' }, true)).toBeNull()
    expect(storeConfig({}, false)).toBeNull()
    expect(storeConfig({ ORBIT_E2E: '1' }, false)).toBeNull()
    expect(storeConfig({ ...test, ORBIT_E2E: '1' }, false)).toEqual({ origin: LOCAL, downloadUrl: `${LOCAL}/crx/{id}` })
    expect(storeConfig(test, false)).toEqual({ origin: LOCAL, downloadUrl: `${LOCAL}/crx/{id}` })
  })

  it('never takes a store off this machine from the environment', () => {
    expect(
      storeConfig({ ORBIT_STORE_ORIGIN: STORE_ORIGIN, ORBIT_STORE_DOWNLOAD_URL: STORE_DOWNLOAD_URL }, false),
    ).toBeNull()
    expect(storeConfig({ ...test, ORBIT_STORE_DOWNLOAD_URL: 'https://example.com/crx/{id}' }, false)).toBeNull()
    expect(storeConfig({ ...test, ORBIT_STORE_ORIGIN: 'http://localhost.example.com' }, false)).toBeNull()
    expect(storeConfig({ ...test, ORBIT_STORE_ORIGIN: 'file:///tmp' }, false)).toBeNull()
  })

  it('gives the page preload the store’s origin, a test’s, or none in e2e', () => {
    expect(storePageOrigin({})).toBe(STORE_ORIGIN)
    expect(storePageOrigin({ ORBIT_E2E: '1' })).toBeNull()
    expect(storePageOrigin({ ...test, ORBIT_E2E: '1' })).toBe(LOCAL)
  })

  it('fills in the download address', () => {
    expect(storeDownloadUrl(STORE_DOWNLOAD_URL, ID, '150.0.1.2')).toContain(`prodversion=150.0.1.2&`)
    expect(storeDownloadUrl(STORE_DOWNLOAD_URL, ID, '1')).toContain(`x=id%3D${ID}%26`)
    expect(() => storeDownloadUrl(STORE_DOWNLOAD_URL, '../x', '1')).toThrow()
  })
})

describe('the store’s pages', () => {
  it('a frame calls as the store only from a main frame of exactly its origin', () => {
    expect(isStoreFrame(`${STORE_ORIGIN}/detail/x/${ID}`, true, STORE_ORIGIN)).toBe(true)
    expect(isStoreFrame(`${STORE_ORIGIN}/detail/x/${ID}`, false, STORE_ORIGIN)).toBe(false)
    expect(isStoreFrame('https://chromewebstore.google.com.example.com/', true, STORE_ORIGIN)).toBe(false)
    expect(isStoreFrame('http://chromewebstore.google.com/', true, STORE_ORIGIN)).toBe(false)
    expect(isStoreFrame('https://chromewebstore.google.com:444/', true, STORE_ORIGIN)).toBe(false)
    expect(isStoreFrame(`blob:${STORE_ORIGIN}/0b6c`, true, STORE_ORIGIN)).toBe(false)
    expect(isStoreFrame('about:blank', true, STORE_ORIGIN)).toBe(false)
    expect(isStoreFrame(undefined, true, STORE_ORIGIN)).toBe(false)
  })

  it('reads a listing’s extension from its address', () => {
    expect(storeListingId(`${STORE_ORIGIN}/detail/some-name/${ID}`, STORE_ORIGIN)).toBe(ID)
    expect(storeListingId(`${STORE_ORIGIN}/detail/${ID}?hl=en`, STORE_ORIGIN)).toBe(ID)
    expect(storeListingId(`${STORE_ORIGIN}/detail/some-name/${ID}/reviews`, STORE_ORIGIN)).toBe(ID)
    expect(storeListingId(`${STORE_ORIGIN}/detail/some-name/${ID.toUpperCase()}`, STORE_ORIGIN)).toBeNull()
    expect(storeListingId(`${STORE_ORIGIN}/category/extensions`, STORE_ORIGIN)).toBeNull()
    expect(storeListingId(`https://example.com/detail/some-name/${ID}`, STORE_ORIGIN)).toBeNull()
    expect(storeListingId(`${STORE_ORIGIN}/detail/some-name/${ID}`, undefined)).toBeNull()
  })
})

describe('main’s check of the store page’s install call (D40 (3))', () => {
  const fetches: string[] = []
  const toast = vi.fn()
  const report = vi.fn()
  const privateRefusal = vi.fn(() => ({ ok: false as const, error: 'private' }))
  const session = {
    fetch: async (url: string) => {
      fetches.push(url)
      return new Response('none', { status: 404 })
    },
  }
  const tabs: Record<string, { profileId: string }> = { t1: { profileId: 'p1' }, t2: { profileId: 'private-1' } }
  const register = (config: { origin: string; downloadUrl: string } | null) => {
    handlers.clear()
    const ctx = {
      actions: { register: () => {} },
      commands: { register: () => {}, run: async () => {} },
      store: { state: { tabs } },
      tabs: { tabIdFor: (c: { tabId?: string }) => c.tabId, contents: () => undefined },
      windows: { windowOfTab: () => 'w1', focusedWindowId: () => 'w1' },
      toast,
    }
    const service = {
      session: (profileId: string) => (profileId.startsWith('private-') ? undefined : session),
      get: () => undefined,
      installCrx: vi.fn(),
    }
    registerStore(ctx as never, config, {
      service: service as never,
      dialogs: {} as never,
      report,
      privateRefusal,
      mainWindowFor: () => 'w1',
    })
    const handler = handlers.get(PAGE_CHANNEL.storeInstall)
    if (!handler) throw new Error('no handler')
    return handler
  }
  /** A call from a frame of tab `tabId` (undefined: not a tab) showing `url`; `sub`: not its main frame. */
  const call = (url: string, opts: { tabId?: string; sub?: boolean } = {}) => ({
    sender: { tabId: 'tabId' in opts ? opts.tabId : 't1', mainFrame: { processId: 4, routingId: 1 } },
    senderFrame: { url, processId: 4, routingId: opts.sub ? 2 : 1, detached: false },
  })
  const config = { origin: LOCAL, downloadUrl: `${LOCAL}/crx/{id}?v={version}` }
  const listing = `${LOCAL}/detail/x/${ID}`

  beforeEach(() => {
    fetches.length = 0
    toast.mockClear()
    report.mockClear()
    privateRefusal.mockClear()
  })

  it('downloads only the ID’s file, for a tab’s main frame of the store, and says why it couldn’t', async () => {
    const handler = register(config)
    expect(await handler(call(listing), ID)).toBe('unknown_error')
    expect(fetches).toEqual([`${LOCAL}/crx/${ID}?v=${encodeURIComponent(process.versions.chrome ?? '')}`])
    expect(report).toHaveBeenCalledWith('w1', 'p1', { ok: false, error: 'The store didn’t send it (404).' })
  })

  it('answers any other frame with nothing, and downloads nothing', async () => {
    const handler = register(config)
    expect(await handler(call(listing, { sub: true }), ID)).toBe('unknown_error')
    expect(await handler(call(`http://127.0.0.1:3355/detail/x/${ID}`), ID)).toBe('unknown_error')
    expect(await handler(call('https://example.com/'), ID)).toBe('unknown_error')
    expect(await handler(call(listing, { tabId: undefined }), ID)).toBe('unknown_error')
    expect(fetches).toEqual([])
    expect(report).not.toHaveBeenCalled()
  })

  it('takes nothing but an extension ID', async () => {
    const handler = register(config)
    for (const id of ['', 'abc', ID.toUpperCase(), { id: ID }, [ID], 42, null]) {
      expect(await handler(call(listing), id)).toBe('invalid_id')
    }
    expect(fetches).toEqual([])
  })

  it('adds nothing in a private window', async () => {
    const handler = register(config)
    expect(await handler(call(listing, { tabId: 't2' }), ID)).toBe('blocked_by_policy')
    expect(privateRefusal).toHaveBeenCalled()
    expect(fetches).toEqual([])
  })

  it('makes no store request where the store is off, and says so on the store’s own page', async () => {
    const handler = register(null)
    expect(await handler(call(`${STORE_ORIGIN}/detail/x/${ID}`), ID)).toBe('unknown_error')
    expect(toast).toHaveBeenCalledTimes(1)
    expect(await handler(call(listing), ID)).toBe('unknown_error')
    expect(toast).toHaveBeenCalledTimes(1)
    expect(fetches).toEqual([])
  })
})
