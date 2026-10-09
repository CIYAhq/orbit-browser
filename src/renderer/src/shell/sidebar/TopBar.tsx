import { ArrowLeft, ArrowRight, Lock, PanelLeft, RotateCw, X } from 'lucide-react'
import type { WindowState } from '../../../../shared/state'
import { displayHost } from '../../../../shared/url'
import { invoke, isMac, runAction } from '../../api'
import { activeTabId } from '../../selectors'
import { useOrbit } from '../../store'

/** Window controls, navigation buttons and the address pill. */
export function TopBar({ win }: { win: WindowState }) {
  const tab = useOrbit((s) => {
    const id = activeTabId(s, win.id)
    return id ? s.tabs[id] : undefined
  })
  const host = tab ? displayHost(tab.url) : ''
  const secure = tab?.url.startsWith('https://')
  return (
    <div className="topbar">
      <div className="topbar__row">
        {isMac ? <div className="topbar__traffic-space" /> : <WindowControls />}
        <div className="topbar__spacer" />
        <IconButton label="Toggle sidebar" testId="toggle-sidebar" onClick={() => runAction('sidebar.toggle')}>
          <PanelLeft size={16} />
        </IconButton>
        <IconButton label="Back" testId="nav-back" disabled={!tab?.canGoBack} onClick={() => runAction('nav.back')}>
          <ArrowLeft size={16} />
        </IconButton>
        <IconButton
          label="Forward"
          testId="nav-forward"
          disabled={!tab?.canGoForward}
          onClick={() => runAction('nav.forward')}
        >
          <ArrowRight size={16} />
        </IconButton>
        <IconButton
          label={tab?.loading ? 'Stop' : 'Reload'}
          testId="nav-reload"
          disabled={!tab}
          onClick={() => runAction(tab?.loading ? 'nav.stop' : 'nav.reload')}
        >
          {tab?.loading ? <X size={16} /> : <RotateCw size={15} />}
        </IconButton>
      </div>
      <button
        type="button"
        className={`address${tab?.loading ? ' address--loading' : ''}`}
        data-testid="address-pill"
        onClick={() => runAction('url.edit')}
        title={tab?.url}
      >
        {secure && <Lock size={11} className="address__lock" />}
        <span className="address__host">{host || 'Search or enter address'}</span>
      </button>
    </div>
  )
}

function IconButton(props: {
  label: string
  testId?: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={props.label}
      title={props.label}
      data-testid={props.testId}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

function WindowControls() {
  return (
    <div className="window-controls">
      <button
        type="button"
        aria-label="Close window"
        className="window-controls__btn window-controls__btn--close"
        onClick={() => void invoke('window.control', { op: 'close' })}
      />
      <button
        type="button"
        aria-label="Minimize window"
        className="window-controls__btn window-controls__btn--min"
        onClick={() => void invoke('window.control', { op: 'minimize' })}
      />
      <button
        type="button"
        aria-label="Maximize window"
        className="window-controls__btn window-controls__btn--max"
        onClick={() => void invoke('window.control', { op: 'maximize' })}
      />
    </div>
  )
}
