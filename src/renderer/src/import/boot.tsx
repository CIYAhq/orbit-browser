import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installShortcutFallback } from '../shortcuts'
import { initStore } from '../store'

/** The import window (IM-01): a window of its own, without the browser shell's code. */
export async function bootImport(): Promise<void> {
  const app = import('./ImportApp')
  await initStore()
  installShortcutFallback()
  document.title = 'Import'
  document.documentElement.dataset.view = 'import'
  document.documentElement.dataset.platform = window.orbit.platform
  const { ImportApp } = await app
  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <ImportApp />
    </StrictMode>,
  )
}
