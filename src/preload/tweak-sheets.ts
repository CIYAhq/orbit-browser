/**
 * The page preload's first-paint Tweak sheets (BO-18; D40 (3), D85), kept apart from Electron so a
 * unit test can drive them with a stand-in frame.
 *
 * The sheets go into the page as injected author sheets (`webFrame.insertCSS`), as main's own copies
 * do: the page can't read them, can't remove them, and can't outrank them with layered `!important`
 * rules (an injected sheet comes before the page's own, so the Tweaks' layer is the first declared).
 * Their keys stay in the preload's own world. Once main's copies are in, main says so with the number
 * it gave this document's read (`PAGE_CHANNEL.tweakRetire`), and the sheets go; a number from any
 * other document's read takes nothing.
 */
import type { TweakSheetsAnswer } from '../shared/site'

/** What of Electron's `webFrame` the sheets need. */
export interface SheetFrame {
  insertCSS(css: string, options: { cssOrigin: 'author' }): string
  removeInsertedCSS(key: string): void
}

/** Main's answer to the read, checked: null when it brings nothing to insert. */
export function tweakAnswer(value: unknown): TweakSheetsAnswer | null {
  if (!value || typeof value !== 'object') return null
  const { doc, sheets } = value as Record<string, unknown>
  if (typeof doc !== 'number' || !Number.isSafeInteger(doc) || !Array.isArray(sheets)) return null
  const css = sheets.filter((sheet): sheet is string => typeof sheet === 'string')
  return css.length > 0 ? { doc, sheets: css } : null
}

/**
 * Inserts the answer's sheets into the frame's document. Returns what main's retire message does:
 * with this document's number it takes the sheets out and says true (once); with any other it does
 * nothing and says false.
 */
export function insertTweakSheets(frame: SheetFrame, answer: TweakSheetsAnswer): (doc: unknown) => boolean {
  const keys: string[] = []
  for (const css of answer.sheets) {
    try {
      keys.push(frame.insertCSS(css, { cssOrigin: 'author' }))
    } catch {
      // A sheet the engine refused: the others still go in.
    }
  }
  let retired = false
  return (doc) => {
    if (retired || doc !== answer.doc) return false
    retired = true
    for (const key of keys.splice(0)) {
      try {
        frame.removeInsertedCSS(key)
      } catch {
        // The document is going: its sheets go with it.
      }
    }
    return true
  }
}
