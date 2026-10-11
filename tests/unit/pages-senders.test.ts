import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** What each module listens for on ipcMain: the handlers under test. */
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => void>()

vi.mock('electron', () => ({
  app: { on: () => {}, getLocaleCountryCode: () => 'CH', getPath: () => '/tmp' },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: {},
  ipcMain: {
    on: (channel: string, handler: (event: unknown, ...args: unknown[]) => void) => handlers.set(channel, handler),
    handle: () => {},
  },
  systemPreferences: { isSwipeTrackingFromScrollEventsEnabled: () => true },
  webContents: { getFocusedWebContents: () => null, getAllWebContents: () => [] },
  WebContentsView: class {},
}))
// The windows module pulls in the whole shell; these modules use only these of it.
vi.mock('../../src/main/windows', () => ({
  activeTabOf: () => 't1',
  loadRenderer: () => {},
  rendererEntry: () => '',
  shownTabs: () => new Set(['t1']),
  uiWebPreferences: () => ({}),
  viewContents: () => undefined,
}))

import type { MainContext } from '../../src/main/context'
import { type PageDialogs$, registerDialogs } from '../../src/main/pages/dialogs'
import type { FullScreen$ } from '../../src/main/pages/fullscreen'
import { registerPrint } from '../../src/main/pages/print'
import { registerScreens } from '../../src/main/pages/screens'
import { registerSwipe } from '../../src/main/pages/swipe'
import type { TabOps } from '../../src/main/tabs/ops'
import { PAGE_CHANNEL } from '../../src/shared/site'

const MAIN_FRAME = { frameTreeNodeId: 1, parent: null, url: 'https://a.test/', origin: 'https://a.test' }
/** A frame in the page, from another site: it has no preload, but a compromised renderer can send. */
const SUB_FRAME = { frameTreeNodeId: 2, parent: MAIN_FRAME, url: 'https://b.test/', origin: 'https://b.test' }

/** A tab's page (tab `t1`, in window `w1`), as far as these modules look at it. */
function fakePage() {
  return Object.assign(new EventEmitter(), {
    id: 7,
    mainFrame: MAIN_FRAME,
    session: {},
    navigationHistory: { canGoBack: () => true, canGoForward: () => true },
    isDestroyed: () => false,
    isLoading: () => false,
    getURL: () => 'https://a.test/',
    getTitle: () => 'A',
    printToPDF: async () => Buffer.from('%PDF-1.4\n'),
    send: () => {},
    focus: () => {},
  })
}

/**
 * The context the modules get: one window `w1` showing tab `t1`, and nothing drawn (its page has
 * no place, unless `windows` gives one).
 */
function fakeContext(windows: Record<string, unknown> = {}) {
  const win = Object.assign(new EventEmitter(), { isDestroyed: () => false, isFocused: () => true })
  const ctx = {
    store: { state: { tabs: { t1: { id: 't1', title: 'A' } }, windows: {}, splits: {} }, subscribe: () => () => {} },
    tabs: { tabIdFor: () => 't1', get: () => undefined, contents: () => undefined },
    windows: {
      get: () => win,
      windowOfTab: () => 'w1',
      onLayout: () => {},
      isUi: () => false,
      focusedWindowId: () => 'w1',
      ids: () => ['w1'],
      hasPageCover: () => false,
      tabViewBounds: () => undefined,
      createUiView: () => undefined,
      showUiView: () => {},
      hideUiView: () => {},
      ...windows,
    },
    commands: { register: () => {}, run: async () => {} },
    hooks: { tabCreated: [] as ((tabId: string, page: unknown) => void)[] },
  }
  return ctx as unknown as MainContext & { hooks: { tabCreated: ((tabId: string, page: unknown) => void)[] } }
}

/** A message from the page, sent by `frame`. */
function from(page: ReturnType<typeof fakePage>, frame: typeof MAIN_FRAME | typeof SUB_FRAME) {
  return { sender: page, senderFrame: frame, returnValue: undefined as unknown }
}

function send(channel: string, event: ReturnType<typeof from>, ...args: unknown[]) {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`nothing listens on ${channel}`)
  handler(event, ...args)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('[NV-24][NV-07][NV-02][NV-13] the page channels take a page’s main frame only (D40, review follow-up 13)', () => {
  it('alert, confirm and prompt: a frame gets the engine’s answer at once, and no dialog shows', () => {
    const dialogs = registerDialogs(fakeContext())
    const page = fakePage()
    const framed = from(page, SUB_FRAME)
    send(PAGE_CHANNEL.dialog, framed, 'confirm', 'Sure?', '')
    expect(framed.returnValue).toBe(false)
    expect(dialogs.pending(page as unknown as Electron.WebContents)).toBe(false)
    // The page's own: it waits for the user's answer.
    const own = from(page, MAIN_FRAME)
    send(PAGE_CHANNEL.dialog, own, 'confirm', 'Sure?', '')
    expect(own.returnValue).toBeUndefined()
    expect(dialogs.pending(page as unknown as Electron.WebContents)).toBe(true)
  })

  it('print: a frame’s print() opens no print dialog', () => {
    const print = registerPrint(fakeContext(), { deliver: async () => ({ ok: true }), printers: async () => [] })
    const page = fakePage()
    const framed = from(page, SUB_FRAME)
    send(PAGE_CHANNEL.print, framed)
    expect(framed.returnValue).toBe(false)
    expect(print.info()).toEqual([])
    const own = from(page, MAIN_FRAME)
    send(PAGE_CHANNEL.print, own)
    expect(own.returnValue).toBe(true)
    expect(print.info()).toHaveLength(1)
  })

  it('swipe: a frame’s swipe shows no arrow', () => {
    const swipe = registerSwipe(
      fakeContext({ tabViewBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }), createUiView: () => ({}) }),
    )
    const page = fakePage()
    send(PAGE_CHANNEL.swipe, from(page, SUB_FRAME), 'move', 'back', 40)
    expect(swipe.info('w1').tabId).toBeNull()
    send(PAGE_CHANNEL.swipe, from(page, MAIN_FRAME), 'move', 'back', 40)
    expect(swipe.info('w1').tabId).toBe('t1')
  })

  it('a form on its way: a frame can’t take the page’s navigation off the load timer', () => {
    vi.useFakeTimers()
    const timedAfter = (frame: typeof MAIN_FRAME | typeof SUB_FRAME) => {
      const ctx = fakeContext()
      const dialogs = { dismiss: () => {}, pending: () => false, hostable: () => true } as unknown as PageDialogs$
      registerScreens(ctx, {} as TabOps, dialogs, { onKey: () => {} } as unknown as FullScreen$, 30_000)
      const page = fakePage()
      for (const hook of ctx.hooks.tabCreated) hook('t1', page)
      send(PAGE_CHANNEL.formSent, from(page, frame), 'https://a.test/upload')
      const before = vi.getTimerCount()
      page.emit('did-start-navigation', { url: 'https://a.test/upload', isMainFrame: true, isSameDocument: false })
      return vi.getTimerCount() - before
    }
    // The page's own form isn't timed (it may be a large upload); one a frame claims is.
    expect(timedAfter(MAIN_FRAME)).toBe(0)
    expect(timedAfter(SUB_FRAME)).toBe(1)
  })
})
