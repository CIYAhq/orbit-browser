import { PanelLeft } from 'lucide-react'
import type { WindowState } from '../../../../shared/state'
import { isMac, runAction } from '../../api'
import { useKeymap } from '../../keys/live'
import { Address } from '../chrome/Address'
import { NavButtons } from '../chrome/NavButtons'
import { PermissionPrompt, useActivePrompt } from '../chrome/PermissionPrompt'
import { withShortcut } from '../chrome/shortcut-label'
import { WindowControls } from '../chrome/WindowControls'
import { SplitButton } from '../split/SplitButton'
import '../chrome/chrome.css'

/**
 * The top of the sidebar (SB-03, SB-04): window controls (traffic lights on macOS; elsewhere with
 * the split button beside them, SV-07), the sidebar toggle, Back, Forward and Reload, then the
 * address display. At narrow widths the split button goes first, then the toggle; Back and Forward
 * stay. In the floating card (SB-12) the toggle docks the sidebar again.
 * A site's permission prompt hangs under the address display (NV-15).
 */
export function TopBar({ win, floating = false }: { win: WindowState; floating?: boolean }) {
  // The tooltips follow remapped shortcuts (KS-18).
  useKeymap()
  const prompt = useActivePrompt(win.id)
  return (
    <div className={`topbar${isMac ? ' topbar--mac' : ''}${prompt ? ' has-prompt' : ''}`} data-testid="topbar">
      <div className="topbar__row">
        {isMac ? (
          <div className="topbar__traffic-space" data-testid="traffic-space" />
        ) : (
          <>
            <WindowControls />
            <SplitButton />
          </>
        )}
        <div className="topbar__spacer" />
        <button
          type="button"
          className="icon-button topbar__toggle"
          aria-label="Toggle sidebar"
          title={withShortcut(floating ? 'Show sidebar' : 'Hide sidebar', 'sidebar.toggle')}
          data-testid="toggle-sidebar"
          onClick={() => runAction('sidebar.toggle')}
        >
          <PanelLeft size={16} />
        </button>
        <NavButtons windowId={win.id} />
      </div>
      <Address windowId={win.id} />
      {prompt && (
        <div className="perm-prompt-anchor">
          <PermissionPrompt key={prompt.id} prompt={prompt} />
        </div>
      )}
    </div>
  )
}
