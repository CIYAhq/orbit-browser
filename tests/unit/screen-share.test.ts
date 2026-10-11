import { runInNewContext } from 'node:vm'
import type { WebContents, WebFrameMain } from 'electron'
import { describe, expect, it } from 'vitest'
import { frameShareSource, MAX_PAGE_SHARES, ScreenShares } from '../../src/main/media/screen-share'

/** A document's own world with just enough of the engine's media tracks for the frame's script. */
function world() {
  return runInNewContext(`
    class EventTarget {
      constructor() { this.listeners = {} }
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) }
      fire(type) { for (const fn of this.listeners[type] || []) fn({ type }) }
    }
    class MediaStreamTrack extends EventTarget {
      constructor(kind, surface) { super(); this._kind = kind; this._surface = surface; this._state = 'live' }
      get kind() { return this._kind }
      get readyState() { return this._state }
      getSettings() { return this._surface ? { displaySurface: this._surface } : { deviceId: 'cam' } }
      stop() { this._state = 'ended' }
      clone() { return new MediaStreamTrack(this._kind, this._surface) }
      sourceEnded() { this._state = 'ended'; this.fire('ended') }
    }
    class MediaStream {
      constructor(tracks) { this.tracks = tracks }
      getTracks() { return this.tracks.slice() }
      getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video') }
    }
    var window = globalThis
    window.MediaStreamTrack = MediaStreamTrack
    window.MediaStream = MediaStream
    window.EventTarget = EventTarget
    window
  `) as {
    MediaStreamTrack: new (kind: string, surface?: string) => FakeTrack
    MediaStream: new (tracks: FakeTrack[]) => { getTracks: () => FakeTrack[]; getVideoTracks: () => FakeTrack[] }
    eval: (code: string) => unknown
  } & Record<string, { next: (v: number) => Promise<{ v: number; delta: number }> }>
}

interface FakeTrack {
  stop: () => void
  clone: () => FakeTrack
  sourceEnded: () => void
  readonly readyState: string
}

describe("a frame's screen-share script (MD-11)", () => {
  it('is a valid script that keeps its handle on the property it is given', () => {
    expect(() => new Function(`return ${frameShareSource('_k1')}`)).not.toThrow()
    const w = world()
    expect(w.eval(frameShareSource('_k1'))).toBe(true)
    expect(Object.getOwnPropertyDescriptor(w, '_k1')).toMatchObject({ writable: false, configurable: false })
    // Once is enough.
    expect(w.eval(frameShareSource('_k1'))).toBe(true)
  })

  it('counts shared tracks stopped and cloned, and sources ending; not the camera', async () => {
    const w = world()
    w.eval(frameShareSource('_k2'))
    const handle = w._k2 as { next: (v: number) => Promise<{ v: number; delta: number }> }
    const shared = new w.MediaStreamTrack('video', 'monitor')
    const camera = new w.MediaStreamTrack('video')
    camera.stop()
    expect(await handle.next(-1)).toEqual({ v: 0, delta: 0 })
    const copy = shared.clone()
    expect(await handle.next(0)).toEqual({ v: 1, delta: 1 })
    shared.stop()
    // A second stop of an ended track changes nothing.
    shared.stop()
    expect(await handle.next(1)).toEqual({ v: 2, delta: 0 })
    // A track the page reads from its stream is watched for its source ending.
    const stream = new w.MediaStream([copy])
    stream.getVideoTracks()
    copy.sourceEnded()
    expect(await handle.next(2)).toEqual({ v: 3, delta: -1 })
  })
})

describe('screen sharing per tab (MD-11, TB-15)', () => {
  const contents = {} as WebContents

  /** A frame whose script is in place at once; its answers to `next` wait for the test. */
  function fakeFrame(node: number, main: boolean) {
    const answers: ((value: unknown) => void)[] = []
    const state = { alive: true }
    const frame = {
      parent: main ? null : {},
      frameTreeNodeId: node,
      get detached() {
        return !state.alive
      },
      isDestroyed: () => !state.alive,
      executeJavaScript: (code: string) =>
        code.startsWith('(() =>') ? Promise.resolve(true) : new Promise((resolve) => answers.push(resolve)),
    } as unknown as WebFrameMain
    return { frame, answers, state }
  }

  it("a grant to the tab's own page counts until its script says the share stopped, or the page leaves", async () => {
    const changed: string[] = []
    const shares = new ScreenShares((id) => changed.push(id))
    const { frame, answers } = fakeFrame(1, true)
    expect(shares.sharing('t-a')).toBe(false)
    await shares.grant('t-a', contents, frame)
    expect(shares.sharing('t-a')).toBe(true)
    expect(shares.sharingGranted('t-a')).toBe(true)
    expect(shares.counts('t-a')).toEqual({ page: 0, main: 1, frames: [] })
    expect(changed).toEqual(['t-a'])
    await expect.poll(() => answers.length).toBe(1)
    // A clone shares too; then both are stopped.
    answers[0]?.({ v: 1, delta: 1 })
    await expect.poll(() => shares.counts('t-a').main).toBe(2)
    await expect.poll(() => answers.length).toBe(2)
    answers[1]?.({ v: 3, delta: -1 })
    await expect.poll(() => shares.sharing('t-a')).toBe(false)
    // Shared again, then the page loads another document: every share ended.
    await shares.grant('t-a', contents, frame)
    expect(shares.sharing('t-a')).toBe(true)
    shares.tabGone('t-a', contents)
    expect(shares.sharing('t-a')).toBe(false)
    expect(shares.counts('t-a')).toEqual({ page: 0, main: 0, frames: [] })
  })

  it("a frame's grant counts until its script says the share stopped, or the frame loads another page", async () => {
    const { frame, answers } = fakeFrame(7, false)
    const shares = new ScreenShares(() => {})
    await shares.grant('t-b', contents, frame)
    expect(shares.sharing('t-b')).toBe(true)
    await expect.poll(() => answers.length).toBe(1)
    answers[0]?.({ v: 1, delta: -1 })
    await expect.poll(() => shares.sharing('t-b')).toBe(false)
    // Shared again, then the frame moves on.
    await shares.grant('t-b', contents, frame)
    expect(shares.counts('t-b')).toEqual({ page: 0, main: 0, frames: [1] })
    shares.frameGone('t-b', contents, 7)
    expect(shares.sharing('t-b')).toBe(false)
  })

  it('a removed frame takes its shares with it; a garbled answer changes nothing', async () => {
    const { frame, answers, state } = fakeFrame(9, false)
    const shares = new ScreenShares(() => {})
    await shares.grant('t-c', contents, frame)
    await expect.poll(() => answers.length).toBe(1)
    answers[0]?.({ v: 'x', delta: -5 })
    await expect.poll(() => answers.length).toBe(2)
    expect(shares.sharing('t-c')).toBe(true)
    state.alive = false
    answers[1]?.(undefined)
    await expect.poll(() => shares.sharing('t-c')).toBe(false)
  })

  it("the page preload's count lights the indicator only: clamped, never keeping the tab awake (D69)", () => {
    const changed: string[] = []
    const shares = new ScreenShares((id) => changed.push(id))
    shares.pageCount('t-d', contents, 1)
    expect(shares.sharing('t-d')).toBe(true)
    expect(shares.sharingGranted('t-d')).toBe(false)
    shares.pageCount('t-d', contents, 1)
    expect(changed).toEqual(['t-d'])
    // Out of range, clamped; not a number, ignored.
    shares.pageCount('t-d', contents, 1e12)
    expect(shares.counts('t-d').page).toBe(MAX_PAGE_SHARES)
    shares.pageCount('t-d', contents, Number.POSITIVE_INFINITY)
    expect(shares.counts('t-d').page).toBe(MAX_PAGE_SHARES)
    shares.pageCount('t-d', contents, '3')
    shares.pageCount('t-d', contents, Number.NaN)
    expect(shares.counts('t-d').page).toBe(MAX_PAGE_SHARES)
    shares.pageCount('t-d', contents, -4)
    expect(shares.counts('t-d').page).toBe(0)
    expect(shares.sharing('t-d')).toBe(false)
    shares.pageCount('t-d', contents, 2.7)
    expect(shares.counts('t-d').page).toBe(2)
    // A new document: every share ended.
    shares.tabGone('t-d', contents)
    expect(shares.sharing('t-d')).toBe(false)
  })
})
