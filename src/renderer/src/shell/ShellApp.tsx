import type { CSSProperties } from 'react'
import { useWindow } from '../store'
import { useShellTheme } from '../theme'
import { ContentArea } from './ContentArea'
import { Sidebar } from './sidebar/Sidebar'
import { Toasts } from './Toasts'

/** The browser window chrome: sidebar + content frame. Tab pages are native views drawn over the frame. */
export function ShellApp() {
  const win = useWindow()
  // The Space theme is painted as CSS variables by the theme driver (no re-render per frame).
  const theme = useShellTheme(win?.spaceId)
  if (!win) return null
  const style = { '--sidebar-w': `${win.sidebar.width}px` } as CSSProperties
  return (
    <div
      className={`shell${win.sidebar.visible ? '' : ' shell--sidebar-hidden'}${win.focused ? '' : ' shell--blurred'}`}
      style={style}
      ref={theme.shellRef}
      data-testid="shell"
    >
      <div className="shell-bg" ref={theme.backgroundRef} aria-hidden>
        <div className="shell-bg__grain" />
      </div>
      <Sidebar win={win} />
      <ContentArea win={win} />
      <Toasts />
    </div>
  )
}
