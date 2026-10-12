import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installShortcutFallback } from '../shortcuts'
import { initStore } from '../store'
import { loadBuildInfo } from './build-info'

/**
 * The settings lane's windows: Settings (ST-01) and first-run onboarding (OB-01). They don't load
 * the browser shell's code.
 */
export function isSettingsLaneView(view: string): boolean {
  return view === 'settings' || view === 'onboarding'
}

export async function bootSettingsLaneView(): Promise<void> {
  const onboarding = window.orbit.view === 'onboarding'
  const app = onboarding ? import('../onboarding/OnboardingApp') : import('./SettingsApp')
  // Settings draws About's version, engine and build date in its first frame (ST-17).
  const details = onboarding ? undefined : loadBuildInfo()
  await initStore()
  await details
  installShortcutFallback()
  document.title = onboarding ? 'Welcome to Orbit' : 'Settings'
  document.documentElement.dataset.view = window.orbit.view
  document.documentElement.dataset.platform = window.orbit.platform
  const root = createRoot(document.getElementById('root') as HTMLElement)
  if (onboarding) {
    const { OnboardingApp } = (await app) as typeof import('../onboarding/OnboardingApp')
    root.render(
      <StrictMode>
        <OnboardingApp />
      </StrictMode>,
    )
  } else {
    const { SettingsApp } = (await app) as typeof import('./SettingsApp')
    root.render(
      <StrictMode>
        <SettingsApp />
      </StrictMode>,
    )
  }
}
