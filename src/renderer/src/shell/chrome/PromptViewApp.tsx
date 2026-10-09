import { type CSSProperties, useCallback, useRef } from 'react'
import { invoke } from '../../api'
import { useWindow } from '../../store'
import { paletteVars, usePalette } from '../../theme'
import { PermissionPrompt, useActivePrompt } from './PermissionPrompt'
import './chrome.css'

/**
 * The permission prompt while the sidebar is hidden (NV-15): a small transparent view main keeps
 * over the active page's top-left corner. It holds the active tab's prompt and tells main how tall
 * the card is, so the view fits it.
 */
export function PromptViewApp() {
  const win = useWindow()
  const palette = usePalette(win?.spaceId)
  const prompt = useActivePrompt(window.orbit.windowId)
  const said = useRef(0)
  const onSize = useCallback((height: number) => {
    const rounded = Math.ceil(height)
    if (rounded <= 0 || rounded === said.current) return
    said.current = rounded
    void invoke('permissions.promptSize', { height: rounded })
  }, [])
  return (
    <div className="prompt-view" style={paletteVars(palette) as CSSProperties} data-testid="prompt-view">
      {prompt && <PermissionPrompt key={prompt.id} prompt={prompt} onSize={onSize} />}
    </div>
  )
}
