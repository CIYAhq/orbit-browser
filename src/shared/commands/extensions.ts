import type { ActionDef } from '../actions'
import type { ProfileId } from '../state'

/**
 * Chrome extensions (EX-*). Owned by the extensions lane. Pure logic is in src/shared/extensions.ts,
 * the main side in src/main/extensions/, the UI in src/renderer/src/extensions/.
 *
 * Commands that act on one extension name it by `id`. Its profile is the calling page's own tab's
 * when the extensions page calls (EX-07, never what the page says), else `profileId`, else the
 * profile of the calling window's Space (EX-09).
 */

/** The extensions page (EX-07): `orbit://extensions/`, an internal page (DT-13). */
export const EXTENSIONS_PAGE = 'extensions'
export const EXTENSIONS_URL = `orbit://${EXTENSIONS_PAGE}/`

/** The overlay panel that asks about an extension (EX-02, EX-08), in Orbit's own UI. */
export const EXTENSION_DIALOG_PANEL = 'extension-dialog'

/** What the dialog asks. Main fills it in; the answer comes back with `requestId`. */
export interface ExtensionDialogParams {
  requestId: string
  /** install: Add extension / Cancel (EX-02). remove: Remove / Cancel (EX-08). */
  kind: 'install' | 'remove'
  name: string
  /** A PNG data URL, or '' for the generic icon. */
  icon: string
  /** What it may do, in plain words (install only). */
  lines: string[]
}

/** How adding an extension ended. */
export type InstallResult =
  | { ok: true; id: string; name: string }
  /** `cancelled`: no file chosen, or Cancel in the confirmation. Otherwise `error` says why, in words. */
  | { ok: false; cancelled?: boolean; error?: string }

/** The extensions page's own profile (EX-07, EX-09). */
export interface ExtensionsPageInfo {
  profileId: ProfileId
  profileName: string
}

export interface ExtensionCommands {
  /** The extensions page asks whose extensions it shows: its own tab's profile's. */
  'extensions.pageInfo': { args: Record<string, never>; result: ExtensionsPageInfo }
  /** On / off (EX-07): takes effect at once, without a restart. False if there is no such extension. */
  'extensions.setEnabled': { args: { id: string; enabled: boolean; profileId?: ProfileId }; result: boolean }
  /** Allow in private windows (EX-10) or access to file URLs (EX-07). */
  'extensions.setAllowed': {
    args: { id: string; what: 'private' | 'files'; allowed: boolean; profileId?: ProfileId }
    result: boolean
  }
  /** Remove (EX-08), once the user confirms in Orbit's dialog. True if it was removed. */
  'extensions.remove': { args: { id: string; profileId?: ProfileId }; result: boolean }
  /** Pins or unpins it (EX-04). */
  'extensions.pin': { args: { id: string; pinned: boolean; profileId?: ProfileId }; result: boolean }
  /** Install from a .crx file the user picks (EX-09), after Orbit's confirmation (EX-02). */
  'extensions.installFile': { args: { profileId?: ProfileId }; result: InstallResult }
  /** Load unpacked (EX-07, Developer mode): a folder the user picks, run where it is. */
  'extensions.loadUnpacked': { args: { profileId?: ProfileId }; result: InstallResult }
  /** Loads an unpacked extension again from its folder (Developer mode). */
  'extensions.reload': { args: { id: string; profileId?: ProfileId }; result: boolean }
  /** Opens its options page in a new tab (EX-07). */
  'extensions.openOptions': { args: { id: string; profileId?: ProfileId }; result: boolean }
  /** The extensions page's Developer mode (EX-07). */
  'extensions.setDevMode': { args: { on: boolean }; result: void }
  /** The dialog's answer (EX-02, EX-08). */
  'extensions.answer': { args: { requestId: string; accept: boolean }; result: void }
}

/** The command bar's and menus' extension actions (EX-01, EX-07). */
export const EXTENSION_ACTIONS: ActionDef[] = [
  {
    id: 'extension.manage',
    title: 'Manage Extensions',
    category: 'App',
    keywords: ['extensions', 'add-ons', 'addons', 'plugins', 'extensions page'],
  },
  {
    id: 'extension.installFile',
    title: 'Install Extension from File…',
    category: 'App',
    keywords: ['extension', 'crx', 'add extension', 'install extension', 'add-on'],
  },
]
