import type { MediaAction, SitePipMode } from '../media'
import type { PipCorner, TabId } from '../state'

/** Owned by the media lane: picture-in-picture, sidebar media controls and call controls. */
export interface MediaCommands {
  /**
   * Play, pause, skip, seek or change the speed of a tab's media (sidebar controller MD-09, floating
   * player MD-04). `seconds`: the step for 'seek', the position for 'seekTo', the speed for 'rate'.
   */
  'media.control': { args: { tabId: TabId; action: MediaAction; seconds?: number }; result: boolean }
  /**
   * Opens (`on` true, the default) or closes picture-in-picture for a tab's video (MD-02, MD-10
   * "Back to PiP"). Without `tabId`, the calling window's selected tab. `from`: the rect (in the
   * calling window) the player grows from, e.g. the sidebar controller (MD-16). True when PiP is showing.
   */
  'media.pip': {
    args: { tabId?: TabId; on?: boolean; from?: { x: number; y: number; width: number; height: number } }
    result: boolean
  }
  /** The controller's ×: pauses the media and removes the controller (MD-09). */
  'media.dismiss': { args: { tabId: TabId }; result: void }
  /** Jumps to the source tab, switching Space if needed (MD-09). */
  'media.focus': { args: { tabId: TabId }; result: void }
  /** The controller's "…" menu: site picture-in-picture choices and more (MD-08). */
  'media.menu': { args: { tabId: TabId; x?: number; y?: number }; result: void }
  /** A site's automatic picture-in-picture choice (MD-08; for the site controls panel). */
  'media.sitePip': { args: { url: string }; result: SitePipMode }
  'media.setSitePip': { args: { url: string; mode: SitePipMode }; result: void }
  /** Call controls (MD-14): turn the page's microphone or camera off or on. True if the page allowed it. */
  'media.call': { args: { tabId: TabId; action: 'mic' | 'camera' }; result: boolean }
  /** The floating player's "Back to tab" and double-click (MD-04, MD-07). */
  'media.pipBack': { args: Record<string, never>; result: void }
  /** The floating player's ×: it closes and the media plays on in the sidebar (MD-07). */
  'media.pipClose': { args: Record<string, never>; result: void }
  /** The floating player's "…" menu at a point of the player (MD-04, MD-08). */
  'media.pipMenu': { args: { x: number; y: number }; result: void }
  /** Zooms into the player's video by `factor` around a point of the player (MD-06). Returns the zoom. */
  'media.pipZoom': { args: { factor: number; x: number; y: number }; result: number }
}

/** Fire-and-forget events from the floating player's view (pointer moves, many per second). */
export interface MediaEvents {
  /**
   * Moving ('move') or resizing (a corner) the player by pointer, and hover-scrolling it ('wheel':
   * x, y are the scroll deltas). Positions are screen DIPs (MD-06).
   */
  'media.pipGesture': {
    phase: 'start' | 'move' | 'end' | 'wheel'
    kind?: 'move' | PipCorner
    x: number
    y: number
    t?: number
  }
}
