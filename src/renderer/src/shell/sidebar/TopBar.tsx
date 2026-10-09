import { PanelLeft } from 'lucide-react'
import type { WindowState } from '../../../../shared/state'
import { isMac, runAction } from '../../api'
import { Address } from '../chrome/Address'
import { NavButtons } from '../chrome/NavButtons'
import { withShortcut } from '../chrome/shortcut-label'
import { WindowControls } from '../chrome/WindowControls'
import '../chrome/chrome.css'

/**
 * The top of the sidebar (SB-03, SB-04): window controls (traffic lights on macOS), the sidebar
 * toggle, Back, Forward and Reload, then the address display. At narrow widths the toggle goes
 * first; Back and Forward stay.
 */
export function TopBar({ win }: { win: WindowState }) {
  return (
    <div className={`topbar${isMac ? ' topbar--mac' : ''}`} data-testid="topbar">
      <div className="topbar__row">
        {isMac ? <div className="topbar__traffic-space" data-testid="traffic-space" /> : <WindowControls />}
        <div className="topbar__spacer" />
        <button
          type="button"
          className="icon-button topbar__toggle"
          aria-label="Toggle sidebar"
          title={withShortcut('Hide sidebar', 'sidebar.toggle')}
          data-testid="toggle-sidebar"
          onClick={() => runAction('sidebar.toggle')}
        >
          <PanelLeft size={16} />
        </button>
        <NavButtons windowId={win.id} />
      </div>
      <Address windowId={win.id} />
    </div>
  )
}
