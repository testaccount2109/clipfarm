const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clipfarmNative", {
  syncHotkeys: (hotkeys) => ipcRenderer.invoke("clipfarm:hotkeys:sync", hotkeys),
  onStartupError: (callback) => ipcRenderer.on("clipfarm:startup-error", (_event, message) => callback(message)),
  onClipOutcome: (callback) => ipcRenderer.on("clipfarm:clip-outcome", (_event, outcome) => callback(outcome)),
  notifyClipOutcome: (outcome) => ipcRenderer.invoke("clipfarm:clip-outcome", outcome),
  getGameIcon: (processId) => ipcRenderer.invoke("clipfarm:game-icon", processId),
  getBackendStatus: () => ipcRenderer.invoke("clipfarm:backend:status"),
  getAccount: () => ipcRenderer.invoke("clipfarm:account:get"),
  login: (mode, credentials) => ipcRenderer.invoke("clipfarm:account:login", mode, credentials),
  logout: () => ipcRenderer.invoke("clipfarm:account:logout"),
  getFeed: (cursor) => ipcRenderer.invoke("clipfarm:feed:get", cursor),
  getUploadQueue: () => ipcRenderer.invoke("clipfarm:upload:list"),
  queueClipUpload: (clip) => ipcRenderer.invoke("clipfarm:upload:queue", clip),
  retryUpload: (id) => ipcRenderer.invoke("clipfarm:upload:retry", id),
  onUploadUpdate: (callback) => {
    const listener = (_event, update) => callback(update);
    ipcRenderer.on("clipfarm:upload:update", listener);
    return () => ipcRenderer.removeListener("clipfarm:upload:update", listener);
  },
  onUploadCommitted: (callback) => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on("clipfarm:upload:committed", listener);
    return () => ipcRenderer.removeListener("clipfarm:upload:committed", listener);
  },
  onAccountUpdate: (callback) => {
    const listener = (_event, user) => callback(user);
    ipcRenderer.on("clipfarm:account:update", listener);
    return () => ipcRenderer.removeListener("clipfarm:account:update", listener);
  }
});
