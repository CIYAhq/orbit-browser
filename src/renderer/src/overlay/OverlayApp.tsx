import { AnimatePresence, domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import type { CSSProperties } from 'react'
import { invoke } from '../api'
import { useWindow } from '../store'
import { paletteVars, usePalette } from '../theme'
import { CommandBar } from './CommandBar'

/**
 * Transparent full-window layer above the tab views. It is only visible while
 * something is open (command bar, Peek chrome, menus); clicking the backdrop closes it.
 * Children animate out (AnimatePresence) while main keeps the view up briefly.
 */
export function OverlayApp() {
  const win = useWindow()
  const palette = usePalette(win?.spaceId)
  const overlay = win?.overlay
  const kind = overlay?.kind ?? 'none'
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">
        <div
          className={`overlay overlay--${kind}`}
          style={paletteVars(palette) as CSSProperties}
          data-testid="overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && kind !== 'none') void invoke('overlay.close', {})
          }}
        >
          <AnimatePresence>
            {overlay?.kind === 'commandbar' && (
              <CommandBar key={overlay.nonce} mode={overlay.mode} initialQuery={overlay.query} dark={palette?.dark} />
            )}
          </AnimatePresence>
        </div>
      </MotionConfig>
    </LazyMotion>
  )
}
