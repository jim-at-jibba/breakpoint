import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { PATCH_CHANNEL, ROUTE_CHANNEL, type BreakpointBridge } from '../shared/ipc'
import type { PatchBatch } from '../shared/state'

// The renderer's half of the typed IPC adapter. It holds no behaviour: an envelope in,
// the route table's answer out.
const breakpoint: BreakpointBridge = {
  invoke: (route, params) =>
    ipcRenderer.invoke(ROUTE_CHANNEL, { id: crypto.randomUUID(), route, params }),
  onPatches: (listener) => {
    const handler = (_event: unknown, batch: PatchBatch): void => listener(batch)
    ipcRenderer.on(PATCH_CHANNEL, handler)
    return () => ipcRenderer.removeListener(PATCH_CHANNEL, handler)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('breakpoint', breakpoint)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.breakpoint = breakpoint
}
