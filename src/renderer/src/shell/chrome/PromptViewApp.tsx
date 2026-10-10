import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '../../api'
import { useWindow } from '../../store'
import { paletteVars, usePalette } from '../../theme'
import { PermissionPrompt, useActivePrompt } from './PermissionPrompt'
import './chrome.css'

/**
 * The permission prompt while the sidebar is hidden (NV-15): a small transparent view main keeps
 * over the active page's top-left corner. It holds the active tab's prompt and tells main how tall
 * the card is, so the view fits it. Main says when it puts the view on screen and takes it off
 * (`prompt:placed`), where under the Library counts as off: the card's choices wait a moment each
 * time it shows (`PromptGuard`), since the page knows where it will.
 */
export function PromptViewApp() {
  const win = useWindow()
  const palette = usePalette(win?.spaceId)
  const prompt = useActivePrompt(window.orbit.windowId)
  const said = useRef(0)
  // Off screen until main says: the view can be made under the Library (fix check B, M1).
  const [placement, setPlacement] = useState({ placed: false, n: 0 })
  useEffect(() => {
    let heard = false
    const off = window.orbit.on('prompt:placed', (placed) => {
      heard = true
      setPlacement((was) => ({ placed: placed === true, n: was.n + 1 }))
    })
    // What main said before this page listened is lost: ask where the view is now.
    void invoke('permissions.promptPlaced', {}).then((placed) => {
      if (!heard) setPlacement((was) => (was.placed === placed ? was : { placed, n: was.n + 1 }))
    })
    return off
  }, [])
  const onSize = useCallback((height: number) => {
    const rounded = Math.ceil(height)
    if (rounded <= 0 || rounded === said.current) return
    said.current = rounded
    void invoke('permissions.promptSize', { height: rounded })
  }, [])
  return (
    <div className="prompt-view" style={paletteVars(palette) as CSSProperties} data-testid="prompt-view">
      {prompt && (
        <PermissionPrompt
          key={prompt.id}
          prompt={prompt}
          onSize={onSize}
          shown={placement.placed}
          shownKey={placement.n}
        />
      )}
    </div>
  )
}
