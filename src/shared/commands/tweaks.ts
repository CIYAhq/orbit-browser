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
  /** Hide-element mode (BO-10). */
  hide: TweakHideState
}

/** Hide-element mode in a window's editor panel (BO-10). */
export interface TweakHideState {
  /** The mode is on: what is under the pointer in the page is outlined, and a click picks it. */
  on: boolean
  /** The element the user clicked, waiting for "Hide this" or "Hide all similar"; null while none is. */
  pick: TweakHidePick | null
}

/** An element picked in Hide-element mode (BO-10), as the page's picker described it. */
export interface TweakHidePick {
  /** What it is, in words (its name, text or kind), for its restore marker. */
  label: string
  /** "Hide this": a selector for that element alone. */
  exact: string
  /**
   * "Hide all similar", narrow to broad: selectors for it and elements like it, each with how many it
   * matches now (`count`, what it hides), and how many of those have a box the page outlines (`shown`:
   * the rest are hidden already, or have no size).
   */
  similar: { selector: string; count: number; shown: number }[]
}

/** Which of a pick's selectors (BO-10): the element alone, or a level of "similar" (an index into `similar`). */
export type TweakHideChoice = 'this' | number

export const HIDE_OFF: TweakHideState = { on: false, pick: null }

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
  /**
   * Clears every edit of a Tweak (BO-12's "Reset all edits"): colours, font, size, case, hidden
   * elements and code. Its name, switch and scope stay.
   */
  'tweaks.reset': { args: { id: string }; result: void }
  /**
   * Hide-element mode on or off in the calling window's editor panel (BO-10). Main puts the picker in
   * the page (an isolated world, never the page's own); false where it can't start.
   */
  'tweaks.hideMode': { args: { on: boolean }; result: boolean }
  /**
   * Outlines in the page what a choice would hide (BO-10): the picked element, or a level of similar
   * ones; null outlines the picked element again. The number of elements outlined.
   */
  'tweaks.hidePreview': { args: { choice: TweakHideChoice | null }; result: number }
  /** Hides what a choice picks (BO-10), as plain CSS in the edited Tweak; the mode goes on. False if nothing was. */
  'tweaks.hide': { args: { choice: TweakHideChoice }; result: boolean }
  /** Drops the picked element without hiding anything (BO-10); the mode goes on. */
  'tweaks.hideCancel': { args: Record<string, never>; result: void }
  /** Shows one hidden element of the edited page again while its restore marker is hovered (BO-10), or none. */
  'tweaks.showHidden': { args: { hiddenId: string | null }; result: void }
  /** Brings a hidden element back for good (BO-10's restore marker). */
  'tweaks.unhide': { args: { id: string; hiddenId: string }; result: void }
  /** Turns a Tweak on or off (BO-14, BO-15). */
  'tweaks.setEnabled': { args: { id: string; enabled: boolean }; result: void }
  /** Deletes a Tweak (BO-15): its styles leave open pages at once. */
  'tweaks.delete': { args: { id: string }; result: void }
  /**
   * The Library's Open Site and Edit (BO-15): shows the Tweak's site in the calling window, in a tab
   * of its Space already showing it (the shown one, else the one used last) or else a new tab at the
   * origin the Tweak was made on, and closes the Library. With `edit`, the editor opens on the Tweak
   * once the page can take it. False where it didn't get that far.
   */
  'tweaks.open': { args: { id: string; edit?: boolean }; result: boolean }
  /**
   * Tweaks on or off for every site (BO-16, Settings → Advanced). Off, no Tweak applies anywhere and
   * no new one can be made; each Tweak keeps its own on or off for when they are back on.
   */
  'tweaks.setGlobal': { args: { enabled: boolean }; result: void }
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
 * default (BO-01). They act on the window's shown page; View Tweaks opens the Library's list (BO-15).
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
  {
    id: 'tweak.view',
    title: 'View Tweaks',
    category: 'App',
    keywords: ['customize', 'customizations', 'view customizations', 'site style', 'tweaks', 'library'],
  },
]
