import { Paintbrush } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTweakSite } from './site'

/** An entry of the sidebar's + menu (src/renderer/src/shell/spaces/SpacePanels.tsx). */
interface PlusEntry {
  id: string
  label: string
  icon: ReactNode
  disabled: boolean
  run: () => void
}

/**
 * The + menu's "New Tweak…" (BO-01): for the window's shown page, greyed where it isn't a website
 * Tweaks can change, and gone while Tweaks are off (BO-16). Returns a function of the entry's run.
 */
export function useTweakMenuEntry(windowId: string): (run: () => void) => PlusEntry[] {
  const site = useTweakSite(windowId)
  return (run) =>
    site.allowed
      ? [{ id: 'plus-tweak', label: 'New Tweak…', icon: <Paintbrush size={14} />, disabled: !site.host, run }]
      : []
}
