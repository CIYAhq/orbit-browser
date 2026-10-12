import { describe, expect, it } from 'vitest'
import { insertTweakSheets, type SheetFrame, tweakAnswer } from '../../src/preload/tweak-sheets'

/** A stand-in for Electron's `webFrame`: the sheets in its document, by key. */
function frame(): SheetFrame & { sheets: Map<string, { css: string; origin: string }> } {
  const sheets = new Map<string, { css: string; origin: string }>()
  let next = 0
  return {
    sheets,
    insertCSS: (css, options) => {
      const key = `k${++next}`
      sheets.set(key, { css, origin: options.cssOrigin })
      return key
    },
    removeInsertedCSS: (key) => {
      sheets.delete(key)
    },
  }
}

const SHEETS = ['@layer orbit-tweaks {\n  body { background: #202020 !important; }\n}', '@layer orbit-tweaks {}']

describe('the page preload’s first-paint Tweak sheets (BO-18, D85)', () => {
  it('reads only an answer with a document number and some CSS', () => {
    expect(tweakAnswer({ doc: 3, sheets: SHEETS })).toEqual({ doc: 3, sheets: SHEETS })
    expect(tweakAnswer({ doc: 3, sheets: [SHEETS[0], 7, null] })).toEqual({ doc: 3, sheets: [SHEETS[0]] })
    for (const value of [
      null,
      undefined,
      [],
      SHEETS,
      { sheets: SHEETS },
      { doc: '3', sheets: SHEETS },
      { doc: 1.5, sheets: SHEETS },
      { doc: 3, sheets: [] },
      { doc: 3, sheets: [1, 2] },
      { doc: 3, sheets: 'body {}' },
    ]) {
      expect(tweakAnswer(value), JSON.stringify(value)).toBeNull()
    }
  })

  it('inserts each sheet as an author sheet, and takes them out on its own document’s retire only', () => {
    const f = frame()
    const retire = insertTweakSheets(f, { doc: 4, sheets: SHEETS })
    expect([...f.sheets.values()]).toEqual(SHEETS.map((css) => ({ css, origin: 'author' })))

    // Another document's number, or anything else, takes nothing.
    for (const other of [3, 5, '4', null, undefined, { doc: 4 }]) {
      expect(retire(other)).toBe(false)
      expect(f.sheets.size).toBe(2)
    }

    // Its own: every sheet goes, once.
    expect(retire(4)).toBe(true)
    expect(f.sheets.size).toBe(0)
    expect(retire(4)).toBe(false)
  })

  it('leaves the page’s other injected sheets alone, and a sheet the engine refuses doesn’t stop the rest', () => {
    const f = frame()
    const theirs = f.insertCSS('p { color: red }', { cssOrigin: 'author' })
    const insert = f.insertCSS
    f.insertCSS = (css, options) => {
      if (css === SHEETS[0]) throw new Error('refused')
      return insert(css, options)
    }
    const retire = insertTweakSheets(f, { doc: 9, sheets: SHEETS })
    expect([...f.sheets.values()].map((s) => s.css)).toEqual(['p { color: red }', SHEETS[1]])
    expect(retire(9)).toBe(true)
    expect([...f.sheets.keys()]).toEqual([theirs])
  })
})
