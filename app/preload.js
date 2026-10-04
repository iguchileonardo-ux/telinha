// Ponte segura entre a interface e o processo principal.
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel, callback) => ipcRenderer.on(channel, (_event, ...args) => callback(...args));

contextBridge.exposeInMainWorld('telinha', {
  platform: process.platform,
  // captura de tela
  listSources: () => ipcRenderer.invoke('sources:list'),
  selectSource: (id, audio) => ipcRenderer.invoke('sources:select', { id, audio }),
  // áudio sem eco
  audioSupport: () => ipcRenderer.invoke('audio:support'),
  startAudio: (sourceId) => ipcRenderer.invoke('audio:start', sourceId),
  stopAudio: () => ipcRenderer.invoke('audio:stop'),
  onAudio: (callback) => listen('audio:pcm', callback),
  // ponteiro e desenho sobre a tela compartilhada
  overlayStart: (sourceId) => ipcRenderer.invoke('overlay:start', sourceId),
  overlayEvent: (data) => ipcRenderer.send('overlay:event', data),
  overlayStop: () => ipcRenderer.invoke('overlay:stop'),
  // rádio
  radioLoad: (args) => ipcRenderer.invoke('radio:load', args),
  radioCommand: (action, value) => ipcRenderer.invoke('radio:command', { action, value }),
  radioStatus: () => ipcRenderer.invoke('radio:status'),
  radioStop: () => ipcRenderer.invoke('radio:stop'),
  radioInfo: (videoId) => ipcRenderer.invoke('radio:info', videoId),
  // app
  setTheme: (theme) => ipcRenderer.invoke('app:theme', theme),
  appInfo: () => ipcRenderer.invoke('app:info'),
  focus: () => ipcRenderer.invoke('app:focus'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateReady: (callback) => listen('update:ready', callback),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  pendingLink: () => ipcRenderer.invoke('link:pending'),
  onLink: (callback) => listen('open-link', callback),
});
