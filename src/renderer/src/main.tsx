import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { perfMark } from './api'
import { installShortcutFallback } from './shortcuts'
import { initStore } from './store'
import './styles/global.css'

async function boot(): Promise<void> {
  const view = window.orbit.view
  // Load the view's code while the state snapshot arrives.
  const app = view === 'overlay' ? import('./overlay/OverlayApp') : import('./shell/ShellApp')
  await initStore()
  installShortcutFallback()
  document.documentElement.dataset.view = view
  document.documentElement.dataset.platform = window.orbit.platform
  const root = createRoot(document.getElementById('root') as HTMLElement)
  if (view === 'overlay') {
    const { OverlayApp } = (await app) as typeof import('./overlay/OverlayApp')
    root.render(
      <StrictMode>
        <OverlayApp />
      </StrictMode>,
    )
  } else {
    const { ShellApp } = (await app) as typeof import('./shell/ShellApp')
    root.render(
      <StrictMode>
        <ShellApp />
      </StrictMode>,
    )
    requestAnimationFrame(() => perfMark('shell:first-frame'))
  }
}

void boot()
