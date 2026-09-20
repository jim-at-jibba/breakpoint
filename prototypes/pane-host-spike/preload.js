'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('spike', {
  boot: () => ipcRenderer.invoke('app:boot'),
  attach: (paneId, wcId) => ipcRenderer.invoke('pane:attach', { paneId, wcId }),
  setZoom: z => ipcRenderer.invoke('probe:setZoom', z),
  targetRect: paneId => ipcRenderer.invoke('probe:targetRect', paneId),
  synthClick: (paneId, x, y) => ipcRenderer.invoke('probe:synthClick', { paneId, x, y }),
  synthClickCdp: (paneId, x, y) => ipcRenderer.invoke('probe:synthClickCdp', { paneId, x, y }),
  paneShot: paneId => ipcRenderer.invoke('probe:paneShot', paneId),
  diag: () => ipcRenderer.invoke('probe:diag'),
  devtools: (paneId, open) => ipcRenderer.invoke('probe:devtools', { paneId, open }),
  reattach: paneId => ipcRenderer.invoke('probe:reattach', paneId),
  navigate: (paneId, url) => ipcRenderer.invoke('probe:navigate', { paneId, url }),
  reapply: paneId => ipcRenderer.invoke('probe:reapply', paneId),
  measure: () => ipcRenderer.invoke('probe:measure'),
  capture: label => ipcRenderer.invoke('probe:capture', label),
  dump: () => ipcRenderer.invoke('probe:dump'),
  mark: t => ipcRenderer.invoke('probe:mark', t),
  quit: () => ipcRenderer.invoke('probe:quit'),
  onState: cb => ipcRenderer.on('state', (_e, s) => cb(s)),
  onAuto: cb => ipcRenderer.on('auto:start', (_e, mode) => cb(mode))
})
