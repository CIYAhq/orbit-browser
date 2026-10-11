import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (event: unknown, ...args: unknown[]) => void
const ipc = vi.hoisted(() => ({ listeners: new Map<string, Listener>() }))
vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, listener: Listener) => {
      ipc.listeners.set(channel, listener)
    },
  },
}))

import type { WebContents } from 'electron'
import { ESCAPE_WAIT_MS, escapeLog, escapeThenStop, listenForEscapes } from '../../src/main/keys/escape'
import { PAGE_CHANNEL } from '../../src/shared/site'

const tabs = new Set<WebContents>()
listenForEscapes((contents) => tabs.has(contents))

/** A tab's web contents, as far as the Esc answer reads it. */
function page(url: string, tab = true) {
  const mainFrame = { frameTreeNodeId: 1 }
  const contents = { isDestroyed: () => false, getURL: () => url, mainFrame } as unknown as WebContents
  if (tab) tabs.add(contents)
  return { contents, mainFrame, child: { frameTreeNodeId: 2 } }
}

/** What a page's preload sends after an Esc: the bit, from the frame it runs in. */
function answer(contents: WebContents, frame: unknown, used: unknown): void {
  ipc.listeners.get(PAGE_CHANNEL.escape)?.({ sender: contents, senderFrame: frame }, used)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  tabs.clear()
})

describe('[KS-19][NV-04] Esc on a loading page: the page first, then Stop (D59)', () => {
  it('listens on the preload’s own channel', () => {
    expect(PAGE_CHANNEL.escape).toBe('orbit-page:escape')
    expect(ipc.listeners.has(PAGE_CHANNEL.escape)).toBe(true)
  })

  it('the page used Esc: the load goes on', () => {
    const { contents, mainFrame } = page('https://a.test/used')
    const stop = vi.fn()
    escapeThenStop(contents, () => true, stop)
    answer(contents, mainFrame, true)
    vi.advanceTimersByTime(ESCAPE_WAIT_MS)
    expect(stop).not.toHaveBeenCalled()
    expect(escapeLog().at(-1)).toEqual({ url: 'https://a.test/used', used: true, stopped: false })
  })

  it('the page left Esc alone: Orbit stops the load at once', () => {
    const { contents, mainFrame } = page('https://a.test/left')
    const stop = vi.fn()
    escapeThenStop(contents, () => true, stop)
    answer(contents, mainFrame, false)
    expect(stop).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(ESCAPE_WAIT_MS)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(escapeLog().at(-1)).toEqual({ url: 'https://a.test/left', used: false, stopped: true })
  })

  it('no answer within 250 ms counts as left alone (D60)', () => {
    expect(ESCAPE_WAIT_MS).toBe(250)
    const { contents } = page('https://a.test/silent')
    const stop = vi.fn()
    escapeThenStop(contents, () => true, stop)
    vi.advanceTimersByTime(ESCAPE_WAIT_MS - 1)
    expect(stop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(stop).toHaveBeenCalledTimes(1)
    // A late answer changes nothing.
    answer(contents, contents.mainFrame, true)
    expect(escapeLog().at(-1)).toEqual({ url: 'https://a.test/silent', used: false, stopped: true })
  })

  it('a bit sent with no Esc pressed does nothing, and doesn’t count for the next press', () => {
    const { contents, mainFrame } = page('https://a.test/stray')
    const before = escapeLog().length
    answer(contents, mainFrame, true)
    expect(escapeLog()).toHaveLength(before)
    const stop = vi.fn()
    escapeThenStop(contents, () => true, stop)
    vi.advanceTimersByTime(ESCAPE_WAIT_MS)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('only the main frame of a tab’s page answers (D40)', () => {
    const { contents, child } = page('https://a.test/frames')
    const stop = vi.fn()
    escapeThenStop(contents, () => true, stop)
    answer(contents, child, true)
    answer(contents, null, true)
    expect(stop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(ESCAPE_WAIT_MS)
    expect(stop).toHaveBeenCalledTimes(1)
    // Web contents that aren't a tab's are never asked, and can't answer for one.
    const other = page('https://b.test/', false)
    answer(other.contents, other.mainFrame, true)
    expect(escapeLog().at(-1)?.url).toBe('https://a.test/frames')
  })

  it('an answer that isn’t one bit is no answer', () => {
    const { contents, mainFrame } = page('https://a.test/odd')
    const stop = vi.fn()
    escapeThenStop(contents, () => true, stop)
    for (const odd of ['true', 1, {}, undefined]) answer(contents, mainFrame, odd)
    expect(stop).not.toHaveBeenCalled()
    answer(contents, mainFrame, true)
    vi.advanceTimersByTime(ESCAPE_WAIT_MS)
    expect(stop).not.toHaveBeenCalled()
  })

  it('two presses: each answer goes to the oldest press still waiting', () => {
    const { contents, mainFrame } = page('https://a.test/twice')
    const stop = vi.fn()
    escapeThenStop(contents, () => true, stop)
    escapeThenStop(contents, () => true, stop)
    answer(contents, mainFrame, true)
    expect(stop).not.toHaveBeenCalled()
    answer(contents, mainFrame, false)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(escapeLog().slice(-2)).toEqual([
      { url: 'https://a.test/twice', used: true, stopped: false },
      { url: 'https://a.test/twice', used: false, stopped: true },
    ])
  })

  it('a load that ended while Orbit waited is not stopped', () => {
    const { contents, mainFrame } = page('https://a.test/done')
    const stop = vi.fn()
    let loading = true
    escapeThenStop(contents, () => loading, stop)
    loading = false
    answer(contents, mainFrame, false)
    expect(stop).not.toHaveBeenCalled()
    expect(escapeLog().at(-1)).toEqual({ url: 'https://a.test/done', used: false, stopped: false })
  })

  it('keeps only the last few records', () => {
    const { contents, mainFrame } = page('https://a.test/many')
    for (let i = 0; i < 30; i++) {
      escapeThenStop(
        contents,
        () => true,
        () => {},
      )
      answer(contents, mainFrame, false)
    }
    expect(escapeLog().length).toBeLessThanOrEqual(10)
  })
})
