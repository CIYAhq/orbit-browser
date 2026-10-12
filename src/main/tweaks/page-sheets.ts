/**
 * Main's own Tweak sheets in a page (BO-18, D85; tweaks fix check, must-fix 1). Each goes in with
 * `insertCSS`, a round trip to the renderer that holds the page as it is sent, and comes out with
 * `removeInsertedCSS` and the key that renderer gave it.
 * - Keys count 1, 2, … in each renderer, so a key means nothing to another: it goes back only to the
 *   renderer that gave it. One from a renderer that no longer holds the page went with its document.
 * - A renderer may answer late, or never: it crashed, or another site's page took its place while it
 *   was busy. The wait for it ends as its document goes, so it holds up nothing for the next one.
 */

/** What main uses of a page's web contents here. */
export interface SheetPage {
  insertCSS(css: string, options: { cssOrigin: 'author' }): Promise<string>
  removeInsertedCSS(key: string): Promise<void>
  isDestroyed(): boolean
  readonly mainFrame: { readonly processId: number; readonly routingId: number }
}

/** A sheet main put in a page: its key, and the renderer that gave it. */
export interface PlacedSheet {
  key: string
  renderer: string
}

/** The renderer that holds a page's main frame now. */
export const rendererOf = (page: SheetPage): string => `${page.mainFrame.processId}:${page.mainFrame.routingId}`

/** Takes a sheet out of its page, if the renderer that gave its key still holds the page. */
export function removeSheet(page: SheetPage, sheet: PlacedSheet): void {
  try {
    if (page.isDestroyed() || rendererOf(page) !== sheet.renderer) return
    page.removeInsertedCSS(sheet.key).catch(() => {})
  } catch {
    // The page's frame went, and the sheet with it.
  }
}

/**
 * Puts a sheet in a page. Resolves with it once it is in, or with null:
 * - where it didn't go in;
 * - where `wanted()` says no as its key comes back (its document went meanwhile);
 * - as soon as `gone` settles (its document went: a new one asked, or the renderer went), without
 *   waiting for the renderer's answer.
 * A key that isn't kept comes out again, whenever it comes back, as `removeSheet` takes one out.
 */
export function insertSheet(
  page: SheetPage,
  css: string,
  gone: Promise<unknown>,
  wanted: () => boolean,
): Promise<PlacedSheet | null> {
  return new Promise((resolve) => {
    let waiting = true
    const done = (sheet: PlacedSheet | null) => {
      if (!waiting) return
      waiting = false
      resolve(sheet)
    }
    void gone.then(() => done(null))
    let renderer: string
    let sent: Promise<string>
    try {
      if (page.isDestroyed()) return done(null)
      renderer = rendererOf(page)
      sent = page.insertCSS(css, { cssOrigin: 'author' })
    } catch {
      return done(null)
    }
    sent.then(
      (key) => {
        const sheet = { key, renderer }
        if (waiting && wanted()) return done(sheet)
        done(null)
        removeSheet(page, sheet)
      },
      () => done(null),
    )
  })
}
