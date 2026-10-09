import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { perfMark } from './api'
import { installShortcutFallback } from './shortcuts'
import { initStore } from './store'
import './styles/global.css'

async function boot(): Promise<void> {
  await initStore()
  installShortcutFallback()
  const view = window.orbit.view
  document.documentElement.dataset.view = view
  document.documentElement.dataset.platform = window.orbit.platform
  const root = createRoot(document.getElementById('root') as HTMLElement)
  if (view === 'overlay') {
    const { OverlayApp } = await import('./overlay/OverlayApp')
    root.render(
      <StrictMode>
        <OverlayApp />
      </StrictMode>,
    )
  } else if (view === 'strip') {
    // Split view pane strip (split lane, SV-12): a tiny transparent view over a pane's top edge.
    const { PaneStripApp } = await import('./shell/split/PaneStripApp')
    root.render(
      <StrictMode>
        <PaneStripApp />
      </StrictMode>,
    )
  } else {
    const { ShellApp } = await import('./shell/ShellApp')
    root.render(
      <StrictMode>
        <ShellApp />
      </StrictMode>,
    )
    requestAnimationFrame(() => perfMark('shell:first-frame'))
  }
}

void boot()
