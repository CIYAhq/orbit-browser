import type { ProfileId, Settings, SpaceId, WindowId } from '../state'

/**
 * Owned by the settings lane: the Settings window (ST-*), the global appearance (AP-01),
 * onboarding (OB-*) and updates (UP-*).
 */

/** Which browser window, Space and profile the Settings window acts for (ST-01, ST-07, ST-20). */
export interface SettingsContext {
  /** The browser window Settings was last opened from, while that window is open. */
  windowId?: WindowId
  /** That window's Space: Settings takes its theme colours (ST-01). */
  spaceId?: SpaceId
  /** The profile per-profile settings open for: the Space's profile, else the Default profile. */
  profileId: ProfileId
}

/** Where `settings.open` goes. */
export interface SettingsTarget {
  /** A section id from the Settings section registry (src/renderer/src/settings/registry.ts). */
  section?: string
  /** One setting in it to scroll to and highlight: the `id` of its `<SettingRow>` (ST-02). */
  item?: string
  /** The profile the Profiles section shows (ST-04); the opener's by default. */
  profileId?: ProfileId
}

/** Sent to the Settings window each time it is opened again (`window.orbit.on('settings.reveal', …)`). */
export interface SettingsReveal {
  target: SettingsTarget
  context: SettingsContext
  nonce: number
}

/**
 * The global settings `settings.update` may change. Main validates every value
 * (src/main/settings/validate.ts) and ignores keys it does not know.
 */
export type SettingsPatch = Partial<
  Pick<
    Settings,
    | 'appearance'
    | 'settingsSection'
    | 'peekExternalLinks'
    | 'peekShiftClick'
    | 'miniWindowForExternalLinks'
    | 'externalLinksSpace'
    | 'miniWindowArchiveAfterMs'
    | 'autoPip'
    | 'searchSuggestions'
    | 'searchTopResult'
  >
>

/** What About shows and "Copy build info" copies (ST-17). */
export interface BuildInfo {
  version: string
  electron: string
  chrome: string
  node: string
  v8: string
  /** e.g. "macOS 15.1", "Linux 6.8.0". */
  os: string
  arch: string
}

export interface SettingsCommands {
  /** Opens the one Settings window, or brings it to the front (ST-01), at a section or item (ST-02). */
  'settings.open': { args: SettingsTarget; result: void }
  'settings.close': { args: Record<string, never>; result: void }
  /** What Settings shows and acts for: the window it was opened from and the last target. */
  'settings.context': { args: Record<string, never>; result: SettingsReveal }
  /** Changes global settings; they apply at once and persist (ST-01). */
  'settings.update': { args: SettingsPatch; result: void }
  /** Opens a web page in a new tab of the browser window Settings belongs to. */
  'settings.openUrl': { args: { url: string }; result: void }
  'settings.buildInfo': { args: Record<string, never>; result: BuildInfo }
  /** Copies the build info for a bug report (ST-17) and returns the text copied. */
  'settings.copyBuildInfo': { args: Record<string, never>; result: string }
}
