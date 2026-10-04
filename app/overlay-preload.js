// Ponte da camada de ponteiro/desenho.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onEvent: (callback) => ipcRenderer.on('overlay:event', (_event, data) => callback(data)),
});
