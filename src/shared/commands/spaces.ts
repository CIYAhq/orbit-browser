import type { ColorMode, ProfileId, SpaceId, SpaceTheme } from '../state'

/**
 * Floating Space surfaces drawn by the overlay renderer (overlay state
 * `{ kind: 'panel', panel, params }`). Params: `spaceId` for all of them,
 * plus the anchor point `x`/`y` (window coordinates) for menus.
 */
export type SpacePanel =
  /** The Space menu (SP-04): Theme, Change Icon, Profile, Rename, Delete. `sidebar: true` adds New Tab/Folder. */
  | 'space-menu'
  /** The bottom bar's "+" menu (SB-09). */
  | 'space-plus-menu'
  /** Theme picker beside the sidebar (SP-14). */
  | 'space-theme'
  /** Emoji picker for a Space icon (SP-05). */
  | 'space-icon'
  /** Delete confirmation (SP-12). */
  | 'space-delete'
  /** Name prompt for a new profile, optionally assigned to `spaceId` (PR-02). */
  | 'profile-new'

export const SPACE_PANELS: readonly SpacePanel[] = [
  'space-menu',
  'space-plus-menu',
  'space-theme',
  'space-icon',
  'space-delete',
  'profile-new',
]

/** Owned by the spaces/profiles lane. */
export interface SpaceCommands {
  'spaces.create': {
    args: {
      name?: string
      icon?: string
      theme?: SpaceTheme
      profileId?: ProfileId
      /** Switch the calling window to it (default true). */
      activate?: boolean
      /** Insert after this Space (default: after the calling window's active Space). */
      afterSpaceId?: SpaceId
    }
    result: SpaceId
  }
  'spaces.switch': { args: { spaceId: SpaceId }; result: void }
  /** Moves the calling window `delta` Spaces along the order (no wrap-around). */
  'spaces.step': { args: { delta: number }; result: SpaceId | null }
  'spaces.update': {
    args: { spaceId: SpaceId; name?: string; icon?: string; theme?: SpaceTheme; profileId?: ProfileId }
    result: void
  }
  /** Deletes a Space (archiving its tabs). False for the last Space. */
  'spaces.delete': { args: { spaceId: SpaceId }; result: boolean }
  /** Restores the most recently deleted Space (⌘Z right after deleting, or the toast's Undo). */
  'spaces.undoDelete': { args: Record<string, never>; result: SpaceId | null }
  'spaces.reorder': { args: { spaceId: SpaceId; index: number }; result: void }
  /** Starts the inline rename of a Space's title in the calling window (focuses the sidebar). */
  'spaces.beginRename': { args: { spaceId: SpaceId }; result: void }
  /** Opens the new-Space flow in the calling window's sidebar. */
  'spaces.beginCreate': { args: Record<string, never>; result: void }
  /** Gives keyboard focus to the calling window's sidebar (shell) contents. */
  'spaces.focusShell': { args: Record<string, never>; result: void }
  /** The global Automatic / Light / Dark switch shown in the theme picker (SP-18). */
  'spaces.setAppearance': { args: { appearance: ColorMode }; result: void }
  'profiles.create': { args: { name: string; assignSpaceId?: SpaceId }; result: ProfileId }
  'profiles.rename': { args: { profileId: ProfileId; name: string }; result: void }
  /** Deletes a profile and clears its stored data. Never the Default profile. */
  'profiles.delete': { args: { profileId: ProfileId }; result: boolean }
}
