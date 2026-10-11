import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import { gestureCount, onGesture, watchGestures } from '../../src/main/pages/gestures'

/** A page's web contents, as far as the gesture count uses it. */
class FakePage extends EventEmitter {
  destroyed = false
  isDestroyed = () => this.destroyed
  get contents(): WebContents {
    return this as unknown as WebContents
  }
}

/** An Electron event, which a listener may prevent. */
function event() {
  const e = {
    defaultPrevented: false,
    preventDefault() {
      e.defaultPrevented = true
    },
  }
  return e
}

const at = { x: 10, y: 10 }

function setup() {
  const page = new FakePage()
  watchGestures(page.contents)
  const count = () => gestureCount(page.contents)
  /** A mouse-down in the page's own frame: the engine reports it twice, in one task. */
  const clickPage = () => {
    page.emit('before-mouse-event', event(), { type: 'mouseDown', ...at })
    page.emit('input-event', event(), { type: 'mouseDown', ...at })
  }
  /** A mouse-down in a frame from another site, which has a widget of its own. */
  const clickFrame = () => page.emit('before-mouse-event', event(), { type: 'mouseDown', ...at })
  /** A key down, in whichever frame has focus. */
  const key = (key: string, more: Record<string, unknown> = {}) =>
    page.emit('before-input-event', event(), { type: 'keyDown', key, isAutoRepeat: false, ...more })
  return { page, count, clickPage, clickFrame, key }
}

/** Lets the events of one task settle. */
const nextTask = () => new Promise((resolve) => setImmediate(resolve))

describe('A page’s user gestures, from any of its frames (D77)', () => {
  it('[NV-24][NV-19][NV-09] a mouse-down counts once, in the page’s own frame or in a frame from another site', async () => {
    const { page, count, clickPage, clickFrame } = setup()
    clickPage()
    await nextTask()
    expect(count()).toBe(1)
    clickFrame()
    await nextTask()
    expect(count()).toBe(2)
    // Two presses, each in a task of its own, are two.
    clickPage()
    await nextTask()
    clickPage()
    await nextTask()
    expect(count()).toBe(4)
    // A mouse-down the engine reports only as input counts too; a move or a release doesn't.
    page.emit('input-event', event(), { type: 'mouseDown', ...at })
    page.emit('before-mouse-event', event(), { type: 'mouseUp', ...at })
    page.emit('before-mouse-event', event(), { type: 'mouseMove', ...at })
    page.emit('input-event', event(), { type: 'mouseUp', ...at })
    await nextTask()
    expect(count()).toBe(5)
  })

  it('[NV-24][NV-19][NV-09] a key that reaches the page counts; one Orbit takes as its own shortcut doesn’t, so ⌘W never counts for the page it closes', async () => {
    const { page, count, key } = setup()
    key('a')
    await nextTask()
    expect(count()).toBe(1)
    // Orbit's shortcuts: a listener prevents the key, before or after the count's own.
    const shortcut = (e: ReturnType<typeof event>, input: { key: string; control?: boolean; meta?: boolean }) => {
      if ((input.control || input.meta) && ['w', 't'].includes(input.key)) e.preventDefault()
    }
    page.on('before-input-event', shortcut)
    key('w', { meta: true })
    await nextTask()
    expect(count()).toBe(1)
    page.off('before-input-event', shortcut)
    page.prependListener('before-input-event', shortcut)
    key('t', { control: true })
    await nextTask()
    expect(count()).toBe(1)
    // A key with a modifier that Orbit leaves to the page counts.
    key('b', { control: true })
    await nextTask()
    expect(count()).toBe(2)
  })

  it('[NV-24][NV-19][NV-09] as in Chromium, Esc, a modifier alone, a key held down and a key’s release count for nothing', async () => {
    const { page, count, key } = setup()
    for (const alone of ['Escape', 'Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock']) key(alone)
    key('a', { isAutoRepeat: true })
    page.emit('before-input-event', event(), { type: 'keyUp', key: 'a', isAutoRepeat: false })
    // The engine's own report of a key that reached the main frame: the key was counted already.
    page.emit('input-event', event(), { type: 'rawKeyDown', keyCode: 'a' })
    page.emit('input-event', event(), { type: 'keyDown', keyCode: 'a' })
    page.emit('input-event', event(), { type: 'char', keyCode: 'a' })
    await nextTask()
    expect(count()).toBe(0)
    // A key that closes the page as it comes counts for no page.
    key('a')
    page.destroyed = true
    await nextTask()
    expect(count()).toBe(0)
  })

  it('[NV-09] a tap and a touch’s end count', async () => {
    const { page, count } = setup()
    page.emit('input-event', event(), { type: 'gestureTap', ...at })
    page.emit('input-event', event(), { type: 'touchEnd' })
    page.emit('input-event', event(), { type: 'touchStart' })
    await nextTask()
    expect(count()).toBe(2)
  })

  it('[NV-24][NV-19][NV-09] each page counts its own, from when it was watched, once however often it was; a listener hears each gesture', async () => {
    const { page, count, clickFrame, key } = setup()
    const other = new FakePage()
    expect(gestureCount(other.contents)).toBe(0)
    // Watched again (the leave guard, links to other apps, the pop-up rule): still one count.
    watchGestures(page.contents)
    const heard: number[] = []
    onGesture(page.contents, () => heard.push(count()))
    clickFrame()
    key('x')
    await nextTask()
    expect(count()).toBe(2)
    expect(heard).toEqual([1, 2])
    expect(gestureCount(other.contents)).toBe(0)
    // A listener on a page not watched yet starts its count.
    onGesture(other.contents, () => heard.push(-1))
    other.emit('before-mouse-event', event(), { type: 'mouseDown', ...at })
    expect(gestureCount(other.contents)).toBe(1)
    expect(heard).toEqual([1, 2, -1])
  })
})
