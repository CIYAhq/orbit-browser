import type { CSSProperties } from 'react'
import { useWindow } from '../store'
import { paletteVars, usePalette } from '../theme'
import { ContentArea } from './ContentArea'
import { Sidebar } from './sidebar/Sidebar'
import { Toasts } from './Toasts'

/** The browser window chrome: sidebar + content frame. Tab pages are native views drawn over the frame. */
export function ShellApp() {
  const win = useWindow()
  const palette = usePalette(win?.spaceId)
  if (!win) return null
  const style = { ...paletteVars(palette), '--sidebar-w': `${win.sidebar.width}px` } as CSSProperties
  return (
    <div
      className={`shell${win.sidebar.visible ? '' : ' shell--sidebar-hidden'}${win.focused ? '' : ' shell--blurred'}`}
      style={style}
      data-testid="shell"
    >
      <Sidebar win={win} />
      <ContentArea win={win} />
      <Toasts />
    </div>
  )
}
