import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installShortcutFallback } from '../shortcuts'
import { initStore } from '../store'

/** The settings lane's windows: Settings (ST-01). They don't load the browser shell's code. */
export function isSettingsLaneView(view: string): boolean {
  return view === 'settings'
}

export async function bootSettingsLaneView(): Promise<void> {
  const app = import('./SettingsApp')
  await initStore()
  installShortcutFallback()
  document.title = 'Settings'
  document.documentElement.dataset.view = window.orbit.view
  document.documentElement.dataset.platform = window.orbit.platform
  const { SettingsApp } = await app
  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <SettingsApp />
    </StrictMode>,
  )
}
