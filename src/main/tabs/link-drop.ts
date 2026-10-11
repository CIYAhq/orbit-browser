import type { WebContents } from 'electron'
import type { Box } from '../../shared/split'
import type { TabId, WindowId } from '../../shared/state'
import { splitOfTab } from '../../shared/tree'
import type { MainContext } from '../context'
import { isUnplacedImportTab } from '../import/unplaced'
import { activeTabOf } from '../windows'

/** The isolated world the page's side of a link drop runs in (TB-09). */
const LINK_DROP_WORLD = 1030

/** A web or file address: a link a page could use, and a page that could use one (not Orbit's own pages, about: or data:). */
const WEB = /^(https?|file):/i

/** At most this many places per page take a link. */
const MAX_TARGETS = 64

/** What the page is told: the row over one of its places, off it, or let go there. */
export type LinkDropPhase = 'over' | 'leave' | 'drop'

/**
 * Where a page takes a dropped link (TB-09): its text fields and editable areas (a chat box, a
 * search field) that are in sight and not covered, as boxes in the page's own pixels. The page
 * keeps the elements, in this world, for the drop that may follow.
 */
export const LINK_TARGETS_SCRIPT = `(() => {
  const s = (window.__orbitLinkDrop = { fields: [], el: null });
  const typed = /^(text|search|url|email|tel|)$/i;
  const takes = (el) => {
    if (el.tagName === 'TEXTAREA') return !el.readOnly && !el.disabled;
    if (el.tagName === 'INPUT') return typed.test(el.getAttribute('type') || '') && !el.readOnly && !el.disabled;
    return el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable);
  };
  // In sight: not hidden, and what is drawn at its middle is it, inside it, or beside it in its own box (a placeholder).
  const uncovered = (el, r) => {
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const root = el.getRootNode();
    const hit = (root.elementFromPoint ? root : document).elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    if (!hit) return false;
    const box = el.parentElement;
    return hit === el || el.contains(hit) || (!!box && box !== document.body && box !== document.documentElement && box.contains(hit));
  };
  const out = [];
  const roots = [document];
  for (let i = 0; i < roots.length && out.length < ${MAX_TARGETS}; i++) {
    for (const el of roots[i].querySelectorAll('*')) {
      if (el.shadowRoot) roots.push(el.shadowRoot);
      if (out.length >= ${MAX_TARGETS} || !takes(el)) continue;
      const b = el.getBoundingClientRect();
      const x = Math.max(0, b.left), y = Math.max(0, b.top);
      const r = { x, y, width: Math.min(innerWidth, b.right) - x, height: Math.min(innerHeight, b.bottom) - y };
      if (r.width < 4 || r.height < 4 || !uncovered(el, r)) continue;
      s.fields.push(el);
      out.push(r);
    }
  }
  return out;
})()`

/**
 * The page's side of a sidebar row's link over one of its targets (TB-09). Orbit's rows drag with
 * the pointer, not with the system's drag and drop, so the page is told with the events a system
 * drag gives it, each carrying the link: \`dragenter\` and \`dragover\` while the row is over an element,
 * \`dragleave\` when it leaves, \`drop\` on release. A page that handles the drop itself (cancels it)
 * has it; otherwise the field gets the link typed in, as a drop from another app would. A dropped
 * link never navigates the page.
 */
export function linkDropScript(phase: LinkDropPhase, index: number, x: number, y: number, url: string): string {
  return `(() => {
  const phase = ${JSON.stringify(phase)}, index = ${Number(index)}, x = ${Number(x)}, y = ${Number(y)}, url = ${JSON.stringify(url)};
  const s = window.__orbitLinkDrop;
  if (!s) return false;
  const fire = (type, el) => {
    const data = new DataTransfer();
    data.setData('text/uri-list', url);
    data.setData('text/plain', url);
    data.effectAllowed = 'copyLink';
    const event = new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: data });
    return !el.dispatchEvent(event);
  };
  const leave = () => { if (s.el && s.el.isConnected) fire('dragleave', s.el); s.el = null; };
  if (phase === 'leave') { leave(); return false; }
  const field = s.fields[index];
  if (!field || !field.isConnected) { leave(); return false; }
  const root = field.getRootNode();
  const hit = (root.elementFromPoint ? root : document).elementFromPoint(x, y);
  // The element under the pointer, while it is in the field; the field itself while the page settles.
  const at = hit && (hit === field || field.contains(hit)) ? hit : field;
  if (s.el !== at) { leave(); s.el = at; fire('dragenter', at); }
  fire('dragover', at);
  if (phase === 'over') return true;
  s.el = null;
  if (fire('drop', at)) return 'page';
  field.focus({ preventScroll: true });
  if (field.isContentEditable) {
    const caret = document.caretRangeFromPoint(x, y);
    const selection = getSelection();
    if (caret && selection && field.contains(caret.startContainer)) { selection.removeAllRanges(); selection.addRange(caret); }
    if (!document.execCommand('insertText', false, url)) {
      const range = selection && selection.rangeCount > 0 && field.contains(selection.anchorNode) ? selection.getRangeAt(0) : null;
      if (range) { range.deleteContents(); range.insertNode(document.createTextNode(url)); range.collapse(false); }
      else field.append(url);
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromDrop', data: url }));
    }
    return 'field';
  }
  // Where its caret was when it had the keyboard, else at its end; typed, so the field's own undo takes it back.
  const before = field.value;
  if (at === field && document.activeElement !== field) field.setSelectionRange(before.length, before.length);
  if (!document.execCommand('insertText', false, url) || field.value === before) {
    field.setRangeText(url, field.selectionStart ?? before.length, field.selectionEnd ?? before.length, 'end');
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromDrop', data: url }));
  }
  return 'field';
})()`
}

interface LinkPage {
  tabId: TabId
  contents: WebContents
  /** The page's view in the window when it was asked (window coordinates). */
  bounds: Box
  zoom: number
  /** Its targets, in window coordinates. */
  targets: Box[]
}

const inside = (r: Box, x: number, y: number) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height

/**
 * `tabs.linkTargets` and `tabs.dropLink` (TB-09): a sidebar row dragged over the page drops its link
 * where the page takes one, rather than making a split. The pages shown are asked once, as they are
 * drawn before the split's preview makes room, where they take links; the shell then knows at each
 * pointer move, with no question to the page, whether the row is over one of those places. While it
 * is, the page is told of the row there, and gets the link on release.
 */
export function registerLinkDrop(ctx: MainContext): void {
  const { commands, store, windows } = ctx
  const drags = new Map<WindowId, { tabId: TabId; pages: LinkPage[]; last?: WebContents }>()
  /** The latest question per window: an older one answered later is dropped. */
  const asked = new Map<WindowId, number>()
  let questions = 0
  const run = async (contents: WebContents, code: string): Promise<unknown> => {
    if (contents.isDestroyed()) return undefined
    try {
      return await contents.executeJavaScriptInIsolatedWorld(LINK_DROP_WORLD, [{ code }])
    } catch {
      return undefined
    }
  }
  const leave = (windowId: WindowId) => {
    const drag = drags.get(windowId)
    const page = drag?.last
    if (!drag || !page) return
    drag.last = undefined
    void run(page, linkDropScript('leave', 0, 0, 0, ''))
  }
  /** The dragged tab's link, while it has one a page could use. */
  const linkOf = (tabId: TabId) => {
    const url = store.state.tabs[tabId]?.url
    return url && WEB.test(url) && !isUnplacedImportTab(tabId) ? url : undefined
  }

  commands.register('tabs.linkTargets', async ({ tabId, panes }, c) => {
    const windowId = c.windowId ?? windows.focusedWindowId()
    if (!windowId) return []
    leave(windowId)
    drags.delete(windowId)
    const question = ++questions
    asked.set(windowId, question)
    if (!linkOf(tabId)) return []
    const pages = await Promise.all(
      panes.map(async (pane): Promise<LinkPage | undefined> => {
        const tab = store.state.tabs[pane.tabId]
        const contents = ctx.tabs.get(pane.tabId)?.webContents
        if (!tab || !WEB.test(tab.url) || isUnplacedImportTab(pane.tabId) || !contents || contents.isDestroyed()) {
          return undefined
        }
        // Where the page is now, less DevTools docked in its view (DT-03); where the shell puts it otherwise.
        const bounds = windows.tabViewBounds(pane.tabId) ?? pane.rect
        const zoom = contents.getZoomFactor() || 1
        const found = await run(contents, LINK_TARGETS_SCRIPT)
        const boxes = Array.isArray(found) ? (found as Box[]) : []
        const targets = boxes.map((r) => ({
          x: bounds.x + r.x * zoom,
          y: bounds.y + r.y * zoom,
          width: r.width * zoom,
          height: r.height * zoom,
        }))
        return { tabId: pane.tabId, contents, bounds, zoom, targets }
      }),
    )
    if (asked.get(windowId) !== question) return []
    const found = pages.filter((p): p is LinkPage => !!p && p.targets.length > 0)
    drags.set(windowId, { tabId, pages: found })
    return found.flatMap((p) => p.targets)
  })

  commands.register('tabs.dropLink', async ({ x, y, phase }, c) => {
    const windowId = c.windowId ?? windows.focusedWindowId()
    const drag = windowId ? drags.get(windowId) : undefined
    if (!windowId || !drag) return false
    if (phase === 'leave' || phase === 'end') {
      leave(windowId)
      if (phase === 'end') drags.delete(windowId)
      return false
    }
    const url = linkOf(drag.tabId)
    const page = url ? drag.pages.find((p) => p.targets.some((r) => inside(r, x, y))) : undefined
    if (!page || !url || page.contents.isDestroyed()) {
      leave(windowId)
      if (phase === 'drop') drags.delete(windowId)
      return false
    }
    if (drag.last !== page.contents) leave(windowId)
    if (phase === 'drop') drags.delete(windowId)
    drag.last = phase === 'over' ? page.contents : undefined
    const index = page.targets.findIndex((r) => inside(r, x, y))
    // The point in the page's own pixels, as the page was drawn when asked.
    const px = (x - page.bounds.x) / page.zoom
    const py = (y - page.bounds.y) / page.zoom
    const result = await run(page.contents, linkDropScript(phase, index, px, py, url))
    if (phase === 'drop' && (result === 'page' || result === 'field') && !page.contents.isDestroyed()) {
      // The page that took the link has the keyboard, to send it on (Enter in a chat box); in a
      // split, its pane is the focused one, as after a click into it (SV-14).
      if (activeTabOf(store.state, windowId) !== page.tabId && splitOfTab(store.state, page.tabId)) {
        await commands.run('split.focusPane', { tabId: page.tabId }, { windowId })
      }
      page.contents.focus()
    }
    return result === true || result === 'page' || result === 'field'
  })
}
