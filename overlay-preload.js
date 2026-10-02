const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clipOverlay", {
  onOutcome: (callback) => ipcRenderer.on("clipfarm:overlay-outcome", (_event, outcome) => callback(outcome))
});
