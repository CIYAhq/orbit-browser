import { createContext, useContext } from 'react'
import type { SettingsContext, SettingsTarget } from '../../../shared/commands/settings'
import { DEFAULT_PROFILE_ID } from '../../../shared/defaults'

export interface SettingsView {
  /** The browser window and profile Settings acts for (the window it was opened from). */
  context: SettingsContext
  /** What the last `settings.open` asked to show (a section, an item, a profile). */
  target: SettingsTarget
  /** Changes each time Settings is opened again. */
  nonce: number
}

export const SettingsViewContext = createContext<SettingsView>({
  context: { profileId: DEFAULT_PROFILE_ID },
  target: {},
  nonce: 0,
})

/** The window, profile and target Settings was opened with, for section pages. */
export function useSettingsContext(): SettingsView {
  return useContext(SettingsViewContext)
}
