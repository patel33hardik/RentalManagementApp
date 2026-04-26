const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
});
