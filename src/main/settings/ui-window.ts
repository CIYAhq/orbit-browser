import type { WebContents } from 'electron'
import type { RendererView } from '../../shared/rpc'
import { loadRenderer, rendererEntry } from '../windows'

/**
 * Guards one of the settings lane's own windows (Settings, onboarding): its page never navigates
 * away or opens windows (links open as tabs through commands), and a renderer that crashes is
 * loaded again, at most three times a minute.
 */
export function guardOwnWindow(contents: WebContents, view: RendererView): void {
  contents.on('will-navigate', (event, url) => {
    const entry = rendererEntry()
    if (!(entry.url && url.startsWith(entry.url))) event.preventDefault()
  })
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  let crashes: number[] = []
  contents.on('render-process-gone', (_event, details) => {
    if (contents.isDestroyed() || details.reason === 'clean-exit') return
    const now = Date.now()
    crashes = crashes.filter((t) => now - t < 60_000)
    crashes.push(now)
    if (crashes.length > 3) return
    console.error(`[${view}] the ${view} renderer is gone (${details.reason}); reloading`)
    loadRenderer(contents, view)
  })
}
