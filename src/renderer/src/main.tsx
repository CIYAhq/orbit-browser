import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { perfMark } from './api'
import { installShortcutFallback } from './shortcuts'
import { initStore } from './store'
import './styles/global.css'

async function boot(): Promise<void> {
  const view = window.orbit.view
  // The floating player's controls (media lane): a small view of its own, without the app's shortcuts.
  if (view === 'pip') {
    const app = import('./pip/PipApp')
    await initStore()
    document.documentElement.dataset.view = view
    document.documentElement.dataset.platform = window.orbit.platform
    const { PipApp } = await app
    createRoot(document.getElementById('root') as HTMLElement).render(
      <StrictMode>
        <PipApp />
      </StrictMode>,
    )
    return
  }
  // Load the view's code while the state snapshot arrives.
  const app =
    view === 'overlay'
      ? import('./overlay/OverlayApp')
      : view === 'mini'
        ? import('./mini/MiniApp')
        : view === 'library'
          ? import('./library/LibraryApp')
          : import('./shell/ShellApp')
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
  } else if (view === 'mini') {
    const { MiniApp } = (await app) as typeof import('./mini/MiniApp')
    root.render(
      <StrictMode>
        <MiniApp />
      </StrictMode>,
    )
  } else if (view === 'library') {
    // The Library (archive lane, AR-02): its own view over the page area.
    const { LibraryApp } = (await app) as typeof import('./library/LibraryApp')
    root.render(
      <StrictMode>
        <LibraryApp />
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
