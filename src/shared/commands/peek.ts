import type { Rect } from '../rpc'
import type { ProfileId, SpaceId, TabId, WindowId } from '../state'

/** Owned by the peek lane: link previews (Peek, PK-*) and Mini Windows (MW-*). */
export interface PeekCommands {
  /** Opens a URL in a Peek card over the window's current tab (PK-01). Returns the Peek's tab. */
  'peek.open': { args: { url: string }; result: TabId | null }
  /** Closes the window's Peek (PK-09). It can be reopened (PK-10). */
  'peek.close': { args: Record<string, never>; result: void }
  /** Turns the Peek into a selected Today tab, keeping the live page (PK-07). */
  'peek.expand': { args: Record<string, never>; result: void }
  /** Turns the source tab and the Peek page into a split (PK-08). */
  'peek.split': { args: Record<string, never>; result: void }
  /** The overlay finished animating a Peek out (closing, expanding): main commits it now. */
  'peek.settled': { args: { nonce: number }; result: void }

  /** Opens a Mini Window with a page, or blank with the lookup bar (MW-06). Returns its window id. */
  'mini.open': { args: { url?: string }; result: WindowId }
  /**
   * ⌘⌥-click on a sidebar row (MW-07): a Today tab moves into a new Mini Window, live (it leaves
   * the sidebar); a pinned tab or Favorite stays and opens its page there. Returns the window.
   */
  'mini.fromTab': { args: { tabId: TabId }; result: WindowId | null }
  /**
   * Readies a hidden blank Mini Window, so the next one shows a working lookup bar at once
   * (MW-15). Orbit does this a moment after launch; the e2e harness asks for it instead.
   */
  'mini.prepare': { args: Record<string, never>; result: void }
  /** Loads what was typed in a Mini Window's lookup bar or address field (MW-06). */
  'mini.navigate': { args: { input: string }; result: void }
  /** Moves the Mini Window's page into a Space (most recent by default) and closes it (MW-05). */
  'mini.moveToSpace': { args: { spaceId?: SpaceId; pinned?: boolean }; result: void }
  /** Reopens the Mini Window's page in another profile and remembers it for the site (MW-10). */
  'mini.setProfile': { args: { profileId: ProfileId }; result: void }
  /**
   * Shows a Mini Window menu at a point (window coordinates): "Open in…" lists the Spaces of the
   * page's profile (MW-05), "profile" the profiles to reopen the page in (MW-10).
   */
  'mini.menu': { args: { menu: 'open-in' | 'profile'; x: number; y: number }; result: void }
  /** Window buttons of a Mini Window (its page is archived on close, MW-09). */
  'mini.control': { args: { op: 'close' | 'minimize' | 'maximize' }; result: void }
  /** Gives the keyboard back to the Mini Window's page: Esc in its address field (KS-16, KS-20). */
  'mini.focusPage': { args: Record<string, never>; result: void }
  /**
   * The command bar over the Mini Window's page opened or closed (CB-23). While it is open it
   * takes ⌘W and ⌘L first (KS-19). Opening returns a still image of the page (a data URL) for
   * the card while the bar's list covers it; closing shows the page again.
   */
  'mini.bar': { args: { open: boolean }; result: string | null }
  /** Hides the page's view while the bar is open, once the card shows its still image (CB-23). */
  'mini.hidePage': { args: Record<string, never>; result: void }
  /**
   * Find in the Mini Window's page (NV-05): `query` as typed, or the next (`next`) match forward or
   * back. Results come as `mini:find-result`.
   */
  'mini.find': { args: { query: string; next?: boolean; forward?: boolean }; result: void }
  /** The find field closed: the match stays selected, and the page gets the keyboard back unless `keepFocus`. */
  'mini.findClose': { args: { keepFocus?: boolean }; result: void }
}

export interface PeekEvents {
  /** Where the overlay draws the Peek card this frame (page-area coordinates), so its page view follows. */
  'peek.frame': { nonce: number; rect: Rect; radius: number; visible: boolean }
  /** Where a Mini Window's page card is (window coordinates, DIP). */
  'mini.layout': { rect: Rect; radius: number }
  /**
   * A Mini Window's UI took the open grow's starting size (MW-04): main shows the window now, and
   * the grow takes `ms`.
   */
  'mini.growReady': { ms: number }
}
