import type { MouseInputEvent } from 'electron'
import type { TabId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'

/** The floating pane strip (close + split controls) shown when hovering a pane's top edge (SV-12). */
export class PaneStrip {
  constructor(private ctx: MainContext) {}

  onPageMouse(_tabId: TabId, _mouse: MouseInputEvent): void {}

  setHovered(_windowId: WindowId | undefined, _hovered: boolean): void {}
}
