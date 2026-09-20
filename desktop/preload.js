'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tello', {
  connect: () => ipcRenderer.invoke('tello:connect'),
  disconnect: () => ipcRenderer.invoke('tello:disconnect'),
  command: (cmd) => ipcRenderer.invoke('tello:command', cmd),
  emergency: () => ipcRenderer.invoke('tello:emergency'),
  startVideo: () => ipcRenderer.invoke('tello:video:start'),
  stopVideo: () => ipcRenderer.invoke('tello:video:stop'),
  startRecording: () => ipcRenderer.invoke('tello:video:record:start'),
  stopRecording: () => ipcRenderer.invoke('tello:video:record:stop'),
  flySquare: (sideCm) => ipcRenderer.invoke('tello:auto:square', sideCm),
  onState: (callback) => ipcRenderer.on('tello:state', (_event, state) => callback(state)),
  onLog: (callback) => ipcRenderer.on('tello:log', (_event, msg) => callback(msg)),
});