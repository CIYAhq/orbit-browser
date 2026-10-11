import type { MouseEvent as ReactMouseEvent } from 'react'
import type { RowMenuAt } from '../../../../shared/row-menu'

/**
 * Where a row's menu opens (TB-14): at the pointer for a right-click; for the keyboard's menu key,
 * under the row's slot (`[data-slot][data-key]`), which is there even while the row isn't drawn
 * (FL-21). A Favorite tile has no slot: under the tile.
 */
export function menuAt(e: ReactMouseEvent, key: string): RowMenuAt {
  const native = e.nativeEvent as PointerEvent
  const keyboard = native.pointerType === '' || (e.clientX === 0 && e.clientY === 0)
  if (!keyboard) return { x: Math.round(e.clientX), y: Math.round(e.clientY) }
  const slot =
    document.querySelector(`[data-slot][data-key="${CSS.escape(key)}"]`) ?? (e.currentTarget as Element | null)
  const r = slot?.getBoundingClientRect()
  return r ? { x: Math.round(r.left + 16), y: Math.round(r.bottom) } : { x: 0, y: 0 }
}
