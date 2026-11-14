const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("frost", {
  controlWindow: (action) => ipcRenderer.invoke("window-control", action),
  updatesReady: () => ipcRenderer.invoke("updates-ready"),
  downloadUpdate: () => ipcRenderer.invoke("update-download"),
  remindAboutUpdateLater: () => ipcRenderer.invoke("update-later"),
  onUpdateAvailable: (callback) => {
    const listener = (_event, update) => callback(update);
    ipcRenderer.on("update-available", listener);
    return () => ipcRenderer.removeListener("update-available", listener);
  },
  onUpdateDownloadProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("update-download-progress", listener);
    return () => ipcRenderer.removeListener("update-download-progress", listener);
  },
  onUpdateDownloaded: (callback) => {
    const listener = (_event, update) => callback(update);
    ipcRenderer.on("update-downloaded", listener);
    return () => ipcRenderer.removeListener("update-downloaded", listener);
  },
  onUpdateError: (callback) => {
    const listener = (_event, error) => callback(error);
    ipcRenderer.on("update-error", listener);
    return () => ipcRenderer.removeListener("update-error", listener);
  },
  onWindowMaximizedChange: (callback) => {
    const listener = (_event, maximized) => callback(maximized);
    ipcRenderer.on("window-maximized-change", listener);
    return () => ipcRenderer.removeListener("window-maximized-change", listener);
  },
  getVersion: () => ipcRenderer.invoke("app-version"),
  getStartupSetting: () => ipcRenderer.invoke("startup-setting-read"),
  setStartupSetting: (enabled) => ipcRenderer.invoke("startup-setting-write", enabled),
  getUpdateState: () => ipcRenderer.invoke("update-state-read"),
  getPendingWhatsNewVersion: () => ipcRenderer.invoke("update-state-get-pending-whats-new"),
  clearPendingWhatsNewVersion: () => ipcRenderer.invoke("update-state-clear-pending"),
  markWhatsNewShown: (version) => ipcRenderer.invoke("update-state-mark-whats-new-shown", version),
  fetchReleaseNotesForVersion: (version) => ipcRenderer.invoke("fetch-release-notes", version),
  getValorantSkinsCatalog: () => ipcRenderer.invoke("valorant-skins-catalog"),
  loadCustomThemeImage: () => ipcRenderer.invoke("custom-theme-image-load"),
  saveCustomThemeImage: (dataUrl) => ipcRenderer.invoke("custom-theme-image-save", dataUrl),
  removeCustomThemeImage: () => ipcRenderer.invoke("custom-theme-image-remove"),
  getHenrikDevStatus: () => ipcRenderer.invoke("henrikdev-status"),
  setHenrikDevApiKey: (apiKey) => ipcRenderer.invoke("set-henrikdev-api-key", apiKey),
  getLiveMatchState: () => ipcRenderer.invoke("live-match-state"),
  lookupPlayerData: async (player) => {
    const result = await ipcRenderer.invoke("lookup-player-data", player);
    if (!result?.ok) throw new Error(result?.error || "Player lookup failed.");
    return result.data;
  },
  getVaultStatus: () => ipcRenderer.invoke("vault-status"),
  createVaultProfile: (profile) => ipcRenderer.invoke("vault-create-profile", profile),
  unlockVaultProfile: (credentials) => ipcRenderer.invoke("vault-unlock-profile", credentials),
  updateVaultProfile: (profile) => ipcRenderer.invoke("vault-update-profile", profile),
  deleteVaultProfile: (credentials) => ipcRenderer.invoke("vault-delete-profile", credentials),
  confirmDeleteVaultProfile: (profileName) => ipcRenderer.invoke("vault-confirm-delete-profile", profileName),
  changeVaultPasscode: (values) => ipcRenderer.invoke("vault-change-passcode", values),
  lockVault: () => ipcRenderer.invoke("vault-lock"),
  listVaultEntries: () => ipcRenderer.invoke("vault-list"),
  saveVaultEntry: (entry) => ipcRenderer.invoke("vault-save-entry", entry),
  updateVaultEntry: (id, entry) => ipcRenderer.invoke("vault-update-entry", id, entry),
  deleteVaultEntry: (id) => ipcRenderer.invoke("vault-delete-entry", id),
  revealVaultPassword: (id, passcode) => ipcRenderer.invoke("vault-reveal-password", { id, passcode }),
  copyVaultUsername: (id) => ipcRenderer.invoke("vault-copy-username", id),
  openRiotClient: (entryId) => ipcRenderer.invoke("open-riot-client", entryId),
  exportVaultBackup: () => ipcRenderer.invoke("vault-export-backup"),
  restoreVaultBackup: (passcode) => ipcRenderer.invoke("vault-restore-backup", passcode),
  copyVaultPassword: (id, passcode) => ipcRenderer.invoke("vault-copy-password", { id, passcode })
});
