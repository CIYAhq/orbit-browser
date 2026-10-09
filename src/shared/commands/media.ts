import type { MediaAction, SitePipMode } from '../media'
import type { TabId } from '../state'

/** Owned by the media lane: picture-in-picture, sidebar media controls and call controls. */
export interface MediaCommands {
  /** Play, pause, skip or seek a tab's media from the sidebar controller (MD-09). `seconds` is for 'seek'. */
  'media.control': { args: { tabId: TabId; action: MediaAction; seconds?: number }; result: boolean }
  /**
   * Opens (`on` true, the default) or closes picture-in-picture for a tab's video (MD-02, MD-10
   * "Back to PiP"). Without `tabId`, the calling window's selected tab. True when PiP is showing.
   */
  'media.pip': { args: { tabId?: TabId; on?: boolean }; result: boolean }
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
}
