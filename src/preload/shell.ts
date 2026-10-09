/**
 * Preload for Orbit's own UI renderers (shell, overlay, settings…). Exposes a
 * narrow, typed bridge as window.orbit. Web pages never get this preload.
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { OrbitBridge, RendererView, StatePatch } from '../shared/rpc'

const arg = (name: string): string => {
  const prefix = `--${name}=`
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length) ?? ''
}

type PatchListener = (seq: number, patches: StatePatch[]) => void

// Start fetching state and buffering patches before the page's scripts run, so
// the first render doesn't wait for an IPC round trip after the bundle parses.
// Patches that arrive before anyone subscribes are replayed in order.
const patchListeners = new Set<PatchListener>()
const earlyPatches: [number, StatePatch[]][] = []
ipcRenderer.on('orbit:patches', (_event, seq: number, patches: StatePatch[]) => {
  if (patchListeners.size === 0) {
    if (earlyPatches.length < 2000) earlyPatches.push([seq, patches])
    return
  }
  for (const listener of patchListeners) listener(seq, patches)
})
let prefetchedState: Promise<{ state: import('../shared/state').OrbitState; seq: number }> | undefined =
  ipcRenderer.invoke('orbit:getState')

const bridge: OrbitBridge = {
  windowId: arg('orbit-window-id'),
  view: (arg('orbit-view') || 'shell') as RendererView,
  platform: process.platform,
  invoke: (name, args) => ipcRenderer.invoke('orbit:invoke', name, args),
  send: (name, payload) => ipcRenderer.send('orbit:send', name, payload),
  getState: () => {
    const pending = prefetchedState ?? ipcRenderer.invoke('orbit:getState')
    prefetchedState = undefined
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
