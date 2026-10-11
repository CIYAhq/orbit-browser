import { ArrowLeft, ArrowRight } from 'lucide-react'
import { type CSSProperties, useEffect, useState } from 'react'
import type { SwipeArrow } from '../../../shared/swipe'
import { invoke } from '../api'
import { useWindow } from '../store'
import { paletteVars, usePalette } from '../theme'
import './swipe.css'

/**
 * The arrow a two-finger swipe over a page slides in from the page's edge (NV-02). Main moves and
 * cuts the view as the fingers go; the arrow fills once it's fully in, when letting go goes back or
 * forward, and fades when the swipe ends.
 */
export function SwipeApp() {
  const win = useWindow()
  const palette = usePalette(win?.spaceId)
  const [arrow, setArrow] = useState<SwipeArrow | null>(null)

  useEffect(() => {
    let heard = false
    const off = window.orbit.on('swipe', (payload) => {
      heard = true
      setArrow(payload as SwipeArrow)
    })
    void invoke('pages.swipeArrow', {}).then((first) => {
      if (!heard) setArrow(first)
    })
    return off
  }, [])

  if (!arrow) return null
  const Icon = arrow.direction === 'back' ? ArrowLeft : ArrowRight
  return (
    <div
      className={`swipe-arrow is-${arrow.direction}${arrow.armed ? ' is-armed' : ''}${arrow.done ? ' is-done' : ''}`}
      style={paletteVars(palette) as CSSProperties}
      data-testid="swipe-arrow"
      data-direction={arrow.direction}
      data-armed={arrow.armed}
    >
      <div className="swipe-arrow__circle">
        <Icon size={20} strokeWidth={2.25} aria-label={arrow.direction === 'back' ? 'Back' : 'Forward'} />
      </div>
    </div>
  )
}
