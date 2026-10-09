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
  const themeRef = useShellTheme(win?.spaceId)
  if (!win) return null
  const style = { '--sidebar-w': `${win.sidebar.width}px` } as CSSProperties
  return (
    <div
      className={`shell${win.sidebar.visible ? '' : ' shell--sidebar-hidden'}${win.focused ? '' : ' shell--blurred'}`}
      style={style}
      ref={themeRef}
      data-testid="shell"
    >
      <Sidebar win={win} />
      <ContentArea win={win} />
      <Toasts />
    </div>
  )
}
