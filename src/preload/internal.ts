/**
 * Preload for Orbit's internal pages (DT-13), `orbit://<page>/` in a normal tab. Every profile
 * session runs it in every page, so in web pages it must do nothing: it gives `window.orbit` only to
 * the main frame of an `orbit:` page, and main answers only such a frame (see
 * src/main/devtools/internal-pages.ts). The bridge is the one Orbit's UI has (src/preload/shell.ts),
 * on channels of its own; `windowId` is the window the tab was in when the page loaded.
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { OrbitBridge, StatePatch } from '../shared/rpc'

type PatchListener = (seq: number, patches: StatePatch[]) => void

function expose(windowId: string): void {
  // As in the shell's preload: the state is on its way, and changes are kept, before the page runs.
  const patchListeners = new Set<PatchListener>()
  const earlyPatches: [number, StatePatch[]][] = []
  ipcRenderer.on('orbit:patches', (_event, seq: number, patches: StatePatch[]) => {
    if (patchListeners.size === 0) {
      if (earlyPatches.length < 2000) earlyPatches.push([seq, patches])
      return
    }
    for (const listener of patchListeners) listener(seq, patches)
  })
  let prefetched: Promise<{ state: import('../shared/state').OrbitState; seq: number }> | undefined =
    ipcRenderer.invoke('orbit:internal:getState')

  const bridge: OrbitBridge = {
    windowId,
    view: 'internal',
    platform: process.platform,
    // Main runs only the commands listed for the page, and takes no events from it (D53).
    invoke: (name, args) => ipcRenderer.invoke('orbit:internal:invoke', name, args),
    send: () => {},
    getState: () => {
      const pending = prefetched ?? ipcRenderer.invoke('orbit:internal:getState')
      prefetched = undefined
      return pending
    },
    onPatches: (listener) => {
      patchListeners.add(listener)
      for (const [seq, patches] of earlyPatches.splice(0)) listener(seq, patches)
      return () => patchListeners.delete(listener)
    },
    on: (channel, listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload)
      ipcRenderer.on(`orbit:${channel}`, handler)
      return () => ipcRenderer.off(`orbit:${channel}`, handler)
    },
  }
  contextBridge.exposeInMainWorld('orbit', bridge)
}

if (location.protocol === 'orbit:' && window.top === window) {
  // Main says no to anything but a tab's main frame showing an internal page.
  const hello = ipcRenderer.sendSync('orbit:internal:hello') as { windowId: string } | null
  if (hello) expose(hello.windowId)
}
