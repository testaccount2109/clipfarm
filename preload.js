const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clipfarmNative", {
  getAppInfo: () => ipcRenderer.invoke("clipfarm:app:info"),
  checkForUpdates: () => ipcRenderer.invoke("clipfarm:update:check"),
  installUpdate: () => ipcRenderer.invoke("clipfarm:update:install"),
  onUpdateAvailable: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on("clipfarm:update:available", listener);
    return () => ipcRenderer.removeListener("clipfarm:update:available", listener);
  },
  onUpdateState: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on("clipfarm:update:state", listener);
    return () => ipcRenderer.removeListener("clipfarm:update:state", listener);
  },
  getAutostart: () => ipcRenderer.invoke("clipfarm:startup:get"),
  setAutostart: (enabled) => ipcRenderer.invoke("clipfarm:startup:set", enabled),
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
  getMyClips: (cursor) => ipcRenderer.invoke("clipfarm:clips:mine", cursor),
  getProfile: () => ipcRenderer.invoke("clipfarm:profile:get"),
  updateProfile: (profile) => ipcRenderer.invoke("clipfarm:profile:update", profile),
  changePassword: (currentPassword, newPassword) => ipcRenderer.invoke("clipfarm:profile:password", currentPassword, newPassword),
  saveClip: () => ipcRenderer.invoke("clipfarm:clip:save"),
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
