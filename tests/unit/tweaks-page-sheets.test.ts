import { describe, expect, it } from 'vitest'
import {
  insertSheet,
  type PlacedSheet,
  removeSheet,
  rendererOf,
  type SheetPage,
} from '../../src/main/tweaks/page-sheets'

/**
 * A page whose renderer answers only when the test says so, or never (it is busy, or it crashed),
 * and whose main frame can move to another renderer (a crash and reload, or another site's page).
 */
class Page implements SheetPage {
  mainFrame = { processId: 7, routingId: 1 }
  destroyed = false
  readonly asked: { css: string; answer: (key: string) => void; fail: (err: Error) => void }[] = []
  /** Each key taken out, with the renderer it went to. */
  readonly removed: string[] = []

  insertCSS(css: string): Promise<string> {
    return new Promise((answer, fail) => this.asked.push({ css, answer, fail }))
  }

  removeInsertedCSS(key: string): Promise<void> {
    this.removed.push(`${rendererOf(this)} ${key}`)
    return Promise.resolve()
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  /** The renderer answers the first insert at last: with its key, or with an error. */
  answer(key: string): void {
    this.first().answer(key)
  }

  fail(err: Error): void {
    this.first().fail(err)
  }

  private first() {
    const asked = this.asked[0]
    if (!asked) throw new Error('nothing was asked')
    return asked
  }
}

/** A document's end, as pages.ts keeps one per document. */
function documentEnd(): { gone: Promise<void>; leave: () => void } {
  let leave = () => {}
  const gone = new Promise<void>((resolve) => {
    leave = resolve
  })
  return { gone, leave }
}

/** What an insert came to within a moment: its sheet, null, or still waiting on the renderer. */
async function outcome(placed: Promise<PlacedSheet | null>): Promise<PlacedSheet | null | 'waiting'> {
  return Promise.race([placed, new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 50))])
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('Tweak sheets in a page (BO-02, BO-14, BO-16; fix check must-fix 1)', () => {
  it('keeps a sheet whose key comes back while its document is there', async () => {
    const page = new Page()
    const placed = insertSheet(page, 'body{color:red}', documentEnd().gone, () => true)
    expect(page.asked.map((a) => a.css)).toEqual(['body{color:red}'])
    page.answer('1')
    expect(await placed).toEqual({ key: '1', renderer: '7:1' })
    expect(page.removed).toEqual([])
  })

  it('stops waiting as its document goes, though the renderer never answers', async () => {
    const page = new Page()
    const end = documentEnd()
    const placed = insertSheet(page, 'body{color:red}', end.gone, () => true)
    expect(await outcome(placed)).toBe('waiting')
    end.leave()
    expect(await outcome(placed)).toBeNull()
  })

  it('gives a key back to its renderer once its document went', async () => {
    const page = new Page()
    let wanted = true
    const placed = insertSheet(page, 'body{color:red}', documentEnd().gone, () => wanted)
    // A new document in the same renderer asked before the key came back.
    wanted = false
    page.answer('3')
    expect(await placed).toBeNull()
    expect(page.removed).toEqual(['7:1 3'])
  })

  it('never gives a late key to another renderer, where the same key is another sheet', async () => {
    const page = new Page()
    const end = documentEnd()
    let wanted = true
    const placed = insertSheet(page, 'body{color:red}', end.gone, () => wanted)
    // The busy page's renderer is replaced (a crash and reload, or another site's page) and the new
    // document asks: the wait ends.
    page.mainFrame = { processId: 9, routingId: 4 }
    wanted = false
    end.leave()
    expect(await placed).toBeNull()
    // The old renderer answers at last, with a key that is the new document's first sheet over there.
    page.answer('1')
    await settle()
    expect(page.removed).toEqual([])
  })

  it('gives a late key back to its own renderer, after the wait ended', async () => {
    const page = new Page()
    const end = documentEnd()
    const placed = insertSheet(page, 'body{color:red}', end.gone, () => true)
    end.leave()
    expect(await placed).toBeNull()
    page.answer('5')
    await settle()
    expect(page.removed).toEqual(['7:1 5'])
  })

  it('takes a sheet out only where the renderer that gave its key still holds the page', () => {
    const page = new Page()
    removeSheet(page, { key: '2', renderer: '7:1' })
    expect(page.removed).toEqual(['7:1 2'])
    page.mainFrame = { processId: 7, routingId: 6 }
    removeSheet(page, { key: '3', renderer: '7:1' })
    page.mainFrame = { processId: 8, routingId: 1 }
    removeSheet(page, { key: '4', renderer: '7:1' })
    expect(page.removed).toEqual(['7:1 2'])
  })

  it('does nothing for a page that went', async () => {
    const page = new Page()
    page.destroyed = true
    removeSheet(page, { key: '2', renderer: '7:1' })
    expect(await insertSheet(page, 'body{color:red}', documentEnd().gone, () => true)).toBeNull()
    expect(page.asked).toEqual([])
    const gone = new Page()
    Object.defineProperty(gone, 'mainFrame', {
      get: () => {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed')
      },
    })
    expect(() => removeSheet(gone, { key: '2', renderer: '7:1' })).not.toThrow()
    expect(await insertSheet(gone, 'body{color:red}', documentEnd().gone, () => true)).toBeNull()
    expect(gone.removed).toEqual([])
  })

  it('resolves null where the sheet did not go in', async () => {
    const page = new Page()
    const placed = insertSheet(page, 'body{color:red}', documentEnd().gone, () => true)
    page.fail(new Error('Failed to send'))
    expect(await placed).toBeNull()
    expect(page.removed).toEqual([])
  })
})
