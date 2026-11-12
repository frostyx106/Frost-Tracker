const { app, BrowserWindow, ipcMain, safeStorage, clipboard, dialog, shell, Tray, Menu, nativeImage } = require("electron");
const { autoUpdater } = require("electron-updater");
const fs = require("fs/promises");
const { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } = require("crypto");
const { spawn } = require("child_process");
const path = require("path");
const { promisify } = require("util");

const deriveVaultKey = promisify(scrypt);
const vaultKdfOptions = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const maxProfileAvatarBytes = 50 * 1024 * 1024;
const maxProfileAvatarDataUrlLength = Math.ceil(maxProfileAvatarBytes / 3) * 4 + 32;
const maxCustomThemeImageBytes = 12 * 1024 * 1024;

let mainWindow;
let tray;
let isQuitting = false;
const launchInTray = process.argv.includes("--hidden");
function getWindowsStartupSettings() {
  const path = process.execPath;
  const args = app.isPackaged
    ? ["--hidden"]
    : [`"${app.getAppPath()}"`, "--hidden"];
  return { path, args };
}

function repairWindowsStartupEntry() {
  const startupSettings = getWindowsStartupSettings();
  const currentSettings = app.getLoginItemSettings();
  if (!currentSettings.executableWillLaunchAtLogin ||
      app.getLoginItemSettings(startupSettings).openAtLogin) {
    return;
  }

  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      ...startupSettings
    });
    if (!app.getLoginItemSettings(startupSettings).openAtLogin) {
      console.error("Could not repair the KEEPER Windows startup entry.");
    }
  } catch (error) {
    console.error("Could not repair the KEEPER Windows startup entry.", error);
  }
}
let unlockedVault = null;
let failedVaultUnlocks = 0;
let vaultLockedUntil = 0;
let valorantAssetsPromise = null;
let henrikRequestQueue = Promise.resolve();
let lastHenrikRequestAt = 0;
let henrikCooldownUntil = 0;
const HENRIK_REQUEST_INTERVAL_MS = 1000;
const HENRIK_RATE_LIMIT_FALLBACK_MS = 60 * 1000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_REMINDER_INTERVAL_MS = 15 * 60 * 1000;
let availableUpdateInfo = null;
let updateRendererReady = false;
let updateSnoozedUntil = 0;
let updateReminderTimer = null;
let updateDownloadStarted = false;

const updateStatePath = () => path.join(app.getPath("userData"), "frost-update-state.json");

async function readUpdateState() {
  try {
    const contents = await fs.readFile(updateStatePath(), "utf8");
    const parsed = JSON.parse(contents);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error && error.code === "ENOENT") return {};
    console.warn("Could not read the app update state.", error);
    return {};
  }
}

async function persistUpdateState(state) {
  await fs.mkdir(path.dirname(updateStatePath()), { recursive: true });
  await fs.writeFile(updateStatePath(), JSON.stringify(state, null, 2), { mode: 0o600 });
}

async function setPendingWhatsNewVersion(version) {
  const normalizedVersion = typeof version === "string" ? version.trim() : "";
  if (!normalizedVersion) return null;
  const state = await readUpdateState();
  state.pendingWhatsNewVersion = normalizedVersion;
  await persistUpdateState(state);
  return normalizedVersion;
}

async function getPendingWhatsNewVersion() {
  const state = await readUpdateState();
  return typeof state.pendingWhatsNewVersion === "string" ? state.pendingWhatsNewVersion : null;
}

async function clearPendingWhatsNewVersion() {
  const state = await readUpdateState();
  state.pendingWhatsNewVersion = null;
  await persistUpdateState(state);
}

async function markWhatsNewShown(version) {
  const normalizedVersion = typeof version === "string" ? version.trim() : "";
  const state = await readUpdateState();
  const seenVersions = Array.isArray(state.seenWhatsNewVersions) ? state.seenWhatsNewVersions : [];
  if (normalizedVersion) {
    const uniqueVersions = new Set(seenVersions.filter(entry => typeof entry === "string"));
    uniqueVersions.add(normalizedVersion);
    state.seenWhatsNewVersions = [...uniqueVersions];
  }
  state.pendingWhatsNewVersion = null;
  await persistUpdateState(state);
}

async function getReleaseNotesForVersion(version) {
  const normalizedVersion = typeof version === "string" ? version.trim() : "";
  if (!normalizedVersion) {
    return { version: normalizedVersion, releaseNotes: "No release notes available for this update." };
  }
  const tag = normalizedVersion.startsWith("v") ? normalizedVersion : `v${normalizedVersion}`;
  try {
    const response = await fetch(`https://api.github.com/repos/frostyx106/Frost-Tracker/releases/tags/${tag}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Frost-Tracker"
      }
    });
    if (!response.ok) {
      return { version: normalizedVersion, releaseNotes: "No release notes available for this update." };
    }
    const payload = await response.json();
    const releaseNotes = typeof payload?.body === "string" && payload.body.trim()
      ? payload.body.trim()
      : "No release notes available for this update.";
    return { version: normalizedVersion, releaseNotes };
  } catch (error) {
    console.warn(`Could not fetch release notes for ${normalizedVersion}.`, error);
    return { version: normalizedVersion, releaseNotes: "No release notes available for this update." };
  }
}

function sendUpdateEvent(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed() || !updateRendererReady) return;
  mainWindow.webContents.send(channel, payload);
}

function showAvailableUpdate() {
  if (!availableUpdateInfo || Date.now() < updateSnoozedUntil) return;
  sendUpdateEvent("update-available", { version: availableUpdateInfo.version });
}

function reportUpdateError(error) {
  console.error("Automatic update failed.", error);
  if (!updateDownloadStarted) return;
  updateDownloadStarted = false;
  sendUpdateEvent("update-error", {
    message: error instanceof Error ? error.message : "The update could not be downloaded."
  });
}

function configureAutoUpdates() {
  if (!app.isPackaged || process.platform !== "win32") return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = true;
  autoUpdater.on("error", reportUpdateError);
  autoUpdater.on("update-available", info => {
    availableUpdateInfo = info;
    updateDownloadStarted = false;
    showAvailableUpdate();
  });
  autoUpdater.on("download-progress", progress => {
    sendUpdateEvent("update-download-progress", {
      transferred: progress.transferred,
      total: progress.total,
      percent: progress.percent
    });
  });
  autoUpdater.on("update-downloaded", async info => {
    console.info(`KEEPER ${info.version} downloaded; restarting to install.`);
    updateDownloadStarted = false;
    await setPendingWhatsNewVersion(info.version);
    sendUpdateEvent("update-downloaded", { version: info.version });
    setTimeout(() => autoUpdater.quitAndInstall(false, true), 1200);
  });

  const checkForUpdates = () => {
    autoUpdater.checkForUpdates().catch(error => {
      console.error("Could not check for KEEPER updates.", error);
    });
  };
  checkForUpdates();
  const updateCheckTimer = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
  updateCheckTimer.unref();
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    show: !launchInTray,
    frame: false,
    backgroundColor: "#090b10",
    icon: path.join(__dirname, "assets", "keeper.ico"),
    title: "KEEPER",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.setMenu(null);
  mainWindow.on("maximize", () => mainWindow.webContents.send("window-maximized-change", true));
  mainWindow.on("unmaximize", () => mainWindow.webContents.send("window-maximized-change", false));
  mainWindow.on("close", event => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.loadFile(path.join(__dirname, "src", "index.html"));
}

const apiKeyPath = () => path.join(app.getPath("userData"), "henrikdev-api-key.enc");
const legacyVaultPath = () => path.join(app.getPath("userData"), "frost-vault.enc");
const profileCatalogPath = () => path.join(app.getPath("userData"), "frost-profiles.json");
const customThemeImagePath = () => path.join(app.getPath("userData"), "frost-custom-theme-wallpaper.data-url");

function validateCustomThemeImageDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") {
    throw new Error("Choose a valid PNG, JPEG, WebP, or SVG theme image.");
  }
  const match = /^data:image\/(png|jpeg|webp|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0) {
    throw new Error("Choose a valid PNG, JPEG, WebP, or SVG theme image.");
  }
  const padding = match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0;
  const imageBytes = match[2].length / 4 * 3 - padding;
  if (imageBytes <= 0 || imageBytes > maxCustomThemeImageBytes) {
    throw new Error("Choose a theme image smaller than 12 MB.");
  }
  return dataUrl;
}

async function saveCustomThemeImage(dataUrl) {
  const image = validateCustomThemeImageDataUrl(dataUrl);
  const targetPath = customThemeImagePath();
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await fs.writeFile(temporaryPath, image, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, targetPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(cleanupError => {
      console.error("Could not clean up temporary custom theme image data.", cleanupError);
    });
    throw error;
  }
}

async function loadCustomThemeImage() {
  let dataUrl;
  try {
    dataUrl = await fs.readFile(customThemeImagePath(), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return validateCustomThemeImageDataUrl(dataUrl);
}

async function removeCustomThemeImage() {
  await fs.rm(customThemeImagePath(), { force: true });
}

function profileVaultPath(profileId) {
  if (profileId === "legacy") return legacyVaultPath();
  if (typeof profileId !== "string" || !/^[0-9a-f-]{36}$/i.test(profileId)) {
    throw new Error("Invalid vault profile.");
  }
  return path.join(app.getPath("userData"), `frost-profile-${profileId}.enc`);
}

function validateProfileName(name) {
  const normalizedName = typeof name === "string" ? name.trim() : "";
  if (!normalizedName || normalizedName.length > 40) {
    throw new Error("Profile name must be between 1 and 40 characters.");
  }
  return normalizedName;
}

function validateProfileAvatar(avatar) {
  if (avatar == null || avatar === "") return null;
  if (typeof avatar !== "string") {
    throw new Error("Choose a valid PNG, JPEG, WebP, or GIF profile picture.");
  }
  if (avatar.length > maxProfileAvatarDataUrlLength) {
    throw new Error("Choose a PNG, JPEG, WebP, or GIF image under 50 MB.");
  }
  const separator = avatar.indexOf(",");
  const contentType = avatar.slice(0, separator);
  const encodedImage = avatar.slice(separator + 1);
  if (!/^data:image\/(png|jpeg|webp|gif);base64$/.test(contentType) ||
      !encodedImage || encodedImage.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encodedImage)) {
    throw new Error("Choose a valid PNG, JPEG, WebP, or GIF profile picture.");
  }
  const padding = encodedImage.endsWith("==") ? 2 : encodedImage.endsWith("=") ? 1 : 0;
  const imageBytes = encodedImage.length / 4 * 3 - padding;
  if (!encodedImage || imageBytes > maxProfileAvatarBytes) {
    throw new Error("Choose a PNG, JPEG, WebP, or GIF image under 50 MB.");
  }
  return avatar;
}

async function loadVaultProfiles() {
  let catalog;
  try {
    catalog = JSON.parse(await fs.readFile(profileCatalogPath(), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("The profile catalog could not be read.");
    try {
      await fs.access(legacyVaultPath());
      return [{ id: "legacy", name: "Frosty", avatar: null, isMain: true }];
    } catch (legacyError) {
      if (legacyError.code === "ENOENT") return [];
      throw legacyError;
    }
  }

  if (![1, 2].includes(catalog.version) || !Array.isArray(catalog.profiles) || catalog.profiles.length > 5) {
    throw new Error("The profile catalog is invalid.");
  }
  const mainProfileId = Object.prototype.hasOwnProperty.call(catalog, "mainProfileId")
    ? catalog.mainProfileId
    : catalog.profiles[0]?.id || null;
  return catalog.profiles.map(profile => ({
    id: profile.id,
    name: validateProfileName(profile.name),
    avatar: validateProfileAvatar(profile.avatar),
    isMain: profile.id === mainProfileId
  }));
}

async function saveVaultProfiles(profiles) {
  if (profiles.length > 5) throw new Error("A maximum of five profiles is allowed.");
  const mainProfileId = profiles.find(profile => profile.isMain)?.id || null;
  const targetPath = profileCatalogPath();
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await fs.writeFile(temporaryPath, JSON.stringify({ version: 2, mainProfileId, profiles }), { mode: 0o600 });
    await fs.rename(temporaryPath, targetPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

function publicVaultProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    avatar: profile.avatar || null,
    isMain: profile.isMain === true
  };
}

function validateMasterPasscode(passcode, allowLegacyLetters = false) {
  const isNumericPasscode = typeof passcode === "string" && /^\d{6}$/.test(passcode);
  const isLegacyPasscode = allowLegacyLetters && typeof passcode === "string" && /^[A-Za-z]{6}$/.test(passcode);
  if (!isNumericPasscode && !isLegacyPasscode) {
    throw new Error("The master passcode must be exactly six digits.");
  }
}

async function decryptVaultFile(fileData, passcode) {
  validateMasterPasscode(passcode, true);
  if (!fileData || fileData.version !== 1) throw new Error("Unsupported or invalid vault backup.");
  const salt = Buffer.from(fileData.salt || "", "base64");
  const iv = Buffer.from(fileData.iv || "", "base64");
  const authTag = Buffer.from(fileData.authTag || "", "base64");
  const ciphertext = Buffer.from(fileData.ciphertext || "", "base64");
  if (salt.length !== 16 || iv.length !== 12 || authTag.length !== 16 || ciphertext.length > 10 * 1024 * 1024) {
    throw new Error("Invalid or oversized vault file.");
  }

  const key = await deriveVaultKey(passcode, salt, 32, vaultKdfOptions);
  try {
    const entries = decryptVaultEntries(fileData, key);
    return { salt, key, entries };
  } catch {
    key.fill(0);
    throw new Error("Incorrect passcode or damaged vault file.");
  }
}

function decryptVaultEntries(fileData, key) {
  const iv = Buffer.from(fileData.iv || "", "base64");
  const authTag = Buffer.from(fileData.authTag || "", "base64");
  const ciphertext = Buffer.from(fileData.ciphertext || "", "base64");
  if (iv.length !== 12 || authTag.length !== 16 || ciphertext.length > 10 * 1024 * 1024) {
    throw new Error("Invalid or oversized vault file.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const contents = JSON.parse(plaintext.toString("utf8"));
  if (contents.version !== 1 || !Array.isArray(contents.entries) || contents.entries.length > 1000) {
    throw new Error("Invalid vault contents.");
  }
  for (const entry of contents.entries) {
    if (!entry || typeof entry.id !== "string" || typeof entry.label !== "string" ||
        typeof entry.username !== "string" || typeof entry.password !== "string" ||
        typeof entry.notes !== "string") {
      throw new Error("Invalid vault entry.");
    }
  }
  return contents.entries;
}

function requireUnlockedVault() {
  if (!unlockedVault) throw new Error("Unlock the vault first.");
  return unlockedVault;
}

function listVaultEntries() {
  return requireUnlockedVault().entries.map(({ id, label, username, notes, updatedAt }) => ({
    id,
    label,
    username,
    notes,
    updatedAt
  }));
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createSystemTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, "assets", "keeper.png");
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) throw new Error(`Could not load the KEEPER tray icon at ${iconPath}.`);
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("KEEPER");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open KEEPER", click: showMainWindow },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
  tray.on("double-click", showMainWindow);
}

async function persistVault() {
  const vault = requireUnlockedVault();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", vault.key, iv);
  const plaintext = Buffer.from(JSON.stringify({ version: 1, entries: vault.entries }), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const fileData = {
    version: 1,
    salt: vault.salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
  const targetPath = vault.filePath || legacyVaultPath();
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(fileData), { mode: 0o600 });
    await fs.rename(temporaryPath, targetPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function createVaultProfile({ name, avatar, passcode, confirmation }) {
  validateMasterPasscode(passcode);
  if (passcode !== confirmation) throw new Error("The master passcodes do not match.");
  const profileName = validateProfileName(name);
  const profileAvatar = validateProfileAvatar(avatar);
  const profiles = await loadVaultProfiles();
  if (profiles.length >= 5) throw new Error("You can create up to five profiles.");

  const isMain = profiles.length === 0;
  const profile = {
    id: randomUUID(),
    name: profileName,
    avatar: profileAvatar,
    isMain
  };
  const salt = randomBytes(16);
  const key = await deriveVaultKey(passcode, salt, 32, vaultKdfOptions);
  unlockedVault = { salt, key, entries: [], profileId: profile.id, filePath: profileVaultPath(profile.id) };
  try {
    await persistVault();
    await saveVaultProfiles([...profiles, profile]);
  } catch (error) {
    await fs.rm(profileVaultPath(profile.id), { force: true });
    lockVault();
    throw error;
  }
  return { profile: publicVaultProfile(profile), profiles: [...profiles, profile].map(publicVaultProfile), entries: [] };
}

async function unlockVaultProfile({ profileId, passcode }) {
  const profiles = await loadVaultProfiles();
  const profile = profiles.find(candidate => candidate.id === profileId);
  if (!profile) throw new Error("Select a valid profile.");
  validateMasterPasscode(passcode, profile.id === "legacy");
  const waitMilliseconds = vaultLockedUntil - Date.now();
  if (waitMilliseconds > 0) {
    throw new Error(`Too many attempts. Try again in ${Math.ceil(waitMilliseconds / 1000)} seconds.`);
  }

  let fileData;
  try {
    fileData = JSON.parse(await fs.readFile(profileVaultPath(profile.id), "utf8"));
  } catch {
    throw new Error("The vault file could not be read.");
  }

  try {
    const decrypted = await decryptVaultFile(fileData, passcode);
    unlockedVault = { ...decrypted, profileId: profile.id, filePath: profileVaultPath(profile.id) };
    if (profile.id === "legacy") await saveVaultProfiles(profiles);
    failedVaultUnlocks = 0;
    vaultLockedUntil = 0;
    return { profile: publicVaultProfile(profile), profiles: profiles.map(publicVaultProfile), entries: listVaultEntries() };
  } catch {
    failedVaultUnlocks += 1;
    if (failedVaultUnlocks >= 5) {
      const delaySeconds = Math.min(300, 30 * (2 ** (failedVaultUnlocks - 5)));
      vaultLockedUntil = Date.now() + delaySeconds * 1000;
    }
    throw new Error("Incorrect passcode or damaged vault. Check the code and try again.");
  }
}

async function changeVaultPasscode({ currentPasscode, newPasscode, confirmation }) {
  const currentVault = requireUnlockedVault();
  validateMasterPasscode(currentPasscode, true);
  validateMasterPasscode(newPasscode);
  if (newPasscode !== confirmation) throw new Error("The new passcodes do not match.");
  if (Date.now() < vaultLockedUntil) {
    throw new Error(`Too many attempts. Try again in ${Math.ceil((vaultLockedUntil - Date.now()) / 1000)} seconds.`);
  }

  let fileData;
  try {
    fileData = JSON.parse(await fs.readFile(currentVault.filePath, "utf8"));
  } catch {
    throw new Error("The local vault could not be read.");
  }

  let verifiedVault;
  try {
    verifiedVault = await decryptVaultFile(fileData, currentPasscode);
  } catch {
    failedVaultUnlocks += 1;
    if (failedVaultUnlocks >= 5) {
      const delaySeconds = Math.min(300, 30 * (2 ** (failedVaultUnlocks - 5)));
      vaultLockedUntil = Date.now() + delaySeconds * 1000;
    }
    throw new Error("Current passcode is incorrect, or the vault is damaged.");
  }

  const salt = randomBytes(16);
  const key = await deriveVaultKey(newPasscode, salt, 32, vaultKdfOptions);
  unlockedVault = { salt, key, entries: verifiedVault.entries, profileId: currentVault.profileId, filePath: currentVault.filePath };
  try {
    await persistVault();
  } catch (error) {
    unlockedVault = currentVault;
    key.fill(0);
    verifiedVault.key.fill(0);
    for (const entry of verifiedVault.entries) {
      entry.label = "";
      entry.username = "";
      entry.password = "";
      entry.notes = "";
    }
    verifiedVault.entries.length = 0;
    throw error;
  }

  currentVault.key.fill(0);
  for (const entry of currentVault.entries) {
    entry.label = "";
    entry.username = "";
    entry.password = "";
    entry.notes = "";
  }
  currentVault.entries.length = 0;
  verifiedVault.key.fill(0);
  failedVaultUnlocks = 0;
  vaultLockedUntil = 0;
  return listVaultEntries();
}

function lockVault() {
  if (unlockedVault) {
    if (unlockedVault.key) unlockedVault.key.fill(0);
    for (const entry of unlockedVault.entries) {
      entry.label = "";
      entry.username = "";
      entry.password = "";
      entry.notes = "";
    }
    unlockedVault.entries.length = 0;
  }
  unlockedVault = null;
  return true;
}

async function saveVaultEntry(entry) {
  const vault = requireUnlockedVault();
  if (!entry || typeof entry !== "object") throw new Error("Enter a valid vault item.");
  const label = typeof entry.label === "string" ? entry.label.trim() : "";
  const username = typeof entry.username === "string" ? entry.username.trim() : "";
  const password = typeof entry.password === "string" ? entry.password : "";
  const notes = typeof entry.notes === "string" ? entry.notes.trim() : "";
  if (!label || label.length > 80 || !username || username.length > 256 || !password || password.length > 4096 || notes.length > 2000) {
    throw new Error("Enter a label, username, and password. Notes must be under 2,000 characters.");
  }
  const now = new Date().toISOString();
  const savedEntry = { id: randomUUID(), label, username, password, notes, updatedAt: now };
  vault.entries.unshift(savedEntry);
  try {
    await persistVault();
  } catch (error) {
    vault.entries = vault.entries.filter(entry => entry.id !== savedEntry.id);
    throw error;
  }
  return listVaultEntries();
}

async function updateVaultEntry(id, entry) {
  const vault = requireUnlockedVault();
  if (typeof id !== "string") throw new Error("Select a valid vault item.");
  if (!entry || typeof entry !== "object") throw new Error("Enter a valid vault item.");
  const index = vault.entries.findIndex(item => item.id === id);
  if (index < 0) throw new Error("Vault item not found.");
  const label = typeof entry.label === "string" ? entry.label.trim() : "";
  const username = typeof entry.username === "string" ? entry.username.trim() : "";
  const password = typeof entry.password === "string" ? entry.password : "";
  const notes = typeof entry.notes === "string" ? entry.notes.trim() : "";
  if (!label || label.length > 80 || !username || username.length > 256 || !password || password.length > 4096 || notes.length > 2000) {
    throw new Error("Enter a label, username, and password. Notes must be under 2,000 characters.");
  }
  const previousEntry = vault.entries[index];
  vault.entries[index] = {
    id,
    label,
    username,
    password,
    notes,
    updatedAt: new Date().toISOString()
  };
  try {
    await persistVault();
  } catch (error) {
    vault.entries[index] = previousEntry;
    throw error;
  }
  return listVaultEntries();
}

async function deleteVaultEntry(id) {
  const vault = requireUnlockedVault();
  if (typeof id !== "string") throw new Error("Select a valid vault item.");
  const previousEntries = vault.entries;
  vault.entries = previousEntries.filter(entry => entry.id !== id);
  try {
    await persistVault();
  } catch (error) {
    vault.entries = previousEntries;
    throw error;
  }
  return listVaultEntries();
}

async function updateVaultProfile({ name, avatar }) {
  const vault = requireUnlockedVault();
  const profiles = await loadVaultProfiles();
  const index = profiles.findIndex(profile => profile.id === vault.profileId);
  if (index < 0) throw new Error("The active profile could not be found.");
  const updatedProfile = {
    ...profiles[index],
    name: validateProfileName(name),
    avatar: validateProfileAvatar(avatar)
  };
  profiles[index] = updatedProfile;
  await saveVaultProfiles(profiles);
  return { profile: publicVaultProfile(updatedProfile), profiles: profiles.map(publicVaultProfile) };
}

async function deleteVaultProfile({ profileId, passcode }) {
  const profiles = await loadVaultProfiles();
  const profile = profiles.find(candidate => candidate.id === profileId);
  if (!profile) throw new Error("Profile not found.");
  validateMasterPasscode(passcode, profile.id === "legacy");
  const waitMilliseconds = vaultLockedUntil - Date.now();
  if (waitMilliseconds > 0) {
    throw new Error(`Too many attempts. Try again in ${Math.ceil(waitMilliseconds / 1000)} seconds.`);
  }

  let fileData;
  try {
    fileData = JSON.parse(await fs.readFile(profileVaultPath(profile.id), "utf8"));
  } catch {
    throw new Error("The vault file could not be read.");
  }

  let verifiedVault;
  try {
    verifiedVault = await decryptVaultFile(fileData, passcode);
    failedVaultUnlocks = 0;
    vaultLockedUntil = 0;
  } catch {
    failedVaultUnlocks += 1;
    if (failedVaultUnlocks >= 5) {
      const delaySeconds = Math.min(300, 30 * (2 ** (failedVaultUnlocks - 5)));
      vaultLockedUntil = Date.now() + delaySeconds * 1000;
    }
    throw new Error("Incorrect passcode or damaged vault. Check the code and try again.");
  } finally {
    if (verifiedVault) {
      verifiedVault.key.fill(0);
      for (const entry of verifiedVault.entries) {
        entry.label = "";
        entry.username = "";
        entry.password = "";
        entry.notes = "";
      }
    }
  }

  const remainingProfiles = profiles.filter(candidate => candidate.id !== profileId);
  const vaultPath = profileVaultPath(profileId);
  const deletionPath = `${vaultPath}.${randomUUID()}.deleting`;
  await fs.rename(vaultPath, deletionPath);
  try {
    await saveVaultProfiles(remainingProfiles);
  } catch (error) {
    await fs.rename(deletionPath, vaultPath);
    throw error;
  }
  if (unlockedVault?.profileId === profileId) lockVault();
  await fs.rm(deletionPath);
  failedVaultUnlocks = 0;
  vaultLockedUntil = 0;
  return remainingProfiles.map(publicVaultProfile);
}

function getVaultEntryPassword(id) {
  const entry = requireUnlockedVault().entries.find(item => item.id === id);
  if (!entry) throw new Error("Vault item not found.");
  return entry.password;
}

async function exportVaultBackup() {
  const vault = requireUnlockedVault();
  const profile = (await loadVaultProfiles()).find(item => item.id === vault.profileId);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Save encrypted KEEPER vault backup",
    defaultPath: path.join(app.getPath("documents"), `frost-${profile?.name || "profile"}-${new Date().toISOString().slice(0, 10)}.ftvault`),
    filters: [{ name: "KEEPER encrypted vault", extensions: ["ftvault"] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.copyFile(vault.filePath, result.filePath);
  return { canceled: false };
}

async function restoreVaultBackup({ passcode }) {
  validateMasterPasscode(passcode, true);
  const profiles = await loadVaultProfiles();
  if (profiles.length >= 5) throw new Error("Delete a profile before restoring another one. The maximum is five.");
  const isMain = profiles.length === 0;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Restore encrypted KEEPER vault backup",
    properties: ["openFile"],
    filters: [{ name: "KEEPER encrypted vault", extensions: ["ftvault"] }]
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };

  const backupPath = result.filePaths[0];
  const stats = await fs.stat(backupPath);
  if (stats.size > 10 * 1024 * 1024) throw new Error("Vault backup exceeds the 10 MB limit.");
  const fileData = JSON.parse(await fs.readFile(backupPath, "utf8"));
  const restoredVault = await decryptVaultFile(fileData, passcode);
  const profile = {
    id: randomUUID(),
    name: validateProfileName(path.basename(backupPath, path.extname(backupPath)).slice(0, 40) || "Restored profile"),
    avatar: null,
    isMain
  };
  const targetPath = profileVaultPath(profile.id);
  try {
    await fs.copyFile(backupPath, targetPath);
    await saveVaultProfiles([...profiles, profile]);
  } catch (error) {
    await fs.rm(targetPath, { force: true });
    restoredVault.key.fill(0);
    throw error;
  }
  lockVault();
  unlockedVault = { ...restoredVault, profileId: profile.id, filePath: targetPath };
  failedVaultUnlocks = 0;
  vaultLockedUntil = 0;
  return {
    canceled: false,
    profile: publicVaultProfile(profile),
    profiles: [...profiles, profile].map(publicVaultProfile),
    entries: listVaultEntries()
  };
}

async function openAndFillRiotClient(entryId) {
  const entry = requireUnlockedVault().entries.find(item => item.id === entryId);
  if (!entry) throw new Error("Select an account from the vault first.");
  const credentials = { username: entry.username, password: entry.password };

  await shell.openExternal("riotclient://launch-product=valorant&launch-patchline=live");
  const helperPath = app.isPackaged
    ? path.join(process.resourcesPath, "scripts", "fill-riot-login.ps1")
    : path.join(__dirname, "scripts", "fill-riot-login.ps1");
  await fs.access(helperPath);

  return new Promise((resolve, reject) => {
    const helper = spawn("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-STA",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      helperPath
    ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let errorOutput = "";

    helper.stdout.setEncoding("utf8");
    helper.stdout.on("data", chunk => { output += chunk; });
    helper.stderr.setEncoding("utf8");
    helper.stderr.on("data", chunk => { errorOutput += chunk; });
    helper.on("error", () => reject(new Error("Could not start the Riot Client autofill helper.")));
    helper.on("close", code => {
      const resultLine = output.trim().split(/\r?\n/).reverse().find(line => {
        try {
          JSON.parse(line);
          return true;
        } catch {
          return false;
        }
      });
      if (!resultLine) {
        const details = errorOutput.trim() || output.trim() || "The Riot helper returned no output.";
        reject(new Error(`Could not read the Riot Client helper response. Details: ${details}. You can still copy credentials manually.`));
        return;
      }
      const result = JSON.parse(resultLine);
      if (code !== 0 || !result.ok) {
        const details = [result.message, errorOutput.trim()].filter(Boolean).join(" ");
        reject(new Error(details || "Riot Client sign-in fields were not available."));
        return;
      }
      resolve({ message: result.message });
    });
    helper.stdin.on("error", () => {});
    helper.stdin.end(JSON.stringify(credentials));
  });
}

async function getHenrikDevApiKey() {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure local storage is unavailable on this device.");
  }
  try {
    const encryptedKey = await fs.readFile(apiKeyPath());
    return safeStorage.decryptString(encryptedKey);
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

const henrikLogPath = () => path.join(app.getPath("userData"), "henrikdev.log");

function maskApiKey(apiKey) {
  if (typeof apiKey !== "string" || !apiKey) return "(none)";
  return apiKey.length <= 8 ? `${apiKey.length} chars` : `${apiKey.slice(0, 4)}…${apiKey.slice(-2)} (${apiKey.length} chars)`;
}

async function logHenrikDev(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(`[HenrikDev] ${message}`);
  try {
    const logPath = henrikLogPath();
    const stats = await fs.stat(logPath).catch(() => null);
    if (stats && stats.size > 1024 * 1024) await fs.rm(logPath, { force: true });
    await fs.appendFile(logPath, `${line}\n`, "utf8");
  } catch (error) {
    console.warn("Could not write HenrikDev log.", error);
  }
}

async function fetchHenrikDevData(url, apiKey, notFoundMessage) {
  const request = henrikRequestQueue.then(async () => {
    const waitMs = Math.max(
      henrikCooldownUntil - Date.now(),
      HENRIK_REQUEST_INTERVAL_MS - (Date.now() - lastHenrikRequestAt),
      0
    );
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    lastHenrikRequestAt = Date.now();

    const startedAt = Date.now();
    let response;
    try {
      response = await fetch(url, {
        headers: { Authorization: apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(15000)
      });
    } catch (error) {
      const cause = error?.cause?.code || error?.cause?.message || "";
      await logHenrikDev(`NETWORK ERROR ${String(url)} after ${Date.now() - startedAt}ms: ${error?.name || "Error"}: ${error?.message || error}${cause ? ` (cause: ${cause})` : ""} key=${maskApiKey(apiKey)}`);
      throw new Error(error?.name === "TimeoutError"
        ? "HenrikDev did not respond within 15 seconds."
        : `Could not reach HenrikDev: ${error?.message || "network error"}${cause ? ` (${cause})` : ""}.`);
    }
    const rawBody = await response.text().catch(() => "");
    let payload = null;
    try { payload = rawBody ? JSON.parse(rawBody) : null; } catch { payload = null; }
    await logHenrikDev(`${response.status} ${response.statusText} ${String(url)} (${Date.now() - startedAt}ms) key=${maskApiKey(apiKey)}${response.ok ? "" : ` body=${rawBody.slice(0, 2000)}`}`);

    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      const retrySeconds = Number(retryAfter);
      const retryAt = retryAfter && !Number.isFinite(retrySeconds) ? Date.parse(retryAfter) : NaN;
      if (response.status === 429) {
        const retryMs = Number.isFinite(retrySeconds) && retrySeconds > 0
          ? retrySeconds * 1000
          : Number.isFinite(retryAt) && retryAt > Date.now()
            ? retryAt - Date.now()
            : HENRIK_RATE_LIMIT_FALLBACK_MS;
        henrikCooldownUntil = Math.max(henrikCooldownUntil, Date.now() + retryMs);
      }
      const retryMs = Math.max(henrikCooldownUntil - Date.now(), 0);
      const waitDescription = response.status === 429
        ? ` Retry in about ${Math.ceil(retryMs / 1000)} seconds.`
        : "";
      const messages = {
        401: "HenrikDev rejected the API key. Check it in Settings.",
        403: "This API key is not allowed to use the requested endpoint.",
        404: notFoundMessage,
        429: `HenrikDev rate limit reached.${waitDescription}`
      };
      const apiError = payload?.errors?.[0];
      const apiMessage = apiError?.message || apiError?.details || payload?.message || payload?.error || "";
      throw new Error(messages[response.status] ||
        (apiMessage ? `HenrikDev error ${response.status}: ${apiMessage}` : "") ||
        `HenrikDev could not retrieve this player's data (HTTP ${response.status}). See henrikdev.log in the app data folder.`);
    }
    return payload?.data;
  });
  henrikRequestQueue = request.then(() => undefined, () => undefined);
  return request;
}

async function fetchRecentMatchPages(matchesUrl, apiKey) {
  const pageSize = 30;
  const maxMatches = 30;
  const matches = [];
  const pageErrors = [];
  let reachedRequiredHistory = false;
  let start = 0;
  while (matches.length < maxMatches) {
    const url = new URL(matchesUrl);
    url.searchParams.set("size", String(pageSize));
    url.searchParams.set("start", String(start));
    let page;
    try {
      page = await fetchHenrikDevData(url, apiKey, "No recent matches were found for this account.");
    } catch (error) {
      if (!matches.length) throw error;
      pageErrors.push(error.message || "A match-history page could not be loaded.");
      break;
    }
    if (!Array.isArray(page)) {
      if (!matches.length) throw new Error("HenrikDev returned an invalid recent match-history response.");
      pageErrors.push("HenrikDev returned an invalid match-history page.");
      break;
    }
    if (!page.length) {
      reachedRequiredHistory = true;
      break;
    }
    const knownMatchIds = new Set(matches.map(match =>
      match.metadata?.match_id || match.metadata?.started_at
    ).filter(Boolean));
    const newMatches = page.filter(match => {
      const id = match.metadata?.match_id || match.metadata?.started_at;
      return !id || !knownMatchIds.has(id);
    });
    if (!newMatches.length) {
      pageErrors.push("Match history pagination stopped because HenrikDev repeated a page.");
      break;
    }
    matches.push(...newMatches.slice(0, maxMatches - matches.length));
    start += page.length;
  }
  const getStartedAt = match => {
    const value = match.metadata?.started_at;
    if (typeof value === "number" && Number.isFinite(value)) {
      return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
      const timestamp = Number(value);
      return timestamp < 1e12 ? timestamp * 1000 : timestamp;
    }
    const timestamp = Date.parse(value || "");
    return Number.isFinite(timestamp) ? timestamp : 0;
  };
  const uniqueMatches = [...new Map(matches.map((match, index) => [
    match.metadata?.match_id || `${match.metadata?.started_at || "match"}-${index}`,
    match
  ])).values()].sort((left, right) =>
    getStartedAt(right) - getStartedAt(left)
  );
  return {
    matches: uniqueMatches.slice(0, 30),
    analyticsMatches: uniqueMatches,
    error: pageErrors.join(" ")
  };
}

async function fetchValorantAssets() {
  if (!valorantAssetsPromise) {
    valorantAssetsPromise = Promise.allSettled([
      fetch("https://valorant-api.com/v1/agents?isPlayableCharacter=true", {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8000)
      }),
      fetch("https://valorant-api.com/v1/competitivetiers", {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8000)
      })
    ]).then(async ([agentsResult, tiersResult]) => {
      const readData = async result => {
        if (result.status !== "fulfilled" || !result.value.ok) return [];
        const payload = await result.value.json();
        return Array.isArray(payload?.data) ? payload.data : [];
      };
      const [agents, tierSets] = await Promise.all([readData(agentsResult), readData(tiersResult)]);
      const agentAssets = new Map(agents.flatMap(agent => {
        const asset = {
          icon: agent.displayIconSmall || agent.displayIcon || "",
          portrait: agent.fullPortrait || agent.bustPortrait || "",
          role: agent.role?.displayName || ""
        };
        return [agent.displayName, agent.uuid]
          .map(normalizeAgentAssetKey)
          .filter(Boolean)
          .map(key => [key, asset]);
      }));
      const rankAssets = new Map();
      for (const tierSet of tierSets) {
        for (const tier of tierSet.tiers || []) {
          if (tier.tierName && tier.smallIcon) {
            rankAssets.set(tier.tierName.toLowerCase(), tier.smallIcon);
          }
        }
      }
      return { agentAssets, rankAssets };
    }).catch(error => {
      console.warn("Could not retrieve optional VALORANT art assets.", error);
      return { agentAssets: new Map(), rankAssets: new Map() };
    });
  }
  return valorantAssetsPromise;
}

function normalizeAgentAssetKey(value) {
  return typeof value === "string" ? value.trim().toLocaleLowerCase("en-US") : "";
}

function normalizeMatches(matches, puuid, agentAssets) {
  if (!Array.isArray(matches)) return [];

  return matches.flatMap(match => {
    const player = match.players?.find(entry => entry.puuid === puuid);
    if (!player) return [];
    const ownTeam = match.teams?.find(team => team.team_id === player.team_id);
    const otherTeam = match.teams?.find(team => team.team_id !== player.team_id);

    const stats = player.stats || {};
    const roundsPlayed = (ownTeam?.rounds?.won || 0) + (otherTeam?.rounds?.won || 0);
    const kills = Number(stats.kills) || 0;
    const deaths = Number(stats.deaths) || 0;
    const assists = Number(stats.assists) || 0;
    const headshots = Number(stats.headshots) || 0;
    const bodyshots = Number(stats.bodyshots) || 0;
    const legshots = Number(stats.legshots) || 0;
    const shots = headshots + bodyshots + legshots;
    const headshotRate = shots ? Math.round((headshots / shots) * 100) : null;
    const agentDetails = player.agent;
    const agentNameValue = typeof agentDetails === "string" ? agentDetails : agentDetails?.name;
    const agentName = typeof agentNameValue === "string" ? agentNameValue.trim() || "Unknown agent" : "Unknown agent";
    const agentAssetKeys = [
      agentName,
      typeof agentDetails === "string" ? agentDetails : "",
      agentDetails?.displayName,
      agentDetails?.id,
      agentDetails?.uuid
    ].map(normalizeAgentAssetKey).filter(Boolean);
    const agentAsset = agentAssetKeys
      .map(key => agentAssets.get(key))
      .find(Boolean);
    const agentRole = player.agent?.role;
    const season = match.metadata?.season;
    const seasonId = typeof season === "string" ? season : season?.id || season?.short || "";
    const seasonLabel = typeof season === "string" ? season : season?.short || season?.id || "";

    return [{
      id: match.metadata?.match_id || `${match.metadata?.started_at || "match"}-${player.puuid}`,
      result: ownTeam?.won === true ? "W" : ownTeam?.won === false ? "L" : ownTeam?.won === null ? "D" : "—",
      map: match.metadata?.map?.name || "Unknown map",
      agent: agentName,
      agentIcon: agentAsset?.icon || "",
      agentPortrait: agentAsset?.portrait || "",
      role: typeof agentRole === "string" ? agentRole : agentRole?.name || agentAsset?.role || "",
      queue: match.metadata?.queue?.name || match.metadata?.mode || "Unknown mode",
      seasonId,
      seasonLabel,
      startedAt: match.metadata?.started_at || null,
      score: ownTeam && otherTeam
        ? `${ownTeam.rounds?.won ?? 0} - ${otherTeam.rounds?.won ?? 0}`
        : "—",
      kills,
      deaths,
      assists,
      headshots,
      bodyshots,
      legshots,
      roundsPlayed,
      kda: `${kills} / ${deaths} / ${assists}`,
      acs: roundsPlayed ? Math.round((stats.score || 0) / roundsPlayed) : null,
      hs: headshotRate === null ? "—" : `${headshotRate}%`
    }];
  });
}

function getValorantImageUrl(value) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "media.valorant-api.com" ? url.href : "";
  } catch {
    return "";
  }
}

async function fetchValorantPlayerCard(cardId) {
  if (!cardId) return null;
  try {
    const response = await fetch(`https://valorant-api.com/v1/playercards/${cardId}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload?.data || null;
  } catch (error) {
    console.warn("Could not retrieve optional player-card artwork.", error);
    return null;
  }
}

async function lookupPlayerData({ name, tag }) {
  const playerName = typeof name === "string" ? name.trim() : "";
  const playerTag = typeof tag === "string" ? tag.trim() : "";
  const validAffinities = new Set(["na", "eu", "ap", "kr", "latam", "br"]);

  if (!playerName || playerName.length > 64 || !playerTag || playerTag.length > 32) {
    throw new Error("Enter a valid Riot ID name and tag.");
  }

  const apiKey = await getHenrikDevApiKey();
  await logHenrikDev(`Lookup ${playerName}#${playerTag} — stored key ${maskApiKey(apiKey)}`);
  if (!apiKey) throw new Error("Add your HenrikDev API key in Settings first.");

  const encodedName = encodeURIComponent(playerName);
  const encodedTag = encodeURIComponent(playerTag);
  const accountUrl = new URL(`https://api.henrikdev.xyz/valorant/v2/account/${encodedName}/${encodedTag}`);
  const account = await fetchHenrikDevData(accountUrl, apiKey, "No VALORANT account was found for that Riot ID.");
  const region = typeof account?.region === "string" ? account.region.toLowerCase() : "";
  const platforms = Array.isArray(account?.platforms)
    ? account.platforms.map(platform => String(platform).toLowerCase())
    : [];
  const playerPlatform = platforms.includes("pc") ? "pc" : platforms.includes("console") ? "console" : "";
  await logHenrikDev(`Account resolved: region=${region || "(none)"} platforms=${JSON.stringify(platforms)} -> using ${playerPlatform || "(none)"}`);

  if (!validAffinities.has(region) || !playerPlatform) {
    throw new Error("HenrikDev could not determine a supported region and platform for this account.");
  }

  const mmrUrl = new URL(`https://api.henrikdev.xyz/valorant/v3/mmr/${region}/${playerPlatform}/${encodedName}/${encodedTag}`);
  const matchesUrl = new URL(`https://api.henrikdev.xyz/valorant/v4/matches/${region}/${playerPlatform}/${encodedName}/${encodedTag}`);
  const [rankResult, matchesResult, assetsResult] = await Promise.allSettled([
    fetchHenrikDevData(mmrUrl, apiKey, "No competitive rank data was found for this account."),
    fetchRecentMatchPages(matchesUrl, apiKey),
    fetchValorantAssets()
  ]);

  if (rankResult.status === "rejected") throw rankResult.reason;
  const payload = rankResult.value;
  if (!payload?.account || !payload?.current) {
    throw new Error("HenrikDev returned an incomplete rank response.");
  }
  const matchData = matchesResult.status === "fulfilled" ? matchesResult.value.analyticsMatches : [];
  const assets = assetsResult.status === "fulfilled"
    ? assetsResult.value
    : { agentAssets: new Map(), rankAssets: new Map() };
  const accountCardValue = account.card || payload.account.card || account.player_card ||
    payload.account.player_card || account.card_id || payload.account.card_id || {};
  const accountCard = typeof accountCardValue === "object" && accountCardValue !== null
    ? accountCardValue
    : {};
  const cardIdValue = typeof accountCardValue === "string"
    ? accountCardValue
    : accountCard.id || accountCard.uuid || accountCardValue?.card_id;
  const cardId = typeof cardIdValue === "string" && /^[0-9a-f-]{36}$/i.test(cardIdValue)
    ? cardIdValue
    : "";
  const [playerCardResult] = await Promise.allSettled([fetchValorantPlayerCard(cardId)]);
  const playerCard = playerCardResult.status === "fulfilled" ? playerCardResult.value : null;
  const cardArt = getValorantImageUrl(accountCard.wide) ||
    getValorantImageUrl(playerCard?.wideArt) ||
    (cardId ? `https://media.valorant-api.com/playercards/${cardId}/wideart.png` : "");
  const cardAvatar = getValorantImageUrl(accountCard.displayIcon) ||
    getValorantImageUrl(playerCard?.displayIcon) ||
    getValorantImageUrl(accountCard.smallArt) ||
    getValorantImageUrl(playerCard?.smallArt) ||
    getValorantImageUrl(accountCard.large) ||
    getValorantImageUrl(accountCard.small) ||
    getValorantImageUrl(playerCard?.largeArt) ||
    (cardId ? `https://media.valorant-api.com/playercards/${cardId}/largeart.png` : "");
  const currentTierName = payload.current.tier?.name || "";
  const peakTierName = payload.peak?.tier?.name || "";
  const normalizedMatches = normalizeMatches(matchData, account.puuid, assets.agentAssets);

  return {
    ...payload,
    account: {
      ...payload.account,
      region,
      platform: playerPlatform,
      level: Number(account.account_level ?? account.level ?? payload.account.level) || null,
      cardArt,
      cardAvatar
    },
    current: {
      ...payload.current,
      rankIcon: assets.rankAssets.get(currentTierName.toLowerCase()) || ""
    },
    peak: payload.peak ? {
      ...payload.peak,
      tier: {
        ...payload.peak.tier,
        icon: assets.rankAssets.get(peakTierName.toLowerCase()) || ""
      }
    } : payload.peak,
    matches: normalizedMatches.slice(0, 30),
    analyticsMatches: normalizedMatches,
    matchesError: matchesResult.status === "rejected"
      ? matchesResult.reason.message
      : matchesResult.value.error
  };
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });
}

app.on("activate", () => {
  showMainWindow();
});

app.whenReady().then(() => {
  if (process.platform === "win32") repairWindowsStartupEntry();
  createSystemTray();
  createMainWindow();
  configureAutoUpdates();
  ipcMain.handle("window-control", (event, action) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window !== mainWindow || window.isDestroyed()) {
      throw new Error("The app window is unavailable.");
    }

    if (action === "minimize") {
      window.minimize();
    } else if (action === "toggle-maximize") {
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
      return window.isMaximized();
    } else if (action === "close") {
      window.close();
    } else {
      throw new Error("Invalid window action.");
    }
    return false;
  });
  ipcMain.handle("updates-ready", () => {
    updateRendererReady = true;
    showAvailableUpdate();
  });
  ipcMain.handle("update-download", () => {
    if (!availableUpdateInfo) throw new Error("No update is currently available.");
    if (updateDownloadStarted) return true;
    updateSnoozedUntil = 0;
    if (updateReminderTimer) clearTimeout(updateReminderTimer);
    updateReminderTimer = null;
    updateDownloadStarted = true;
    autoUpdater.downloadUpdate().catch(reportUpdateError);
    return true;
  });
  ipcMain.handle("update-later", () => {
    if (!availableUpdateInfo) return false;
    updateSnoozedUntil = Date.now() + UPDATE_REMINDER_INTERVAL_MS;
    if (updateReminderTimer) clearTimeout(updateReminderTimer);
    updateReminderTimer = setTimeout(() => {
      updateReminderTimer = null;
      updateSnoozedUntil = 0;
      showAvailableUpdate();
    }, UPDATE_REMINDER_INTERVAL_MS);
    updateReminderTimer.unref();
    return true;
  });
  ipcMain.handle("app-version", () => app.getVersion());
  ipcMain.handle("startup-setting-read", () => {
    if (process.platform !== "win32") return { supported: false, enabled: false };
    const startupSettings = getWindowsStartupSettings();
    return {
      supported: true,
      enabled: app.getLoginItemSettings(startupSettings).openAtLogin
    };
  });
  ipcMain.handle("startup-setting-write", (_event, enabled) => {
    if (process.platform !== "win32") throw new Error("Starting with Windows is available only on Windows.");
    if (typeof enabled !== "boolean") throw new Error("Choose whether KEEPER should start with Windows.");
    const startupSettings = getWindowsStartupSettings();
    app.setLoginItemSettings({
      openAtLogin: enabled,
      ...startupSettings
    });
    const isEnabled = app.getLoginItemSettings(startupSettings).openAtLogin;
    if (isEnabled !== enabled) {
      throw new Error("Windows did not save the startup setting. Try running KEEPER as your Windows user and check startup-app permissions.");
    }
    return isEnabled;
  });
  ipcMain.handle("update-state-read", () => readUpdateState());
  ipcMain.handle("update-state-clear-pending", () => clearPendingWhatsNewVersion());
  ipcMain.handle("update-state-mark-whats-new-shown", (_event, version) => markWhatsNewShown(version));
  ipcMain.handle("update-state-get-pending-whats-new", () => getPendingWhatsNewVersion());
  ipcMain.handle("fetch-release-notes", (_event, version) => getReleaseNotesForVersion(version));
  ipcMain.handle("custom-theme-image-load", () => loadCustomThemeImage());
  ipcMain.handle("custom-theme-image-save", (_event, dataUrl) => saveCustomThemeImage(dataUrl));
  ipcMain.handle("custom-theme-image-remove", () => removeCustomThemeImage());
  ipcMain.handle("henrikdev-status", async () => {
    const secureStorageAvailable = safeStorage.isEncryptionAvailable();
    return {
      secureStorageAvailable,
      configured: secureStorageAvailable && Boolean(await getHenrikDevApiKey())
    };
  });
  ipcMain.handle("set-henrikdev-api-key", async (_event, apiKey) => {
    if (typeof apiKey !== "string") throw new Error("Enter a valid HenrikDev API key.");
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      await fs.rm(apiKeyPath(), { force: true });
    } else {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("Secure local storage is unavailable; the API key was not saved.");
      }
      await fs.mkdir(app.getPath("userData"), { recursive: true });
      await fs.writeFile(apiKeyPath(), safeStorage.encryptString(trimmedKey), { mode: 0o600 });
    }
    return { configured: Boolean(trimmedKey) };
  });
  ipcMain.handle("lookup-player-data", async (_event, player) => {
    try {
      return { ok: true, data: await lookupPlayerData(player) };
    } catch (error) {
      await logHenrikDev(`Lookup FAILED: ${error?.stack || error?.message || error}`);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Player lookup failed."
      };
    }
  });
  ipcMain.handle("vault-status", async () => {
    const profiles = await loadVaultProfiles();
    return {
      exists: profiles.length > 0,
      unlocked: Boolean(unlockedVault),
      profiles: profiles.map(publicVaultProfile),
      maxProfiles: 5
    };
  });
  ipcMain.handle("vault-create-profile", (_event, profile) => createVaultProfile(profile));
  ipcMain.handle("vault-unlock-profile", (_event, credentials) => unlockVaultProfile(credentials));
  ipcMain.handle("vault-update-profile", (_event, profile) => updateVaultProfile(profile));
  ipcMain.handle("vault-delete-profile", (_event, credentials) => deleteVaultProfile(credentials));
  ipcMain.handle("vault-confirm-delete-profile", async (_event, profileName) => {
    if (typeof profileName !== "string" || !profileName.trim()) {
      throw new Error("Select a valid profile.");
    }
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Delete profile?",
      message: `Permanently delete ${profileName} and its encrypted accounts?`,
      detail: "This cannot be undone.",
      buttons: ["Cancel", "Delete profile"],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
    return response === 1;
  });
  ipcMain.handle("vault-change-passcode", (_event, values) => changeVaultPasscode(values));
  ipcMain.handle("vault-lock", () => lockVault());
  ipcMain.handle("vault-list", () => listVaultEntries());
  ipcMain.handle("vault-save-entry", (_event, entry) => saveVaultEntry(entry));
  ipcMain.handle("vault-update-entry", (_event, id, entry) => updateVaultEntry(id, entry));
  ipcMain.handle("vault-delete-entry", (_event, id) => deleteVaultEntry(id));
  ipcMain.handle("vault-reveal-password", (_event, id) => getVaultEntryPassword(id));
  ipcMain.handle("vault-copy-username", (_event, id) => {
    const entry = requireUnlockedVault().entries.find(item => item.id === id);
    if (!entry) throw new Error("Vault item not found.");
    clipboard.writeText(entry.username);
    return true;
  });
  ipcMain.handle("open-riot-client", (_event, entryId) => openAndFillRiotClient(entryId));
  ipcMain.handle("vault-export-backup", () => exportVaultBackup());
  ipcMain.handle("vault-restore-backup", (_event, values) => restoreVaultBackup(values));
  ipcMain.handle("vault-copy-password", (_event, id) => {
    const password = getVaultEntryPassword(id);
    clipboard.writeText(password);
    const clearTimer = setTimeout(() => {
      if (clipboard.readText() === password) clipboard.clear();
    }, 30000);
    clearTimer.unref();
    return true;
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) showMainWindow();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  lockVault();
  if (tray) tray.destroy();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
