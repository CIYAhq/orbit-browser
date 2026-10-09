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

const bridge: OrbitBridge = {
  windowId: arg('orbit-window-id'),
  view: (arg('orbit-view') || 'shell') as RendererView,
  platform: process.platform,
  invoke: (name, args) => ipcRenderer.invoke('orbit:invoke', name, args),
  send: (name, payload) => ipcRenderer.send('orbit:send', name, payload),
  getState: () => ipcRenderer.invoke('orbit:getState'),
  onPatches: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, seq: number, patches: StatePatch[]) => listener(seq, patches)
    ipcRenderer.on('orbit:patches', handler)
    return () => ipcRenderer.off('orbit:patches', handler)
  },
  on: (channel, listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload)
    ipcRenderer.on(`orbit:${channel}`, handler)
    return () => ipcRenderer.off(`orbit:${channel}`, handler)
  },
}

contextBridge.exposeInMainWorld('orbit', bridge)
