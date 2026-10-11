import type { ActionDef } from '../actions'
import type { TabId } from '../state'
import type { TweakPatch } from '../tweaks'

/**
 * Tweaks (BO-*): per-site customisations. Owned by the tweaks lane. Pure logic is in
 * src/shared/tweaks.ts, the main side in src/main/tweaks/, the editor in src/renderer/src/tweaks/.
 */

/** What the editor panel shows (BO-02): main says, the panel's page draws it. */
export interface TweakEditorState {
  /** The panel is out, for this Tweak over this tab's page. */
  open: boolean
  tabId: TabId | null
  tweakId: string | null
  /** The page's host, which the Tweak applies to. */
  host: string | null
  /** Bumped by every opening, so the panel starts fresh (focus, scroll) each time. */
  nonce: number
  /** The page is in a private window (BO-17: JavaScript Tweaks run there only if allowed). */
  private: boolean
}

/**
 * The editor panel's view (BO-02): the panel at the top-right corner of the page it edits, plus a
 * margin around it for its shadow. The panel's page says how big the panel is (`tweaks.editorLayout`).
 */
export const TWEAK_EDITOR = {
  /** Room around the panel for its shadow. */
  margin: 8,
  /** The panel's distance from the page's top and right edges. */
  inset: 12,
  /** The panel's width; wider while its code area is open (BO-11). */
  width: 296,
  wideWidth: 460,
  /** The smallest page the panel shows over. */
  minPage: 160,
} as const

export interface TweakCommands {
  /**
   * A new Tweak for the site in a tab (BO-01), opened in the editor: from the + menu, the command
   * bar, the site controls panel, the address field and the tab's menu. Without `tabId`, the
   * calling window's shown tab. Its id, or null where Tweaks can't go (not a website, or Tweaks off),
   * with a note in the window saying why.
   */
  'tweaks.create': { args: { tabId?: TabId }; result: string | null }
  /**
   * Opens the editor for a Tweak over a tab's page (BO-02's reopen, the › in the site controls panel).
   * Without `tabId`, the calling window's shown tab. False when the Tweak doesn't apply there.
   */
  'tweaks.edit': { args: { id: string; tabId?: TabId }; result: boolean }
  /** Changes a Tweak (the editor's controls, BO-02 to BO-12): checked, saved as it is made. */
  'tweaks.update': { args: { id: string; patch: TweakPatch }; result: boolean }
  /**
   * Runs a Tweak's JavaScript in a tab's page now (BO-11's "Run now"): only where it would run on a
   * load (the Tweak on and for the page's site, allowed on this device, in a private window only if
   * allowed there). False where it didn't run.
   */
  'tweaks.runNow': { args: { id: string; tabId: TabId }; result: boolean }
  /** Turns a Tweak on or off (BO-14, BO-15). */
  'tweaks.setEnabled': { args: { id: string; enabled: boolean }; result: void }
  /** Deletes a Tweak (BO-15): its styles leave open pages at once. */
  'tweaks.delete': { args: { id: string }; result: void }
  /** The editor panel's state, for its page as it starts (main pushes changes on `tweakEditor`). */
  'tweaks.editorState': { args: Record<string, never>; result: TweakEditorState }
  /** Closes the calling window's editor panel (✕, Done, Esc): every edit is already saved (BO-02). */
  'tweaks.closeEditor': { args: Record<string, never>; result: void }
  /** The editor panel's size, as its page lays it out: main sizes its view to fit. */
  'tweaks.editorLayout': { args: { width: number; height: number }; result: void }
  /** The editor's one-screen intro was read (BO-01): it never shows again. */
  'tweaks.dismissIntro': { args: Record<string, never>; result: void }
}

/** Fire-and-forget events from the editor panel's view. */
export interface TweakEvents {
  /** Dragging the panel by its title (BO-02), in screen DIPs. */
  'tweaks.editorDrag': { phase: 'start' | 'move' | 'end'; x: number; y: number }
}

/**
 * Tweak actions (BO-21): in the command bar, assignable in Settings → Shortcuts, none bound by
 * default (BO-01). They act on the window's shown page.
 */
export const TWEAK_ACTIONS: ActionDef[] = [
  {
    id: 'tweak.new',
    title: 'New Tweak…',
    category: 'Page',
    keywords: [
      'tweak this site',
      'customize',
      'customize site',
      'customize this site',
      'customization',
      'new customization',
      'site customization',
      'site style',
      'restyle',
    ],
  },
  {
    id: 'tweak.edit',
    title: 'Edit Tweak',
    category: 'Page',
    keywords: ['customize', 'customization', 'edit customization', 'site style', 'tweaks'],
  },
  {
    id: 'tweak.siteOff',
    title: 'Turn Off Tweaks for This Site',
    category: 'Page',
    keywords: ['customize', 'customization', 'disable customizations', 'site style', 'original look'],
  },
  {
    id: 'tweak.siteOn',
    title: 'Turn On Tweaks for This Site',
    category: 'Page',
    keywords: ['customize', 'customization', 'enable customizations', 'site style'],
  },
]
