const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('remars', {
  command: (action, payload = {}) => ipcRenderer.invoke('mars:command', { action, payload }),
  onEvent: (listener) => {
    const handler = (_event, message) => listener(message)
    ipcRenderer.on('mars:event', handler)
    return () => ipcRenderer.removeListener('mars:event', handler)
  },
  openFile: () => ipcRenderer.invoke('files:open'),
  saveFile: (payload) => ipcRenderer.invoke('files:save', payload),
})
