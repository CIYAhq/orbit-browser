import type { Rect } from '../rpc'
import type { OverlayState, TabId } from '../state'

/** Owned by the lead: app, window chrome, overlay and action plumbing. */
export interface CoreCommands {
  'action.run': { args: { id: string }; result: void }
  'overlay.open': {
    args: { overlay: DistributiveOmit<Exclude<OverlayState, { kind: 'none' }>, 'nonce'> }
    result: void
  }
  'overlay.close': { args: { refocus?: boolean }; result: void }
  'window.setSidebar': { args: { visible?: boolean; width?: number; peeking?: boolean }; result: void }
  'window.control': { args: { op: 'minimize' | 'maximize' | 'close' }; result: void }
  'app.info': {
    args: Record<string, never>
    result: { version: string; platform: string; electron: string; chrome: string; e2e: boolean }
  }
}

export interface CoreEvents {
  /** Shell reports where each visible tab's page should be drawn (window coordinates, DIP). */
  'layout.panes': { panes: { tabId: TabId; rect: Rect }[]; radius: number; seq: number }
  /** Renderer-side performance marks (used by perf scripts and tests). */
  'perf.mark': { name: string; t: number }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
