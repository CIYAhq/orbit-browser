import type { WebContents } from 'electron'
import type { DevtoolsPanel, DockSide } from '../../shared/commands/devtools'

/**
 * Scripts Orbit runs in a DevTools page (the engine's DevTools front end). They use its embedder API
 * (`DevToolsAPI`, `InspectorFrontendHost`) and, for the dock side and the docked size, the front
 * end's own modules. Those are internal to the engine: every call here may fail after an engine
 * update, so each one has a fallback.
 */

/** A shortcut as the DevTools page checks it (a parsed accelerator). */
export interface FrontendKey {
  cmd: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  key: string
}

/** Orbit's DevTools shortcuts, which keep working while DevTools have the keyboard. */
export interface FrontendKeys {
  toggle: FrontendKey[]
  console: FrontendKey[]
  inspect: FrontendKey[]
}

/** Runs a script in a DevTools page. Undefined when it fails or doesn't answer within `ms`. */
export async function inFrontend<T>(devtools: WebContents, script: string, ms = 2000): Promise<T | undefined> {
  if (devtools.isDestroyed()) return undefined
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  try {
    return await Promise.race([devtools.executeJavaScript(script) as Promise<T>, timeout])
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

const LEGACY = `const legacy = await import('./ui/legacy/legacy.js');`

/** Which side DevTools are docked on, or 'undocked'. */
export const DOCK_SIDE = `(async () => { ${LEGACY} return legacy.DockController.DockController.instance().dockSide() })()`

export const showPanel = (panel: DevtoolsPanel) => `DevToolsAPI.showPanel(${JSON.stringify(panel)})`

/** The element picker: the next click on the page selects that element in Elements (DT-02). Toggles. */
export const PICKER = 'DevToolsAPI.enterInspectElementMode()'

/**
 * Lets Orbit's DevTools keys act while DevTools have the keyboard: the toggle key closes them (F12
 * twice opens and closes, DT-01), the console key shows the Console, the picker key picks. A key
 * held down acts once. Every other key is DevTools' own (⇧⌘C picks an element there, DT-02).
 * Installing it again only updates the keys.
 */
export function keyHandler(keys: FrontendKeys): string {
  return `((keys) => {
  const installed = !!window.__orbitKeys;
  window.__orbitKeys = keys;
  if (installed) return;
  const name = (e) =>
    /^[a-z]$/i.test(e.key) ? e.key.toUpperCase()
    : /^Key[A-Z]$/.test(e.code) ? e.code.slice(3)
    : /^Digit[0-9]$/.test(e.code) ? e.code.slice(5)
    : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const matches = (e, list) => list.some((k) =>
    k.cmd === e.metaKey && k.ctrl === e.ctrlKey && k.alt === e.altKey && k.shift === e.shiftKey && k.key === name(e));
  window.addEventListener('keydown', (e) => {
    const keys = window.__orbitKeys;
    const which = matches(e, keys.toggle) ? 'toggle' : matches(e, keys.console) ? 'console' : matches(e, keys.inspect) ? 'inspect' : null;
    if (!which) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    if (which === 'toggle') InspectorFrontendHost.closeWindow();
    else if (which === 'console') DevToolsAPI.showPanel('console');
    else DevToolsAPI.enterInspectElementMode();
  }, true);
})(${JSON.stringify(keys)})`
}

/**
 * Gives docked DevTools the size last chosen in any DevTools of the profile (the engine saves it
 * when a resize ends), so the size doesn't change from tab to tab (DT-03). Returns what it did.
 */
export const SYNC_DOCKED_SIZE = `(async () => {
  ${LEGACY}
  if (legacy.DockController.DockController.instance().dockSide() === 'undocked') return 'undocked';
  const split = legacy.InspectorView.InspectorView.instance().ownerSplitWidget;
  if (!split) return 'none';
  const prefs = await new Promise((resolve) => InspectorFrontendHost.getPreferences(resolve));
  let saved = {};
  try { saved = JSON.parse(prefs['inspector-view.split-view-state'] || '{}'); } catch { return 'none'; }
  const size = (split.isVertical() ? saved.vertical : saved.horizontal)?.size;
  if (!(size > 0) || Math.abs(size - split.sidebarSize()) < 1) return 'same';
  split.setSidebarSize(size);
  return 'synced';
})()`

export function isDockSide(value: unknown): value is DockSide {
  return value === 'right' || value === 'left' || value === 'bottom' || value === 'undocked'
}
