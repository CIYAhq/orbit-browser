import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import { ClickTracker, HeldModifiers } from '../../src/main/peek/input'

/** A page's web contents, as far as the click tracker uses it. */
class FakePage extends EventEmitter {
  id = 7
  loading = false
  zoom = 1
  /** What the page answers when asked for a link, and the code it was asked to run. */
  answer: string | null = null
  asked: string[] = []
  getURL = () => 'https://app.example.com/inbox'
  isLoadingMainFrame = () => this.loading
  getZoomFactor = () => this.zoom
  executeJavaScriptInIsolatedWorld = (_world: number, scripts: { code: string }[]) => {
    this.asked.push(scripts[0]?.code ?? '')
    return Promise.resolve(this.answer)
  }
  get contents(): WebContents {
    return this as unknown as WebContents
  }
}

function setup() {
  const page = new FakePage()
  const clicks = new ClickTracker(new HeldModifiers())
  clicks.watch(page.contents)
  const click = (x = 40, y = 20) => {
    page.emit('input-event', {}, { type: 'mouseDown', x, y })
    page.emit('input-event', {}, { type: 'mouseUp', x, y })
  }
  /** The engine reports the link under the pointer (or focused); '' when it leaves links. */
  const target = (url: string) => page.emit('update-target-url', {}, url)
  return { page, clicks, click, target }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('Peek link clicks (PK-02)', () => {
  it('[PK-02] a navigation counts as a link click only when it goes where the clicked link points', () => {
    const { page, clicks, click, target } = setup()
    target('https://other.org/a')
    click()
    expect(clicks.onLink(page.contents, 'https://other.org/a')).toBeDefined()
    // A form post, a script navigation or a sign-in's auto-post goes elsewhere.
    expect(clicks.onLink(page.contents, 'https://other.org/post/target')).toBeUndefined()
    expect(clicks.onLink(page.contents, 'https://sso.example.net/acs')).toBeUndefined()
  })

  it('[PK-02] a click off any link counts for nothing; a link under the pointer without a click neither', () => {
    const { page, clicks, click, target } = setup()
    target('https://other.org/a')
    expect(clicks.onLink(page.contents, 'https://other.org/a')).toBeUndefined()
    target('')
    click()
    expect(clicks.onLink(page.contents, 'https://other.org/a')).toBeUndefined()
  })

  it('[PK-02] the link the page finds under the click counts, the same URL however it is written', async () => {
    const { page, clicks, click } = setup()
    page.answer = 'https://Other.org'
    page.zoom = 2
    click(80, 40)
    await settle()
    // Asked in CSS pixels: the view's point divided by the page zoom.
    expect(page.asked[0]).toContain('elementFromPoint(40, 20)')
    expect(clicks.onLink(page.contents, 'https://other.org/')).toBeDefined()
  })

  it('[PK-02] a loading page is not asked (it would answer only once loaded); the engine still knows the link', async () => {
    const { page, clicks, click, target } = setup()
    page.loading = true
    target('https://other.org/a')
    click()
    await settle()
    expect(page.asked).toEqual([])
    expect(clicks.onLink(page.contents, 'https://other.org/a')).toBeDefined()
  })

  it('[PK-02] Enter on a focused link counts, read from the key Electron reports', async () => {
    const { page, clicks } = setup()
    page.answer = 'https://other.org/focused'
    page.emit('input-event', {}, { type: 'rawKeyDown', key: 'Enter', code: 'Enter' })
    await settle()
    expect(page.asked[0]).toContain('document.activeElement')
    expect(clicks.onLink(page.contents, 'https://other.org/focused')).toMatchObject({ x: undefined, y: undefined })
  })

  it('[PK-02] a click counts for a moment only, and opens its link once', () => {
    const { page, clicks, click, target } = setup()
    target('https://other.org/a')
    click()
    const at = clicks.recent(page.contents)?.at ?? 0
    expect(clicks.onLink(page.contents, 'https://other.org/a', at + 1500)).toBeDefined()
    expect(clicks.onLink(page.contents, 'https://other.org/a', at + 1501)).toBeUndefined()
    clicks.forget(page.contents)
    expect(clicks.onLink(page.contents, 'https://other.org/a', at + 10)).toBeUndefined()
  })
})
