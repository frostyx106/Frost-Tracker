const recentSearchesKey = "frost-recent-riot-ids";
const vaultAutoLockKey = "frost-vault-auto-lock-minutes";
const appThemeKey = "frost-app-theme";
const appAppearanceStyleKey = "frost-app-appearance-style";
const whatsNewSeenVersionKey = "frost-whats-new-seen-version";
const customThemeKey = "frost-custom-theme-palette";
const customThemeWallpaperLevelKey = "frost-custom-theme-wallpaper-level";
const maxProfileAvatarBytes = 50 * 1024 * 1024;
const appThemes = ["midnight-purple", "midnight-blue", "maroon", "forest", "lilac", "frost", "white", "black", "custom"];
const lightAppThemes = new Set(["lilac", "frost", "white"]);
let currentMatches = [];
let currentAnalyticsMatches = [];
let matchPage = 1;
let matchHistoryWarning = "";
let recentSearchOpen = false;
let vaultEntries = [];
let selectedVaultEntryId = null;
let vaultProfiles = [];
let currentProfile = null;
let selectedProfileId = null;
let vaultGateMode = "picker";
let profilePickerEditing = false;
let newProfileAvatar = null;
let profileAvatarSelection = null;
let vaultAutoLockTimer = null;
let editingVaultEntryId = null;
let customThemePalette = null;
let customThemeImageUrl = null;
let customThemeWallpaperLevel = 100;
let customThemeImageChanged = false;
let activeAppTheme = "midnight-purple";
let availableUpdateVersion = "";
let currentWhatsNewVersion = "";
const $ = (id) => document.getElementById(id);

function updateMaximizeButton(maximized) {
  document.body.dataset.windowMaximized = String(maximized);
  const button = $("window-maximize");
  button.setAttribute("aria-label", maximized ? "Restore" : "Maximize");
  button.title = maximized ? "Restore" : "Maximize";
}

$("window-minimize").addEventListener("click", () => {
  window.frost.controlWindow("minimize").catch(error => console.error("Could not minimize the app window.", error));
});
$("window-maximize").addEventListener("click", async () => {
  try {
    updateMaximizeButton(await window.frost.controlWindow("toggle-maximize"));
  } catch (error) {
    console.error("Could not maximize the app window.", error);
  }
});
$("window-close").addEventListener("click", () => {
  window.frost.controlWindow("close").catch(error => console.error("Could not close the app window.", error));
});
$("window-titlebar").addEventListener("dblclick", event => {
  if (event.target.closest(".window-controls")) return;
  window.frost.controlWindow("toggle-maximize").then(updateMaximizeButton).catch(error => {
    console.error("Could not maximize the app window.", error);
  });
});
window.frost.onWindowMaximizedChange(updateMaximizeButton);

const settingsTabs = [...document.querySelectorAll("[data-settings-tab]")];
function selectSettingsTab(selectedTab, focus = false) {
  for (const tab of settingsTabs) {
    const isSelected = tab === selectedTab;
    tab.classList.toggle("active", isSelected);
    tab.setAttribute("aria-selected", String(isSelected));
    tab.tabIndex = isSelected ? 0 : -1;
    if (isSelected) {
      const panel = document.getElementById(tab.getAttribute("aria-controls"));
      for (const category of document.querySelectorAll("[data-settings-panel]")) {
        category.hidden = category !== panel;
      }
    }
  }
  if (focus) selectedTab.focus();
}

for (const [index, tab] of settingsTabs.entries()) {
  tab.addEventListener("click", () => selectSettingsTab(tab));
  tab.addEventListener("keydown", event => {
    let nextIndex;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (index + 1) % settingsTabs.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = (index - 1 + settingsTabs.length) % settingsTabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = settingsTabs.length - 1;
    else return;
    event.preventDefault();
    selectSettingsTab(settingsTabs[nextIndex], true);
  });
}

window.frost.getStartupSetting().then(setting => {
  const control = $("start-with-windows-setting");
  control.checked = setting.enabled;
  control.disabled = !setting.supported;
  showStatus($("start-with-windows-status"), setting.supported
    ? "When enabled, KEEPER starts in the tray when you sign in."
    : "Starting with Windows is available only on Windows.", !setting.supported);
}).catch(error => {
  $("start-with-windows-setting").disabled = true;
  showStatus($("start-with-windows-status"), error.message || "Could not read the Windows startup setting.", true);
});

$("start-with-windows-setting").addEventListener("change", async event => {
  const control = event.currentTarget;
  const requestedValue = control.checked;
  control.disabled = true;
  try {
    control.checked = await window.frost.setStartupSetting(requestedValue);
    showStatus($("start-with-windows-status"), control.checked
      ? "KEEPER will start minimized to the tray when you sign in to Windows."
      : "KEEPER will not start automatically with Windows.");
  } catch (error) {
    control.checked = !requestedValue;
    showStatus($("start-with-windows-status"), error.message || "Could not update the Windows startup setting.", true);
  } finally {
    control.disabled = false;
  }
});

function formatUpdateMegabytes(bytes) {
  return `${(Math.max(0, bytes) / (1024 * 1024)).toFixed(1)} MB`;
}

function restoreUpdateDescription() {
  const description = $("update-available-description");
  const version = document.createElement("b");
  version.textContent = availableUpdateVersion;
  description.replaceChildren(
    document.createTextNode("A new version "),
    version,
    document.createTextNode(" is ready. Update now or come back to it later.")
  );
}

function showUpdateProgress(progress) {
  const total = Number.isFinite(progress.total) ? Math.max(0, progress.total) : 0;
  const transferred = Number.isFinite(progress.transferred) ? Math.max(0, progress.transferred) : 0;
  const percent = Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0;
  $("update-progress-fill").style.width = `${percent}%`;
  $("update-progress-track").setAttribute("aria-valuenow", String(Math.round(percent)));
  $("update-progress-downloaded").textContent = `${formatUpdateMegabytes(transferred)} downloaded`;
  $("update-progress-total").textContent = `of ${formatUpdateMegabytes(total)}`;
}

window.frost.onUpdateAvailable(update => {
  if ($("update-progress-dialog").open) return;
  availableUpdateVersion = `v${update.version}`;
  restoreUpdateDescription();
  if (!$("update-available-dialog").open) $("update-available-dialog").showModal();
});

window.frost.onUpdateDownloadProgress(showUpdateProgress);

window.frost.onUpdateDownloaded(update => {
  $("update-progress-fill").style.width = "100%";
  $("update-progress-track").setAttribute("aria-valuenow", "100");
  $("update-progress-title").textContent = `KEEPER v${update.version} is ready`;
  $("update-progress-message").textContent = "Restarting to finish the update...";
  $("update-progress-close").hidden = true;
});

window.frost.onUpdateError(error => {
  $("update-progress-title").textContent = "Update download failed";
  $("update-progress-message").textContent = error.message || "The update could not be downloaded. Please try again later.";
  $("update-progress-close").hidden = false;
  if (!$("update-progress-dialog").open) $("update-progress-dialog").showModal();
});

$("update-later-button").addEventListener("click", async () => {
  $("update-available-dialog").close();
  try {
    await window.frost.remindAboutUpdateLater();
  } catch (error) {
    console.error("Could not schedule the update reminder.", error);
    $("update-available-description").textContent = error.message || "Could not schedule a reminder. Please try again.";
    $("update-available-dialog").showModal();
  }
});

$("update-available-dialog").addEventListener("cancel", event => {
  event.preventDefault();
  $("update-later-button").click();
});

$("update-now-button").addEventListener("click", async () => {
  $("update-now-button").disabled = true;
  $("update-available-dialog").close();
  $("update-progress-title").textContent = "Downloading update";
  $("update-progress-message").textContent = "Preparing your update...";
  $("update-progress-fill").style.width = "0%";
  $("update-progress-track").setAttribute("aria-valuenow", "0");
  $("update-progress-downloaded").textContent = "0 MB downloaded";
  $("update-progress-total").textContent = "of -- MB";
  $("update-progress-close").hidden = true;
  $("update-progress-dialog").showModal();
  try {
    await window.frost.downloadUpdate();
  } catch (error) {
    $("update-progress-title").textContent = "Update download failed";
    $("update-progress-message").textContent = error.message || "The update could not be downloaded. Please try again later.";
    $("update-progress-close").hidden = false;
  } finally {
    $("update-now-button").disabled = false;
  }
});

$("update-progress-close").addEventListener("click", () => {
  $("update-progress-dialog").close();
  $("update-progress-title").textContent = "Downloading update";
  $("update-progress-message").textContent = "Preparing your update...";
  restoreUpdateDescription();
  $("update-available-dialog").showModal();
});

$("update-progress-dialog").addEventListener("cancel", event => {
  event.preventDefault();
});

function renderWhatsNewList(notesText) {
  const list = $("whats-new-list");
  if (!list) return;
  list.replaceChildren();
  const sourceNotes = typeof notesText === "string" ? notesText.trim() : "";
  const items = sourceNotes
    ? sourceNotes
        .replace(/\r/g, "")
        .split(/\n{2,}/)
        .map(block => block.replace(/^#+\s*/gm, "").replace(/^[-*•]\s*/gm, "").trim())
        .filter(Boolean)
    : [];
  const finalItems = items.length
    ? items
    : ["No release notes available for this update."];
  finalItems.slice(0, 6).forEach((itemText, index) => {
    const item = document.createElement("li");
    const number = document.createElement("span");
    const label = document.createElement("span");
    number.className = "whats-new-number";
    number.textContent = String(index + 1).padStart(2, "0");
    label.textContent = itemText;
    item.append(number, label);
    list.append(item);
  });
}

function renderWhatsNewDialog(version, releaseNotes) {
  const dialogBrand = $("whats-new-dialog").querySelector(".update-dialog-brand span");
  if (dialogBrand) dialogBrand.textContent = `KEEPER · v${version}`;
  renderWhatsNewList(releaseNotes || "No release notes available for this update.");
}

async function showPendingReleaseNotesIfNeeded() {
  try {
    const version = await window.frost.getVersion();
    const pendingVersion = await window.frost.getPendingWhatsNewVersion();
    if (!pendingVersion || pendingVersion !== version) {
      if (pendingVersion && pendingVersion !== version) {
        await window.frost.clearPendingWhatsNewVersion();
      }
      return;
    }
    currentWhatsNewVersion = version;
    const releaseNotes = await window.frost.fetchReleaseNotesForVersion(version);
    renderWhatsNewDialog(version, releaseNotes?.releaseNotes || "No release notes available for this update.");
    $("whats-new-dialog").showModal();
    await window.frost.markWhatsNewShown(version);
  } catch (error) {
    console.error("Could not show the version-specific release notes.", error);
  }
}

$("whats-new-close").addEventListener("click", () => {
  $("whats-new-dialog").close();
});

$("whats-new-dialog").addEventListener("close", async () => {
  if (!currentWhatsNewVersion) return;
  try {
    await window.frost.markWhatsNewShown(currentWhatsNewVersion);
  } catch (error) {
    console.error("Could not save the release notes dismissal.", error);
  }
});

window.frost.updatesReady().catch(error => {
  console.error("Could not initialize update notifications.", error);
});

async function saveCustomThemeImage(blob) {
  const dataUrl = await readImageAsDataUrl(blob);
  await window.frost.saveCustomThemeImage(dataUrl);
}

function loadLegacyCustomThemeImage() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("frost-custom-theme-assets", 1);
    request.onerror = () => reject(request.error || new Error("Could not open legacy custom theme storage."));
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("assets")) {
        db.close();
        resolve(null);
        return;
      }
      const transaction = db.transaction("assets", "readonly");
      const imageRequest = transaction.objectStore("assets").get("wallpaper");
      imageRequest.onsuccess = () => resolve(imageRequest.result || null);
      transaction.oncomplete = () => db.close();
      transaction.onerror = () => reject(transaction.error || new Error("Could not read the legacy custom theme image."));
      transaction.onabort = () => reject(transaction.error || new Error("Reading the legacy custom theme image was canceled."));
    };
  });
}

function imageBlobFromDataUrl(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw new Error("The saved custom theme image has an invalid format.");
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: match[1] });
}

async function loadCustomThemeImage() {
  const savedDataUrl = await window.frost.loadCustomThemeImage();
  if (savedDataUrl) return imageBlobFromDataUrl(savedDataUrl);

  try {
    const legacyImage = await loadLegacyCustomThemeImage();
    if (!legacyImage) return null;
    await saveCustomThemeImage(legacyImage);
    return legacyImage;
  } catch (error) {
    console.warn("Could not migrate the saved custom theme image from browser storage.", error);
    showStatus($("custom-theme-status"), "The previous custom wallpaper could not be restored. Choose the image again; new wallpapers will save normally.", true);
    return null;
  }
}

async function removeCustomThemeImage() {
  await window.frost.removeCustomThemeImage();
  try {
    const request = indexedDB.open("frost-custom-theme-assets", 1);
    await new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error || new Error("Could not open legacy custom theme storage."));
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("assets")) {
          db.close();
          resolve();
          return;
        }
        const transaction = db.transaction("assets", "readwrite");
        transaction.objectStore("assets").delete("wallpaper");
        transaction.oncomplete = () => {
          db.close();
          resolve();
        };
        transaction.onerror = () => {
          db.close();
          reject(transaction.error || new Error("Could not remove the legacy custom theme image."));
        };
        transaction.onabort = () => {
          db.close();
          reject(transaction.error || new Error("Removing the legacy custom theme image was canceled."));
        };
      };
    });
  } catch (error) {
    console.warn("Could not remove the legacy custom theme image.", error);
  }
}

function readCustomThemePalette() {
  try {
    const palette = JSON.parse(localStorage.getItem(customThemeKey) || "null");
    if (palette && /^#[0-9a-f]{6}$/i.test(palette.accent) &&
        (palette.mode === "light" || palette.mode === "dark") &&
        typeof palette.name === "string") return palette;
  } catch (error) {
    console.error("Could not load the saved custom theme.", error);
  }
  return null;
}

function applyCustomThemeWallpaper() {
  const body = document.body;
  if (customThemeImageUrl) {
    body.style.setProperty("--custom-wallpaper-image", `url("${customThemeImageUrl}")`);
  } else {
    body.style.removeProperty("--custom-wallpaper-image");
  }
  body.style.setProperty("--custom-wallpaper-opacity", String(customThemeWallpaperLevel / 100));
  updateThemeTextDarkness();
  $("custom-theme-wallpaper-controls").hidden = !customThemeImageUrl || activeAppTheme !== "custom";
  $("custom-theme-wallpaper-opacity").value = customThemeWallpaperLevel;
  $("custom-theme-wallpaper-opacity-value").value = `${customThemeWallpaperLevel}%`;
  $("custom-theme-wallpaper-opacity-value").textContent = `${customThemeWallpaperLevel}%`;
}

function updateThemeTextDarkness() {
  const isLight = document.body.dataset.themeMode === "light";
  const darkness = isLight
    ? activeAppTheme === "custom"
      ? customThemeWallpaperLevel * .24
      : 12
    : 0;
  document.body.style.setProperty("--theme-text-darkness", `${darkness}%`);
}

function applyAppTheme(theme) {
  const selectedTheme = appThemes.includes(theme) && (theme !== "custom" || customThemePalette)
    ? theme
    : "midnight-purple";
  activeAppTheme = selectedTheme;
  document.body.dataset.theme = selectedTheme;
  document.body.dataset.themeMode = selectedTheme === "custom" || lightAppThemes.has(selectedTheme)
    ? "light"
    : "dark";
  if (selectedTheme === "custom") {
    document.body.dataset.themeMode = customThemePalette.mode;
    document.body.style.setProperty("--custom-accent", customThemePalette.accent);
  } else {
    document.body.style.removeProperty("--custom-accent");
  }
  $("app-theme-setting").value = selectedTheme;
  $("custom-theme-controls").hidden = selectedTheme !== "custom";
  $("clear-custom-theme").hidden = !customThemePalette;
  if (customThemePalette) $("custom-theme-name").textContent = customThemePalette.name;
  applyCustomThemeWallpaper();
}

function applyAppAppearanceStyle(style) {
  const selectedStyle = style === "glossy" ? "glossy" : "normal";
  document.body.dataset.appearance = selectedStyle;
  for (const button of document.querySelectorAll("[data-appearance-style]")) {
    button.setAttribute("aria-pressed", String(button.dataset.appearanceStyle === selectedStyle));
  }
}

try {
  customThemePalette = readCustomThemePalette();
  const savedWallpaperLevel = localStorage.getItem(customThemeWallpaperLevelKey);
  if (savedWallpaperLevel !== null) {
    const parsedWallpaperLevel = Number(savedWallpaperLevel);
    if (Number.isInteger(parsedWallpaperLevel) && parsedWallpaperLevel >= 0 && parsedWallpaperLevel <= 100) {
      customThemeWallpaperLevel = parsedWallpaperLevel;
    }
  }
  applyAppTheme(localStorage.getItem(appThemeKey));
  applyAppAppearanceStyle(localStorage.getItem(appAppearanceStyleKey));
} catch (error) {
  applyAppTheme("midnight-purple");
  applyAppAppearanceStyle("normal");
  console.error("Could not load the saved app theme.", error);
}

for (const button of document.querySelectorAll("[data-appearance-style]")) {
  button.addEventListener("click", () => {
    const style = button.dataset.appearanceStyle;
    try {
      localStorage.setItem(appAppearanceStyleKey, style);
      applyAppAppearanceStyle(style);
      showStatus($("appearance-style-status"), `${style === "glossy" ? "Glossy" : "Normal"} appearance applied across KEEPER.`);
    } catch (error) {
      showStatus($("appearance-style-status"), "Appearance changed, but the preference could not be saved.", true);
      console.error("Could not save the app appearance style.", error);
    }
  });
}

loadCustomThemeImage().then(image => {
  if (!image || customThemeImageChanged) return;
  customThemeImageUrl = URL.createObjectURL(image);
  applyCustomThemeWallpaper();
}).catch(error => {
  showStatus($("custom-theme-status"), "The saved wallpaper could not be loaded.", true);
  console.error("Could not load the saved custom theme wallpaper.", error);
});

function updateCustomThemeWallpaperOpacity(event) {
  const level = Number(event.currentTarget.value);
  if (!Number.isInteger(level) || level < 0 || level > 100) return;
  customThemeWallpaperLevel = level;
  $("custom-theme-wallpaper-opacity-value").value = `${level}%`;
  $("custom-theme-wallpaper-opacity-value").textContent = `${level}%`;
  document.body.style.setProperty("--custom-wallpaper-opacity", String(level / 100));
  updateThemeTextDarkness();
}

$("custom-theme-wallpaper-opacity").addEventListener("input", updateCustomThemeWallpaperOpacity);
$("custom-theme-wallpaper-opacity").addEventListener("change", event => {
  updateCustomThemeWallpaperOpacity(event);
  try {
    localStorage.setItem(customThemeWallpaperLevelKey, String(customThemeWallpaperLevel));
  } catch (error) {
    showStatus($("custom-theme-status"), "Wallpaper updated, but its opacity could not be saved.", true);
    console.error("Could not save the custom theme wallpaper opacity.", error);
  }
});

function saveAppTheme(theme) {
  try {
    localStorage.setItem(appThemeKey, theme);
    showStatus($("security-settings-status"), "Theme preference saved.");
  } catch (error) {
    showStatus($("security-settings-status"), "Theme changed, but the preference could not be saved.", true);
    console.error("Could not save the selected app theme.", error);
  }
}

$("app-theme-setting").addEventListener("change", event => {
  const selectedTheme = event.currentTarget.value;
  if (!appThemes.includes(selectedTheme)) {
    applyAppTheme("midnight-purple");
    return;
  }
  if (selectedTheme === "custom" && !customThemePalette) {
    $("custom-theme-controls").hidden = false;
    $("custom-theme-image").click();
    return;
  }
  applyAppTheme(selectedTheme);
  saveAppTheme(selectedTheme);
});

function hslToHex(hue, saturation, lightness) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const section = hue / 60;
  const secondary = chroma * (1 - Math.abs(section % 2 - 1));
  const [red, green, blue] = section < 1 ? [chroma, secondary, 0]
    : section < 2 ? [secondary, chroma, 0]
      : section < 3 ? [0, chroma, secondary]
        : section < 4 ? [0, secondary, chroma]
          : section < 5 ? [secondary, 0, chroma] : [chroma, 0, secondary];
  const offset = lightness - chroma / 2;
  return `#${[red, green, blue].map(value =>
    Math.round((value + offset) * 255).toString(16).padStart(2, "0")
  ).join("")}`;
}

function readImageAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("The selected theme image could not be read."));
    reader.readAsDataURL(blob);
  });
}

async function createCustomThemePalette(file) {
  if (!file || file.size > 12 * 1024 * 1024) {
    throw new Error("Choose an image smaller than 12 MB.");
  }
  const extension = file.name.split(".").pop().toLowerCase();
  const acceptedExtensions = new Set(["png", "jpg", "jpeg", "webp", "svg", "heic"]);
  if (!acceptedExtensions.has(extension)) {
    throw new Error("Choose a PNG, JPEG, WebP, SVG, or HEIC image.");
  }

  let imageBlob = file;
  if (extension === "heic") {
    if (typeof window.heic2any !== "function") {
      throw new Error("The bundled HEIC image decoder is unavailable.");
    }
    try {
      imageBlob = await window.heic2any({ blob: file, toType: "image/png", quality: .9, multiple: false });
    } catch (error) {
      console.error("Could not decode the selected HEIC theme image.", error);
      throw new Error("This HEIC image could not be decoded. Convert it to PNG or JPEG and try again.");
    }
    if (Array.isArray(imageBlob)) [imageBlob] = imageBlob;
    if (!(imageBlob instanceof Blob)) throw new Error("The HEIC image could not be decoded.");
  }

  const image = new Image();
  image.src = await readImageAsDataUrl(imageBlob);
  try {
    await image.decode();
  } catch (error) {
    console.error("Could not decode the selected theme image.", error);
    throw new Error("This image could not be decoded. Choose a valid PNG, JPEG, WebP, SVG, or HEIC image.");
  }
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 12000 || image.naturalHeight > 12000) {
    throw new Error("Choose a valid theme image with dimensions under 12,000 pixels.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not analyze the selected theme image.");
  let pixels;
  try {
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch (error) {
    console.error("Could not analyze the selected theme image.", error);
    throw new Error("This image cannot be analyzed. Save it as PNG or JPEG and try again.");
  }
  let brightnessTotal = 0;
  let visiblePixels = 0;
  const hues = Array.from({ length: 24 }, () => ({ score: 0, saturation: 0, count: 0 }));

  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3] / 255;
    if (alpha < .25) continue;
    const red = pixels[index] / 255;
    const green = pixels[index + 1] / 255;
    const blue = pixels[index + 2] / 255;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const delta = max - min;
    brightnessTotal += (red * .2126 + green * .7152 + blue * .0722) * alpha;
    visiblePixels += alpha;
    const saturation = max === 0 ? 0 : delta / max;
    if (saturation < .18 || delta === 0) continue;
    let hue = max === red ? 60 * (((green - blue) / delta) % 6)
      : max === green ? 60 * ((blue - red) / delta + 2)
        : 60 * ((red - green) / delta + 4);
    if (hue < 0) hue += 360;
    const bin = hues[Math.floor(hue / 15) % hues.length];
    bin.score += saturation * alpha;
    bin.saturation += saturation * alpha;
    bin.count++;
  }

  if (!visiblePixels) throw new Error("The selected image is empty or transparent.");
  const dominantHueIndex = hues.reduce((best, bin, index, bins) =>
    bin.score > bins[best].score ? index : best, 0);
  const dominantHue = dominantHueIndex * 15 + 7.5;
  const dominantSaturation = hues[dominantHueIndex].count
    ? hues[dominantHueIndex].saturation / hues[dominantHueIndex].count
    : 0;
  const isLight = brightnessTotal / visiblePixels >= .52;
  const accent = dominantSaturation < .18
    ? (isLight ? "#596575" : "#c0c6d0")
    : hslToHex(dominantHue, Math.min(.86, Math.max(.48, dominantSaturation)), isLight ? .38 : .68);

  return {
    palette: { accent, mode: isLight ? "light" : "dark", name: file.name.slice(0, 100) },
    imageBlob
  };
}

$("custom-theme-image").addEventListener("change", async event => {
  const file = event.currentTarget.files?.[0];
  if (!file) return;
  const input = event.currentTarget;
  const previousPalette = customThemePalette;
  const select = $("app-theme-setting");
  select.disabled = true;
  showStatus($("custom-theme-status"), "Analyzing theme image...");
  try {
    const { palette, imageBlob } = await createCustomThemePalette(file);
    customThemePalette = palette;
    localStorage.setItem(customThemeKey, JSON.stringify(palette));
    try {
      await saveCustomThemeImage(imageBlob);
    } catch (error) {
      if (previousPalette) localStorage.setItem(customThemeKey, JSON.stringify(previousPalette));
      else localStorage.removeItem(customThemeKey);
      customThemePalette = previousPalette;
      throw error;
    }
    if (customThemeImageUrl) URL.revokeObjectURL(customThemeImageUrl);
    customThemeImageUrl = URL.createObjectURL(imageBlob);
    customThemeImageChanged = true;
    applyAppTheme("custom");
    saveAppTheme("custom");
    showStatus($("custom-theme-status"), `Custom ${palette.mode} theme sampled from ${palette.name}.`);
  } catch (error) {
    customThemePalette = previousPalette;
    applyAppTheme(activeAppTheme);
    showStatus($("custom-theme-status"), error.message || "Could not create a theme from that image.", true);
    console.error("Could not create a custom theme.", error);
  } finally {
    input.value = "";
    select.disabled = false;
  }
});

$("custom-theme-image").addEventListener("cancel", () => {
  $("app-theme-setting").value = activeAppTheme;
  $("custom-theme-controls").hidden = activeAppTheme !== "custom";
});

$("clear-custom-theme").addEventListener("click", async () => {
  try {
    const previousPalette = customThemePalette;
    localStorage.removeItem(customThemeKey);
    try {
      await removeCustomThemeImage();
    } catch (error) {
      if (previousPalette) localStorage.setItem(customThemeKey, JSON.stringify(previousPalette));
      throw error;
    }
  } catch (error) {
    showStatus($("custom-theme-status"), "Could not clear the saved custom theme.", true);
    console.error("Could not clear the custom theme.", error);
    return;
  }
  if (customThemeImageUrl) URL.revokeObjectURL(customThemeImageUrl);
  customThemeImageUrl = null;
  customThemeImageChanged = true;
  customThemePalette = null;
  applyAppTheme("midnight-purple");
  saveAppTheme("midnight-purple");
  showStatus($("custom-theme-status"), "Custom theme cleared.");
});

function summarizeMatches(matches) {
  const total = field => matches.reduce((sum, match) =>
    sum + (Number.isFinite(match[field]) ? match[field] : 0), 0);
  const wins = matches.filter(match => match.result === "W").length;
  const losses = matches.filter(match => match.result === "L").length;
  const draws = matches.filter(match => match.result === "D").length;
  const kills = total("kills");
  const deaths = total("deaths");
  const assists = total("assists");
  const rounds = total("roundsPlayed");
  const matchesWithAcs = matches.filter(match => Number.isFinite(match.acs));
  const headshots = total("headshots");
  const shots = headshots + total("bodyshots") + total("legshots");
  const dda = kills + assists - deaths;

  return {
    wins,
    losses,
    draws,
    kills,
    deaths,
    assists,
    winRate: wins + losses + draws ? (wins / (wins + losses + draws)) * 100 : null,
    kd: deaths ? kills / deaths : kills ? Infinity : null,
    kad: deaths ? (kills + assists) / deaths : kills + assists ? Infinity : null,
    acs: matchesWithAcs.length
      ? matchesWithAcs.reduce((sum, match) => sum + match.acs, 0) / matchesWithAcs.length
      : null,
    headshotRate: shots ? (headshots / shots) * 100 : null,
    ddaPerRound: rounds ? dda / rounds : null
  };
}

function refreshAnalyticsScopeOptions() {
  const select = $("analytics-scope");
  const previous = select.value;
  const scopes = [10, 20, 30].map(count => ({
    value: `${count}matches`,
    label: `Last ${count} matches`,
    matches: currentAnalyticsMatches.slice(0, count)
  }));
  select.replaceChildren();
  for (const scope of scopes) {
    const option = document.createElement("option");
    option.value = scope.value;
    option.dataset.label = scope.label;
    option.textContent = `${scope.label} (${scope.matches.length})`;
    select.append(option);
  }
  select.value = scopes.some(scope => scope.value === previous)
    ? previous
    : "10matches";
}

function getMatchesForAnalyticsScope(scope) {
  const matchCount = Number.parseInt(scope, 10);
  return [10, 20, 30].includes(matchCount)
    ? currentAnalyticsMatches.slice(0, matchCount)
    : currentAnalyticsMatches.slice(0, 10);
}

function getAnalyticsMatches() {
  return getMatchesForAnalyticsScope($("analytics-scope").value);
}

function getAnalyticsScopeLabel() {
  const select = $("analytics-scope");
  return select.selectedOptions[0]?.dataset.label || "Last 10 matches";
}

function getIdenticalScopeLabels(matches) {
  const matchIds = new Set(matches.map(match => match.id));
  if (!matchIds.size) return [];
  return [...$("analytics-scope").options]
    .filter(option => option.value !== $("analytics-scope").value)
    .filter(option => {
      const otherMatches = getMatchesForAnalyticsScope(option.value);
      return otherMatches.length === matchIds.size &&
        otherMatches.every(match => matchIds.has(match.id));
    })
    .map(option => option.dataset.label);
}

function renderScopedAnalytics() {
  const scopedMatches = getAnalyticsMatches();
  const emptyMessage = `No matches are available for ${getAnalyticsScopeLabel().toLowerCase()}.`;
  renderPlayerInsights(scopedMatches, emptyMessage);
  renderPerformance(scopedMatches, emptyMessage);
}

function formatRatio(value) {
  return Number.isFinite(value) ? value.toFixed(2) : value === Infinity ? "∞" : "—";
}

function renderBreakdownTable(table, emptyElement, groups, emptyText) {
  table.replaceChildren();
  emptyElement.textContent = emptyText;
  emptyElement.hidden = groups.length > 0;
  for (const [name, matches] of groups) {
    const stats = summarizeMatches(matches);
    const row = document.createElement("tr");
    for (const value of [
      name,
      String(matches.length),
      stats.winRate === null ? "—" : `${Math.round(stats.winRate)}%`,
      formatRatio(stats.kd),
      stats.acs === null ? "—" : String(Math.round(stats.acs))
    ]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    table.append(row);
  }
}

function setPlayerArtwork(image, placeholder, url, alt = "") {
  image.onerror = () => {
    image.hidden = true;
    placeholder.hidden = false;
  };
  if (!url) {
    image.removeAttribute("src");
    image.hidden = true;
    placeholder.hidden = false;
    return;
  }
  image.src = url;
  image.alt = alt;
  image.hidden = false;
  placeholder.hidden = true;
}

function renderPlayerHero(data) {
  const { account, current, peak } = data;
  const name = account.name || "Unknown player";
  const tag = account.tag || "";
  const region = account.region ? account.region.toUpperCase() : "";
  const platform = account.platform ? account.platform.toUpperCase() : "";
  $("overview-heading").textContent = name;
  $("overview-tag").textContent = tag ? `#${tag}` : "";
  $("overview-subtitle").textContent = [region, platform].filter(Boolean).join(" · ");
  $("player-level").textContent = `LEVEL ${account.level ?? "—"}${region ? ` · ${region}` : ""}`;
  $("player-hero").classList.toggle("has-player-card", Boolean(account.cardArt));
  if (account.cardArt) {
    $("player-hero").style.setProperty("--player-card-art", `url("${account.cardArt}")`);
  } else {
    $("player-hero").style.removeProperty("--player-card-art");
  }
  $("player-card-placeholder").textContent = name.trim().charAt(0).toUpperCase() || "◇";
  setPlayerArtwork($("player-card-avatar"), $("player-card-placeholder"), account.cardAvatar, `${name}'s player card`);
  setPlayerArtwork($("current-rank-icon"), $("current-rank-placeholder"), current.rankIcon, `${current.tier?.name || "Current rank"} icon`);
  const peakIcon = peak?.tier?.icon || "";
  setPlayerArtwork($("peak-rank-icon"), $("peak-rank-placeholder"), peakIcon, `${peak?.tier?.name || "Peak rank"} icon`);
}

function renderPlayerInsights(matches, emptyMessage = "Search a player to calculate recent performance.") {
  const stats = summarizeMatches(matches);
  const values = {
    "snapshot-win-rate": stats.winRate === null ? "—" : `${Math.round(stats.winRate)}%`,
    "snapshot-kd": formatRatio(stats.kd),
    "snapshot-kad": formatRatio(stats.kad),
    "snapshot-acs": stats.acs === null ? "—" : String(Math.round(stats.acs)),
    "snapshot-headshots": stats.headshotRate === null ? "—" : `${Math.round(stats.headshotRate)}%`,
    "snapshot-dda": stats.ddaPerRound === null ? "—" : stats.ddaPerRound.toFixed(2),
    "snapshot-kills": matches.length ? stats.kills.toLocaleString() : "—",
    "snapshot-deaths": matches.length ? stats.deaths.toLocaleString() : "—",
    "snapshot-assists": matches.length ? stats.assists.toLocaleString() : "—",
    "snapshot-wins-total": matches.length ? stats.wins.toLocaleString() : "—",
    "snapshot-record": matches.length ? `${stats.wins}W – ${stats.losses}L` : "—"
  };
  for (const [id, value] of Object.entries(values)) $(id).textContent = value;
  const setRecordValue = (element, count, label) => {
    const caption = document.createElement("span");
    caption.textContent = label;
    element.replaceChildren(document.createTextNode(`${count} `), caption);
  };
  setRecordValue($("snapshot-wins"), stats.wins, "WON");
  setRecordValue($("snapshot-losses"), stats.losses, "LOST");
  $("snapshot-draws").textContent = stats.draws ? `${stats.draws} drawn` : "No draws";
  const resolvedResults = stats.wins + stats.losses + stats.draws;
  const lossRate = resolvedResults ? (stats.losses / resolvedResults) * 100 : 0;
  $("winrate-ring").style.setProperty("--win-rate", `${stats.winRate ?? 0}%`);
  $("winrate-ring").style.setProperty("--loss-rate", `${lossRate}%`);
  $("winrate-ring").setAttribute("aria-label", stats.winRate === null
    ? "Win rate unavailable"
    : `${Math.round(stats.winRate)}% win rate, ${stats.wins} wins and ${stats.losses} losses`);
  const identicalScopes = getIdenticalScopeLabels(matches);
  $("overview-snapshot-caption").textContent = matches.length
    ? `${getAnalyticsScopeLabel()} · ${matches.length} ${matches.length === 1 ? "match" : "matches"} from ${currentAnalyticsMatches.length} loaded.` +
      (identicalScopes.length
        ? ` Same match sample as ${identicalScopes.join(" and ")}.`
        : "") +
      (matchHistoryWarning ? ` ${matchHistoryWarning}` : "")
    : emptyMessage;

  const agentMatches = new Map();
  const roleMatches = new Map();
  for (const match of matches) {
    if (match.agent && match.agent !== "Unknown agent") {
      const group = agentMatches.get(match.agent) || [];
      group.push(match);
      agentMatches.set(match.agent, group);
    }
    if (match.role) {
      const group = roleMatches.get(match.role) || [];
      group.push(match);
      roleMatches.set(match.role, group);
    }
  }
  const sortGroups = groups => [...groups.entries()].sort((left, right) =>
    right[1].length - left[1].length || left[0].localeCompare(right[0])
  );
  const showcase = $("agent-showcase");
  showcase.replaceChildren();
  const agents = sortGroups(agentMatches).slice(0, 4);
  $("agent-stats-empty").hidden = agents.length > 0;
  $("agent-stats-empty").textContent = matches.length
    ? "No agent details are available for these matches."
    : emptyMessage;
  for (const [name, agentGames] of agents) {
    const agentStats = summarizeMatches(agentGames);
    const item = document.createElement("div");
    item.className = "agent-showcase-item";
    const icon = document.createElement("div");
    icon.className = "agent-showcase-icon";
    const imageUrl = agentGames.find(match => match.agentIcon)?.agentIcon || "";
    if (imageUrl) {
      const image = document.createElement("img");
      image.src = imageUrl;
      image.alt = "";
      image.addEventListener("error", () => {
        image.hidden = true;
        icon.textContent = name.charAt(0).toUpperCase();
      }, { once: true });
      icon.append(image);
    } else {
      icon.textContent = name.charAt(0).toUpperCase();
    }
    const details = document.createElement("div");
    details.className = "agent-showcase-details";
    const agentName = document.createElement("b");
    agentName.textContent = name;
    const agentRecord = document.createElement("span");
    const winRate = agentStats.winRate === null ? "—" : `${Math.round(agentStats.winRate)}%`;
    agentRecord.textContent = `${agentGames.length} ${agentGames.length === 1 ? "match" : "matches"} · ${winRate} win`;
    details.append(agentName, agentRecord);
    item.append(icon, details);
    showcase.append(item);
  }
  renderBreakdownTable(
    $("role-stats-table"),
    $("role-stats-empty"),
    sortGroups(roleMatches),
    matches.length ? "Role details were not returned for these matches." : emptyMessage
  );

  const accuracy = $("accuracy-breakdown");
  accuracy.replaceChildren();
  const hitCounts = [
    ["Head", matches.reduce((sum, match) => sum + (match.headshots || 0), 0)],
    ["Body", matches.reduce((sum, match) => sum + (match.bodyshots || 0), 0)],
    ["Legs", matches.reduce((sum, match) => sum + (match.legshots || 0), 0)]
  ];
  const totalHits = hitCounts.reduce((sum, [, count]) => sum + count, 0);
  $("accuracy-empty").hidden = totalHits > 0;
  $("accuracy-empty").textContent = matches.length
    ? "Hit location data was not returned for these matches."
    : emptyMessage;
  for (const [label, count] of hitCounts) {
    const percentage = totalHits ? (count / totalHits) * 100 : 0;
    const row = document.createElement("div");
    row.className = "accuracy-row";
    const heading = document.createElement("div");
    heading.className = "accuracy-row-heading";
    const name = document.createElement("span");
    name.textContent = label;
    const value = document.createElement("b");
    value.textContent = totalHits ? `${Math.round(percentage)}% · ${count.toLocaleString()} hits` : "—";
    heading.append(name, value);
    const track = document.createElement("div");
    track.className = "accuracy-track";
    const bar = document.createElement("i");
    bar.style.width = `${percentage}%`;
    track.append(bar);
    row.append(heading, track);
    accuracy.append(row);
  }
}

function renderRecent() {
  const list = $("recent-matches");
  list.replaceChildren();
  for (const match of currentMatches.slice(0, 4)) {
    const row = document.createElement("div");
    row.className = "match-row";
    const result = document.createElement("div");
    result.className = `result-mark ${match.result === "W" ? "win" : match.result === "L" ? "loss" : ""}`;
    result.textContent = match.result;
    const details = document.createElement("div");
    details.className = "match-map";
    if (match.agentIcon) {
      const agentIcon = document.createElement("img");
      agentIcon.className = "match-agent-icon";
      agentIcon.src = match.agentIcon;
      agentIcon.alt = "";
      agentIcon.addEventListener("error", () => agentIcon.remove(), { once: true });
      details.append(agentIcon);
    }
    const map = document.createElement("b");
    map.textContent = match.map;
    const stats = document.createElement("small");
    stats.textContent = `${match.agent} · ${match.queue} · ${match.kda}`;
    details.append(map, stats);
    const score = document.createElement("div");
    score.className = "match-score";
    score.textContent = match.score;
    row.append(result, details, score);
    list.append(row);
  }
  if (!currentMatches.length) {
    const empty = document.createElement("p");
    empty.className = "match-empty";
    empty.textContent = "Search a player to load recent matches.";
    list.append(empty);
  }
}

function refreshMatchFilterOptions() {
  const filters = [
    [$("match-map-filter"), "All maps", "map"],
    [$("match-agent-filter"), "All agents", "agent"],
    [$("match-mode-filter"), "All modes", "queue"]
  ];
  for (const [select, label, field] of filters) {
    const selected = select.value;
    const values = [...new Set(currentMatches.map(match => match[field]).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right));
    select.replaceChildren();
    const allOption = document.createElement("option");
    allOption.value = "all";
    allOption.textContent = label;
    select.append(allOption);
    for (const value of values) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.append(option);
    }
    select.value = values.includes(selected) ? selected : "all";
  }
}

function resetMatchFilters() {
  matchPage = 1;
  $("match-filter").value = "all";
  $("match-map-filter").value = "all";
  $("match-agent-filter").value = "all";
  $("match-mode-filter").value = "all";
  $("match-date-filter").value = "all";
  $("match-kills-filter").value = "0";
  $("match-page-size").value = "10";
}

function renderMatches() {
  const table = $("match-table");
  table.replaceChildren();
  const resultFilter = $("match-filter").value;
  const mapFilter = $("match-map-filter").value;
  const agentFilter = $("match-agent-filter").value;
  const modeFilter = $("match-mode-filter").value;
  const dateFilter = $("match-date-filter").value;
  const minKills = Number($("match-kills-filter").value);
  const latestMatches = new Set(currentMatches.slice(0, 5).map(match => match.id));
  const now = Date.now();
  const filteredMatches = currentMatches.filter(match => {
    if (resultFilter !== "all" && match.result !== ({ win: "W", loss: "L", draw: "D" }[resultFilter])) return false;
    if (mapFilter !== "all" && match.map !== mapFilter) return false;
    if (agentFilter !== "all" && match.agent !== agentFilter) return false;
    if (modeFilter !== "all" && match.queue !== modeFilter) return false;
    if (Number.isFinite(minKills) && (match.kills || 0) < minKills) return false;
    if (dateFilter === "5" && !latestMatches.has(match.id)) return false;
    if (dateFilter === "7d" || dateFilter === "30d") {
      const startedAt = Date.parse(match.startedAt || "");
      const age = now - startedAt;
      const maxAge = Number.parseInt(dateFilter, 10) * 24 * 60 * 60 * 1000;
      if (!Number.isFinite(startedAt) || age < 0 || age > maxAge) return false;
    }
    return true;
  });
  const pageSize = Number($("match-page-size").value) || 10;
  const totalPages = Math.max(1, Math.ceil(filteredMatches.length / pageSize));
  matchPage = Math.min(matchPage, totalPages);
  const firstIndex = (matchPage - 1) * pageSize;
  const pageMatches = filteredMatches.slice(firstIndex, firstIndex + pageSize);
  for (const match of pageMatches) {
    const row = document.createElement("tr");
    const result = document.createElement("td");
    result.className = `table-result ${match.result === "W" ? "win" : match.result === "L" ? "loss" : ""}`;
    result.textContent = match.result === "W" ? "VICTORY" : match.result === "L" ? "DEFEAT" : match.result === "D" ? "DRAW" : "—";
    row.append(result);
    for (const value of [match.queue, match.map, match.agent, match.score, match.kda, match.acs ?? "—", match.hs]) {
      const cell = document.createElement("td");
      cell.textContent = String(value);
      row.append(cell);
    }
    table.append(row);
  }
  $("match-page-label").textContent = `Page ${matchPage} of ${totalPages}`;
  $("match-page-prev").disabled = matchPage <= 1;
  $("match-page-next").disabled = matchPage >= totalPages;
  const rangeStart = filteredMatches.length ? firstIndex + 1 : 0;
  const rangeEnd = Math.min(firstIndex + pageSize, filteredMatches.length);
  $("matches-status").textContent = filteredMatches.length
    ? `Showing ${rangeStart}–${rangeEnd} of ${filteredMatches.length} filtered matches (${currentMatches.length} loaded).${matchHistoryWarning ? ` ${matchHistoryWarning}` : ""}`
    : `${currentMatches.length ? "No matches match these filters." : "No match history loaded."}${matchHistoryWarning ? ` ${matchHistoryWarning}` : ""}`;
  return filteredMatches.length;
}

function renderRecentSearches() {
  const list = $("recent-search-list");
  let recentSearches = [];
  try {
    const savedSearches = JSON.parse(localStorage.getItem(recentSearchesKey) || "[]");
    if (Array.isArray(savedSearches)) recentSearches = savedSearches.filter(value => typeof value === "string").slice(0, 8);
  } catch {
    recentSearches = [];
  }
  list.replaceChildren();
  for (const riotId of recentSearches) {
    const item = document.createElement("div");
    item.className = "recent-search-row";
    item.dataset.riotId = riotId;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recent-search-item";
    button.dataset.riotId = riotId;
    button.textContent = riotId;
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "recent-search-remove";
    removeButton.dataset.removeRiotId = riotId;
    removeButton.setAttribute("aria-label", `Remove ${riotId} from recent searches`);
    removeButton.title = "Remove from recent searches";
    removeButton.textContent = "×";
    item.append(button, removeButton);
    list.append(item);
  }
  $("recent-searches").hidden = recentSearches.length === 0 || !recentSearchOpen;
  $("rank-riot-id").setAttribute("aria-expanded", String(!$("recent-searches").hidden));
  updateRecentSearchVisibility();
}

function updateRecentSearchVisibility() {
  const dropdown = $("recent-searches");
  if (dropdown.hidden) return;
  const query = $("rank-riot-id").value.trim().toLowerCase();
  let visibleCount = 0;
  for (const row of $("recent-search-list").children) {
    const matches = row.dataset.riotId.toLowerCase().includes(query);
    row.hidden = !matches;
    if (matches) visibleCount++;
  }
  dropdown.classList.toggle("is-empty", visibleCount === 0);
}

function saveRecentSearch(riotId) {
  let recentSearches = [];
  try {
    const savedSearches = JSON.parse(localStorage.getItem(recentSearchesKey) || "[]");
    if (Array.isArray(savedSearches)) recentSearches = savedSearches.filter(value => typeof value === "string");
  } catch {
    recentSearches = [];
  }
  recentSearches = [riotId, ...recentSearches.filter(value => value.toLowerCase() !== riotId.toLowerCase())].slice(0, 8);
  try {
    localStorage.setItem(recentSearchesKey, JSON.stringify(recentSearches));
  } catch {
    return;
  }
  renderRecentSearches();
}
function renderPerformance(matches, emptyMessage = "Search a player to load performance.") {
  const mapStats = new Map();
  const agentCounts = new Map();
  const matchesWithAcs = matches.filter(match => Number.isFinite(match.acs));
  const matchesWithHeadshotRate = matches.flatMap(match => {
    const rate = typeof match.hs === "string" ? Number.parseFloat(match.hs) : NaN;
    return Number.isFinite(rate) ? [{ ...match, headshotRate: rate }] : [];
  });

  for (const match of matches) {
    if (match.map && match.map !== "Unknown map") {
      const stats = mapStats.get(match.map) || { wins: 0, count: 0 };
      stats.count += 1;
      if (match.result === "W") stats.wins += 1;
      mapStats.set(match.map, stats);
    }
    if (match.agent && match.agent !== "Unknown agent") {
      agentCounts.set(match.agent, (agentCounts.get(match.agent) || 0) + 1);
    }
  }

  const bestMap = [...mapStats.entries()].sort((left, right) =>
    (right[1].wins / right[1].count) - (left[1].wins / left[1].count) ||
    right[1].count - left[1].count
  )[0];
  const topAgent = [...agentCounts.entries()].sort((left, right) => right[1] - left[1])[0];
  const bestAcs = matchesWithAcs.reduce((best, match) => Math.max(best, match.acs), -Infinity);
  const bestHeadshotRate = matchesWithHeadshotRate.reduce((best, match) => Math.max(best, match.headshotRate), -Infinity);

  $("performance-best-map").textContent = bestMap?.[0] || "—";
  $("performance-best-map-foot").textContent = bestMap
    ? `${Math.round((bestMap[1].wins / bestMap[1].count) * 100)}% win rate · ${bestMap[1].count} ${bestMap[1].count === 1 ? "match" : "matches"}`
    : emptyMessage;
  $("performance-top-agent").textContent = topAgent?.[0] || "—";
  $("performance-top-agent-foot").textContent = topAgent
    ? `Played in ${topAgent[1]} of ${matches.length} ${matches.length === 1 ? "match" : "matches"}`
    : emptyMessage;
  $("performance-best-acs").textContent = Number.isFinite(bestAcs) ? String(bestAcs) : "—";
  $("performance-best-acs-foot").textContent = Number.isFinite(bestAcs) ? "Highest ACS in recent matches" : emptyMessage;
  $("performance-best-hs").textContent = Number.isFinite(bestHeadshotRate) ? `${bestHeadshotRate}%` : "—";
  $("performance-best-hs-foot").textContent = Number.isFinite(bestHeadshotRate) ? "Highest headshot rate in recent matches" : emptyMessage;
  $("performance-match-count").textContent = matches.length
    ? `${matches.length} · ${getAnalyticsScopeLabel().toUpperCase()}`
    : "NO MATCH DATA";

  const chart = $("acs-chart");
  chart.replaceChildren();
  const chartMatches = matchesWithAcs.slice(0, 8).reverse();
  if (!chartMatches.length) {
    const empty = document.createElement("p");
    empty.className = "match-empty";
    empty.textContent = emptyMessage;
    chart.append(empty);
    return;
  }
  const maxAcs = Math.max(...chartMatches.map(match => match.acs), 1);
  for (const match of chartMatches) {
    const bar = document.createElement("div");
    bar.className = "chart-bar";
    bar.style.height = `${Math.max(3, (match.acs / maxAcs) * 100)}%`;
    const value = document.createElement("span");
    value.textContent = String(match.acs);
    bar.append(value);
    chart.append(bar);
  }
}
function navigate(page) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  const target = $(page+"-page");
  if (target) target.classList.add("active");
  document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.page===page));
  const names = {overview:"Player Stats",matches:"Match History",compare:"Performance",vault:"Personal Vault",settings:"Settings"};
  $("page-title").textContent = names[page] || "Overview";
}
document.querySelectorAll(".nav-item").forEach(b => b.addEventListener("click", () => navigate(b.dataset.page)));
document.querySelectorAll("[data-goto]").forEach(b => b.addEventListener("click", () => navigate(b.dataset.goto)));
document.querySelectorAll(".match-filters select").forEach(select => select.addEventListener("change", () => {
  matchPage = 1;
  renderMatches();
}));
$("match-page-size").addEventListener("change", () => {
  matchPage = 1;
  renderMatches();
});
$("match-page-prev").addEventListener("click", () => {
  matchPage = Math.max(1, matchPage - 1);
  renderMatches();
});
$("match-page-next").addEventListener("click", () => {
  matchPage += 1;
  renderMatches();
});
$("analytics-scope").addEventListener("change", renderScopedAnalytics);
renderRecentSearches(); renderRecent(); renderMatches(); renderPerformance([]);
if (window.frost?.getVersion) {
  window.frost.getVersion().then(version => {
    const displayVersion = `${version} (Beta)`;
    $("version").textContent = displayVersion;
    $("footer-version").textContent = `v${displayVersion}`;
    showPendingReleaseNotesIfNeeded().catch(error => {
      console.error("Could not check whether the version-specific release notes should be shown.", error);
    });
  }).catch(error => console.error("Could not read the app version.", error));
}

function showStatus(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("error", isError);
}

function renderRank(data) {
  const { account, current, peak } = data;
  const accountName = `${account.name}#${account.tag}`;
  const currentTier = current.tier?.name || "Unranked";
  const peakTier = peak?.tier?.name || "No peak recorded";
  const change = current.last_change;
  const formattedChange = Number.isFinite(change) ? `${change > 0 ? "+" : ""}${change}` : "—";

  renderPlayerHero(data);
  $("overview-current-rank").textContent = currentTier;
  $("overview-peak-rank").textContent = peakTier;
  $("overview-rr").textContent = current.rr ?? "—";
  $("overview-last-change").textContent = Number.isFinite(change) ? `${formattedChange} RR` : "";
  $("overview-peak-season").textContent = peak?.season?.short ? `Season ${peak.season.short}` : "Highest recorded";
  currentMatches = Array.isArray(data.matches) ? data.matches : [];
  currentAnalyticsMatches = Array.isArray(data.analyticsMatches)
    ? data.analyticsMatches
    : currentMatches;
  matchHistoryWarning = data.matchesError || "";
  refreshAnalyticsScopeOptions();
  refreshMatchFilterOptions();
  resetMatchFilters();
  renderRecent();
  renderMatches();
  renderScopedAnalytics();
  const matchCaption = `Recent matches across modes for ${accountName}`;
  $("overview-matches-caption").textContent = matchCaption;
  $("matches-caption").textContent = matchCaption;
  $("data-mode-label").textContent = "LIVE PLAYER DATA";
}

function clearPlayerData(riotId, message, loading = false) {
  const value = loading ? "Loading..." : "Unavailable";
  $("overview-heading").textContent = riotId;
  $("overview-tag").textContent = "";
  $("overview-subtitle").textContent = message;
  $("player-level").textContent = "LEVEL —";
  $("player-hero").classList.remove("has-player-card");
  $("player-hero").style.removeProperty("--player-card-art");
  $("player-card-placeholder").textContent = riotId.trim().charAt(0).toUpperCase() || "◇";
  setPlayerArtwork($("player-card-avatar"), $("player-card-placeholder"), "");
  setPlayerArtwork($("current-rank-icon"), $("current-rank-placeholder"), "");
  setPlayerArtwork($("peak-rank-icon"), $("peak-rank-placeholder"), "");
  currentMatches = [];
  currentAnalyticsMatches = [];
  matchHistoryWarning = "";
  refreshAnalyticsScopeOptions();
  refreshMatchFilterOptions();
  resetMatchFilters();
  renderRecent();
  renderMatches();
  renderPlayerInsights([], loading ? "Loading player performance..." : message);
  renderPerformance([], loading ? "Loading player performance..." : message);
  $("overview-current-rank").textContent = value;
  $("overview-peak-rank").textContent = value;
  $("overview-rr").textContent = value;
  $("overview-peak-season").textContent = value;
  $("overview-last-change").textContent = "";
  $("overview-matches-caption").textContent = `Recent matches across modes for ${riotId}`;
  $("matches-caption").textContent = `Recent matches across modes for ${riotId}`;
  $("matches-status").textContent = loading ? "Loading recent match history..." : message;
  $("data-mode-label").textContent = loading ? "LOADING PLAYER" : "NO LIVE DATA";
}

async function refreshHenrikDevStatus() {
  const status = await window.frost.getHenrikDevStatus();
  const keyStatus = $("api-key-status");
  const lookupStatus = $("rank-lookup-status");
  $("rank-submit").disabled = !status.configured;

  if (!status.secureStorageAvailable) {
    showStatus(keyStatus, "Windows secure storage is unavailable; an API key cannot be saved.", true);
    showStatus(lookupStatus, "Windows secure storage is unavailable; an API key cannot be saved.", true);
  } else if (status.configured) {
    showStatus(keyStatus, "API key saved securely on this device.");
    showStatus(lookupStatus, "Enter a Riot ID; HenrikDev will detect the account region and platform.");
  } else {
    showStatus(keyStatus, "No API key saved.");
    showStatus(lookupStatus, "Add a HenrikDev API key in Settings to enable lookups.");
  }
}

$("rank-lookup-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = $("rank-submit");
  const values = new FormData(form);
  const riotId = String(values.get("riotId") || "").trim();
  const separator = riotId.lastIndexOf("#");
  if (separator <= 0 || separator === riotId.length - 1) {
    showStatus($("rank-lookup-status"), "Enter the full Riot ID in Name#Tag format.", true);
    return;
  }
  saveRecentSearch(riotId);
  recentSearchOpen = false;
  $("recent-searches").hidden = true;
  submitButton.disabled = true;
  submitButton.classList.add("is-loading");
  submitButton.setAttribute("aria-busy", "true");
  clearPlayerData(riotId, "Loading player stats from HenrikDev...", true);
  showStatus($("rank-lookup-status"), "Looking up rank...");

  try {
    const data = await window.frost.lookupPlayerData({
      name: riotId.slice(0, separator),
      tag: riotId.slice(separator + 1)
    });
    renderRank(data);
    showStatus($("rank-lookup-status"), `Rank updated. Detected ${data.account.region.toUpperCase()} · ${data.account.platform.toUpperCase()}.`);
  } catch (error) {
    const message = error.message || "Player lookup failed.";
    clearPlayerData(riotId, message);
    showStatus($("rank-lookup-status"), message, true);
  } finally {
    submitButton.disabled = false;
    submitButton.classList.remove("is-loading");
    submitButton.removeAttribute("aria-busy");
  }
});

$("recent-search-list").addEventListener("click", event => {
  const removeButton = event.target.closest("button[data-remove-riot-id]");
  if (removeButton) {
    const riotId = removeButton.dataset.removeRiotId;
    try {
      const savedSearches = JSON.parse(localStorage.getItem(recentSearchesKey) || "[]");
      const searches = Array.isArray(savedSearches) ? savedSearches.filter(value =>
        typeof value === "string" && value.toLowerCase() !== riotId.toLowerCase()
      ) : [];
      localStorage.setItem(recentSearchesKey, JSON.stringify(searches));
      recentSearchOpen = true;
      renderRecentSearches();
      if ($("recent-searches").hidden) $("rank-riot-id").blur();
    } catch (error) {
      showStatus($("rank-lookup-status"), "Could not remove this recent search from this device.", true);
      console.error("Could not remove recent Riot ID search.", error);
    }
    return;
  }
  const button = event.target.closest("button[data-riot-id]");
  if (!button) return;
  $("rank-riot-id").value = button.dataset.riotId;
  recentSearchOpen = false;
  $("recent-searches").hidden = true;
  $("rank-riot-id").setAttribute("aria-expanded", "false");
  $("rank-lookup-form").requestSubmit();
});

$("rank-riot-id").addEventListener("focus", () => {
  recentSearchOpen = true;
  renderRecentSearches();
});

$("rank-riot-id").addEventListener("click", () => {
  recentSearchOpen = true;
  renderRecentSearches();
});

$("rank-riot-id").addEventListener("input", updateRecentSearchVisibility);

document.addEventListener("click", event => {
  if (!event.target.closest("#rank-lookup-form")) {
    recentSearchOpen = false;
    $("recent-searches").hidden = true;
    $("rank-riot-id").setAttribute("aria-expanded", "false");
  }
});

$("rank-riot-id").addEventListener("keydown", event => {
  if (event.key === "Escape") {
    recentSearchOpen = false;
    $("recent-searches").hidden = true;
    $("rank-riot-id").setAttribute("aria-expanded", "false");
  }
});

$("api-key-form").addEventListener("submit", async event => {
  event.preventDefault();
  const keyInput = $("henrikdev-api-key");
  const apiKey = keyInput.value.trim();
  if (!apiKey) {
    showStatus($("api-key-status"), "Enter an API key before saving.", true);
    return;
  }
  try {
    await window.frost.setHenrikDevApiKey(apiKey);
    keyInput.value = "";
    await refreshHenrikDevStatus();
  } catch (error) {
    showStatus($("api-key-status"), error.message || "The API key could not be saved.", true);
  }
});

$("remove-api-key").addEventListener("click", async () => {
  try {
    await window.frost.setHenrikDevApiKey("");
    $("henrikdev-api-key").value = "";
    await refreshHenrikDevStatus();
  } catch (error) {
    showStatus($("api-key-status"), error.message || "The API key could not be removed.", true);
  }
});

function renderProfileAvatar(container, profile) {
  container.replaceChildren();
  if (profile?.avatar) {
    const image = document.createElement("img");
    image.src = profile.avatar;
    image.alt = "";
    container.append(image);
  } else {
    const initial = document.createElement("span");
    initial.textContent = profile?.name?.trim().charAt(0).toUpperCase() || "+";
    container.append(initial);
  }
}

function readProfileAvatar(input) {
  const file = input.files?.[0];
  if (!file) return Promise.resolve(null);
  const supportedTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  if (!supportedTypes.has(file.type) || file.size > maxProfileAvatarBytes) {
    return Promise.reject(new Error("Choose a PNG, JPEG, WebP, or GIF image under 50 MB."));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("The selected picture could not be read."));
    reader.readAsDataURL(file);
  });
}

function renderProfilePicker(profiles) {
  vaultProfiles = profiles;
  const list = $("profile-picker-list");
  list.replaceChildren();
  for (const profile of profiles) {
    const item = document.createElement("div");
    item.className = "profile-picker-item";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "profile-picker-card";
    button.dataset.profileId = profile.id;
    const avatar = document.createElement("span");
    avatar.className = "profile-picker-avatar";
    renderProfileAvatar(avatar, profile);
    const name = document.createElement("span");
    name.className = "profile-picker-name";
    name.textContent = profile.name;
    button.append(avatar, name);
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "profile-picker-delete";
    deleteButton.dataset.deleteProfileId = profile.id;
    deleteButton.hidden = !profilePickerEditing;
    deleteButton.setAttribute("aria-label", `Delete ${profile.name}`);
    deleteButton.title = `Delete ${profile.name}`;
    deleteButton.textContent = "×";
    item.append(button, deleteButton);
    list.append(item);
  }
  $("edit-profiles-button").hidden = profiles.length === 0;
  $("edit-profiles-button").textContent = profilePickerEditing ? "Done" : "Edit";
  $("edit-profiles-button").setAttribute("aria-pressed", String(profilePickerEditing));
  $("profile-picker-view").classList.toggle("is-editing", profilePickerEditing);
  $("add-profile-button").hidden = profiles.length > 0 && !profilePickerEditing;
  $("add-profile-button").disabled = profiles.length >= 5;
  $("add-profile-button").textContent = profiles.length >= 5 ? "Five profiles added" : "+ Add profile";
  $("add-profile-button").setAttribute("aria-label", profiles.length >= 5 ? "Maximum of five profiles reached" : "Add a profile");
}

function showVaultGate(profiles, mode = "picker") {
  renderProfilePicker(profiles);
  vaultGateMode = mode;
  const isPicker = mode === "picker";
  const isCreate = mode === "create";
  const isDelete = mode === "delete";
  const selectedProfile = profiles.find(profile => profile.id === selectedProfileId);
  $("profile-picker-view").hidden = !isPicker;
  $("profile-create-fields").hidden = !isCreate;
  $("vault-gate-form").hidden = isPicker;
  $("selected-profile-header").hidden = isPicker || isCreate;
  $("back-to-profiles").hidden = isPicker;
  $("vault-confirm-label").hidden = !isCreate;
  $("vault-confirm-control").hidden = !isCreate;
  $("vault-confirm").required = isCreate;
  $("new-profile-name").required = isCreate;
  $("vault-passcode").required = true;
  $("vault-passcode").pattern = selectedProfile?.id === "legacy" ? "[A-Za-z]{6}" : "[0-9]{6}";
  $("vault-passcode").inputMode = selectedProfile?.id === "legacy" ? "text" : "numeric";
  $("vault-confirm").pattern = "[0-9]{6}";
  $("vault-confirm-reveal").hidden = !isCreate;
  $("vault-gate-submit").disabled = false;
  $("vault-gate").classList.toggle("is-create", isCreate);
  $("vault-gate").classList.toggle("is-delete", isDelete);
  $("vault-passcode").value = "";
  $("vault-confirm").value = "";
  $("vault-passcode-label").textContent = isDelete ? "Confirm this profile's passcode" : "Master passcode";
  $("vault-passcode-warning").hidden = !isCreate;
  $("vault-restore-btn").hidden = isDelete;
  if (isCreate) {
    selectedProfileId = null;
    newProfileAvatar = null;
    $("new-profile-name").value = "";
    $("new-profile-avatar").value = "";
    renderProfileAvatar($("new-profile-avatar-preview"), null);
    $("vault-gate-title").textContent = "Create a profile";
    $("vault-gate-description").textContent = "Each profile has its own six-digit passcode and encrypted vault.";
    $("vault-gate-submit").textContent = "Create profile";
    showStatus($("vault-gate-status"), "Choose a name, optional picture, and passcode.");
  } else if (isDelete && selectedProfile) {
    $("vault-gate-title").textContent = `Delete ${selectedProfile.name}?`;
    $("vault-gate-description").textContent = "Enter this profile's passcode to permanently delete its encrypted vault and saved accounts.";
    $("selected-profile-name").textContent = selectedProfile.name;
    renderProfileAvatar($("selected-profile-avatar"), selectedProfile);
    $("vault-gate-submit").textContent = "Verify & delete profile";
    showStatus($("vault-gate-status"), "This action cannot be undone.");
  } else if (selectedProfile) {
    $("vault-gate-title").textContent = `Welcome, ${selectedProfile.name}`;
    $("vault-gate-description").textContent = "Enter this profile's six-digit passcode.";
    $("selected-profile-name").textContent = selectedProfile.name;
    renderProfileAvatar($("selected-profile-avatar"), selectedProfile);
    $("vault-gate-submit").textContent = "Unlock profile";
    showStatus($("vault-gate-status"), "Profile locked.");
  } else {
    $("vault-gate-title").textContent = "Who's using KEEPER?";
    $("vault-gate-description").textContent = profiles.length
      ? "Choose a profile to unlock its personal vault."
      : "Create your first profile to get started.";
    showStatus($("vault-gate-status"), profiles.length ? "Select a profile or add one." : "No profiles yet.");
  }
  $("app-shell").hidden = true;
  $("vault-gate").hidden = false;
  if (!isPicker) $("vault-passcode").focus();
}

function renderVaultEntries(entries) {
  vaultEntries = entries;
  const list = $("vault-entry-list");
  list.replaceChildren();
  $("vault-entry-count").textContent = `${entries.length} ${entries.length === 1 ? "ITEM" : "ITEMS"}`;
  const query = $("vault-account-search").value.trim().toLowerCase();
  const visibleEntries = entries.filter(entry => `${entry.label} ${entry.username}`.toLowerCase().includes(query));
  if (!entries.some(entry => entry.id === selectedVaultEntryId)) {
    selectedVaultEntryId = entries[0]?.id || null;
  }

  for (const entry of visibleEntries) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `vault-account-row${entry.id === selectedVaultEntryId ? " selected" : ""}`;
    item.dataset.vaultId = entry.id;
    item.setAttribute("aria-pressed", String(entry.id === selectedVaultEntryId));
    const icon = document.createElement("span");
    icon.className = "vault-account-icon";
    icon.textContent = entry.label.charAt(0).toUpperCase();
    const details = document.createElement("span");
    details.className = "vault-entry-details";
    const label = document.createElement("h3");
    label.textContent = entry.label;
    const username = document.createElement("p");
    username.textContent = entry.username;
    details.append(label, username);
    item.append(icon, details);
    list.append(item);
  }

  if (!visibleEntries.length) {
    const empty = document.createElement("p");
    empty.className = "vault-list-empty";
    empty.textContent = entries.length ? "No accounts match your search." : "Your vault is empty. Add an account to get started.";
    list.append(empty);
  }

  const selectedEntry = entries.find(entry => entry.id === selectedVaultEntryId);
  $("vault-account-detail").hidden = !selectedEntry;
  $("vault-empty-detail").hidden = Boolean(selectedEntry);
  if (selectedEntry) {
    $("vault-detail-label").textContent = selectedEntry.label;
    $("vault-detail-service-mark").textContent = selectedEntry.label.trim().charAt(0).toUpperCase() || "•";
    $("vault-detail-username").textContent = selectedEntry.username;
    $("vault-detail-password").textContent = "••••••••";
    $("vault-detail-notes").textContent = selectedEntry.notes || "";
    $("vault-detail-notes").hidden = !selectedEntry.notes;
    $("vault-entry-status").textContent = "";
  }
}

async function enterUnlockedVault(result) {
  currentProfile = result.profile;
  vaultProfiles = result.profiles || vaultProfiles;
  selectedVaultEntryId = null;
  renderVaultEntries(result.entries);
  $("sidebar-profile-name").textContent = currentProfile.name;
  renderProfileAvatar($("sidebar-profile-avatar"), currentProfile);
  $("current-profile-name").value = currentProfile.name;
  $("profile-settings-display-name").textContent = currentProfile.name;
  $("current-profile-avatar-preview").src = currentProfile.avatar || "";
  $("current-profile-avatar-preview").hidden = !currentProfile.avatar;
  profileAvatarSelection = currentProfile.avatar;
  $("vault-gate").hidden = true;
  $("app-shell").hidden = false;
  navigate("overview");
  resetVaultAutoLockTimer();
}

function getVaultAutoLockMinutes() {
  try {
    const minutes = Number(localStorage.getItem(vaultAutoLockKey) || 0);
    return [0, 5, 15, 30, 60].includes(minutes) ? minutes : 0;
  } catch {
    return 0;
  }
}

function resetVaultAutoLockTimer() {
  window.clearTimeout(vaultAutoLockTimer);
  if ($("app-shell").hidden) return;
  const minutes = getVaultAutoLockMinutes();
  if (!minutes) return;
  vaultAutoLockTimer = window.setTimeout(async () => {
    await lockVaultAndShowGate();
    showStatus($("vault-gate-status"), "Vault locked after inactivity.");
  }, minutes * 60 * 1000);
}

async function lockVaultAndShowGate() {
  window.clearTimeout(vaultAutoLockTimer);
  editingVaultEntryId = null;
  await window.frost.lockVault();
  $("vault-entry-list").replaceChildren();
  vaultEntries = [];
  selectedVaultEntryId = null;
  if ($("vault-entry-dialog").open) $("vault-entry-dialog").close();
  if ($("change-vault-passcode-dialog").open) $("change-vault-passcode-dialog").close();
  $("vault-entry-form").reset();
  $("change-vault-passcode-form").reset();
  $("vault-detail-label").textContent = "";
  $("vault-detail-username").textContent = "";
  $("vault-detail-password").textContent = "••••••••";
  $("vault-detail-notes").textContent = "";
  $("vault-entry-status").textContent = "";
  currentProfile = null;
  const status = await window.frost.getVaultStatus();
  showVaultGate(status.profiles || []);
}

async function initializeVault() {
  const status = await window.frost.getVaultStatus();
  if (status.unlocked) await window.frost.lockVault();
  showVaultGate(status.profiles || []);
}

$("vault-gate-form").addEventListener("submit", async event => {
  event.preventDefault();
  const passcode = $("vault-passcode").value;
  const confirmation = $("vault-confirm").value;
  const button = $("vault-gate-submit");
  button.disabled = true;
  const createMode = vaultGateMode === "create";
  const deleteMode = vaultGateMode === "delete";
  showStatus($("vault-gate-status"), createMode
    ? "Creating encrypted profile..."
    : deleteMode
      ? "Verifying profile passcode..."
      : "Unlocking profile...");
  try {
    let result;
    if (createMode) {
      result = await window.frost.createVaultProfile({
        name: $("new-profile-name").value,
        avatar: newProfileAvatar,
        passcode,
        confirmation
      });
    } else if (deleteMode) {
      const profile = vaultProfiles.find(candidate => candidate.id === selectedProfileId);
      if (!profile) throw new Error("Select a valid profile.");
      if (!await window.frost.confirmDeleteVaultProfile(profile.name)) {
        $("vault-passcode").value = "";
        showStatus($("vault-gate-status"), "Profile deletion canceled.");
        return;
      }
      const profiles = await window.frost.deleteVaultProfile({ profileId: selectedProfileId, passcode });
      selectedProfileId = null;
      profilePickerEditing = false;
      vaultEntries = [];
      selectedVaultEntryId = null;
      showVaultGate(profiles);
      return;
    } else {
      result = await window.frost.unlockVaultProfile({ profileId: selectedProfileId, passcode });
    }
    await enterUnlockedVault(result);
    $("vault-gate-form").reset();
  } catch (error) {
    showStatus($("vault-gate-status"), error.message || "The profile could not be opened.", true);
    $("vault-passcode").select();
  } finally {
    button.disabled = false;
  }
});

$("profile-picker-list").addEventListener("click", event => {
  const deleteButton = event.target.closest("button[data-delete-profile-id]");
  if (deleteButton) {
    selectedProfileId = deleteButton.dataset.deleteProfileId;
    showVaultGate(vaultProfiles, "delete");
    return;
  }
  const card = event.target.closest("button[data-profile-id]");
  if (!card || profilePickerEditing) return;
  selectedProfileId = card.dataset.profileId;
  showVaultGate(vaultProfiles, "unlock");
});


$("edit-profiles-button").addEventListener("click", () => {
  profilePickerEditing = !profilePickerEditing;
  renderProfilePicker(vaultProfiles);
});

$("new-profile-avatar").addEventListener("change", async event => {
  try {
    newProfileAvatar = await readProfileAvatar(event.currentTarget);
    if (newProfileAvatar) renderProfileAvatar($("new-profile-avatar-preview"), { name: "", avatar: newProfileAvatar });
  } catch (error) {
    event.currentTarget.value = "";
    newProfileAvatar = null;
    showStatus($("vault-gate-status"), error.message, true);
  }
});

$("new-profile-name").addEventListener("input", event => {
  if (!newProfileAvatar) {
    renderProfileAvatar($("new-profile-avatar-preview"), { name: event.currentTarget.value });
  }
});

$("profile-settings-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!currentProfile) return;
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const result = await window.frost.updateVaultProfile({
      name: $("current-profile-name").value,
      avatar: profileAvatarSelection
    });
    currentProfile = result.profile;
    vaultProfiles = result.profiles;
    $("sidebar-profile-name").textContent = currentProfile.name;
    $("profile-settings-display-name").textContent = currentProfile.name;
    renderProfileAvatar($("sidebar-profile-avatar"), currentProfile);
    $("current-profile-avatar-preview").src = currentProfile.avatar || "";
    $("current-profile-avatar-preview").hidden = !currentProfile.avatar;
    showStatus($("profile-settings-status"), "Profile updated.");
  } catch (error) {
    showStatus($("profile-settings-status"), error.message || "Profile could not be updated.", true);
  } finally {
    button.disabled = false;
  }
});

$("current-profile-avatar-file").addEventListener("change", async event => {
  try {
    const avatar = await readProfileAvatar(event.currentTarget);
    if (avatar) {
      profileAvatarSelection = avatar;
      $("current-profile-avatar-preview").src = avatar;
      $("current-profile-avatar-preview").hidden = false;
    }
  } catch (error) {
    event.currentTarget.value = "";
    showStatus($("profile-settings-status"), error.message || "Profile picture could not be read.", true);
  }
});

$("delete-current-profile").addEventListener("click", async () => {
  if (!currentProfile) return;
  try {
    if (!await window.frost.confirmDeleteVaultProfile(currentProfile.name)) return;
  } catch (error) {
    showStatus($("profile-settings-status"), error.message || "The profile deletion could not be confirmed.", true);
    return;
  }
  const profileId = currentProfile.id;
  try {
    await lockVaultAndShowGate();
    selectedProfileId = profileId;
    showVaultGate(vaultProfiles, "delete");
  } catch (error) {
    showStatus($("profile-settings-status"), error.message || "The profile could not be locked.", true);
  }
});

$("add-profile-button").addEventListener("click", () => {
  if (vaultProfiles.length >= 5) {
    showStatus($("vault-gate-status"), "A maximum of five profiles is allowed.", true);
    return;
  }
  showVaultGate(vaultProfiles, "create");
});

$("back-to-profiles").addEventListener("click", () => {
  selectedProfileId = null;
  $("vault-passcode").value = "";
  showVaultGate(vaultProfiles);
});


$("vault-restore-btn").addEventListener("click", async () => {
  const passcode = $("vault-passcode").value;
  const button = $("vault-restore-btn");
  if (!/^\d{6}$/.test(passcode)) {
    showStatus($("vault-gate-status"), "Enter the backup's six-digit passcode first.", true);
    $("vault-passcode").focus();
    return;
  }
  button.disabled = true;
  showStatus($("vault-gate-status"), "Choose an encrypted backup to restore...");
  try {
    const result = await window.frost.restoreVaultBackup({ passcode });
    if (result.canceled) {
      showStatus($("vault-gate-status"), "Backup restore canceled.");
      return;
    }
    await enterUnlockedVault(result);
    $("vault-gate-form").reset();
  } catch (error) {
    showStatus($("vault-gate-status"), error.message || "The backup could not be restored.", true);
  } finally {
    button.disabled = false;
  }
});

$("vault-export-btn").addEventListener("click", async () => {
  const button = $("vault-export-btn");
  button.disabled = true;
  try {
    const result = await window.frost.exportVaultBackup();
    showStatus($("vault-entry-status"), result.canceled ? "Backup export canceled." : "Encrypted backup saved. You can upload the .ftvault file to your Google Drive.");
  } catch (error) {
    showStatus($("vault-entry-status"), error.message || "The encrypted backup could not be exported.", true);
  } finally {
    button.disabled = false;
  }
});

$("lock-vault-btn").addEventListener("click", async () => {
  await lockVaultAndShowGate();
});

$("switch-profile-btn").addEventListener("click", async () => {
  selectedProfileId = null;
  await lockVaultAndShowGate();
});

$("vault-auto-lock-setting").value = String(getVaultAutoLockMinutes());
$("vault-auto-lock-setting").addEventListener("change", () => {
  try {
    localStorage.setItem(vaultAutoLockKey, $("vault-auto-lock-setting").value);
  } catch {
    showStatus($("security-settings-status"), "Could not save this setting on this device.", true);
    return;
  }
  resetVaultAutoLockTimer();
  const minutes = Number($("vault-auto-lock-setting").value);
  showStatus($("security-settings-status"), minutes === 0
    ? "The vault will not lock while idle. It is still locked when KEEPER exits or you lock it manually."
    : `The vault will lock after ${minutes === 60 ? "1 hour" : `${minutes} minutes`} of inactivity.`);
});

for (const activityEvent of ["pointerdown", "pointermove", "wheel", "keydown", "input"]) {
  document.addEventListener(activityEvent, resetVaultAutoLockTimer, true);
}

$("change-vault-passcode-btn").addEventListener("click", () => {
  $("passcode-change-status").textContent = "";
  $("change-vault-passcode-dialog").showModal();
  $("change-vault-passcode-form").elements.namedItem("currentPasscode").focus();
});

$("cancel-passcode-change").addEventListener("click", () => {
  $("change-vault-passcode-dialog").close();
  $("change-vault-passcode-form").reset();
});

$("change-vault-passcode-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  showStatus($("passcode-change-status"), "Verifying and re-encrypting vault...");
  try {
    await window.frost.changeVaultPasscode({
      currentPasscode: values.get("currentPasscode"),
      newPasscode: values.get("newPasscode"),
      confirmation: values.get("confirmation")
    });
    form.reset();
    $("change-vault-passcode-dialog").close();
    showStatus($("security-settings-status"), "Master passcode changed. Your existing entries were preserved.");
  } catch (error) {
    showStatus($("passcode-change-status"), error.message || "The master passcode could not be changed.", true);
  } finally {
    button.disabled = false;
  }
});

$("add-vault-entry-btn").addEventListener("click", () => {
  editingVaultEntryId = null;
  $("vault-entry-form").reset();
  $("vault-entry-dialog-title").textContent = "Add account";
  $("vault-entry-submit").textContent = "Save encrypted account";
  $("vault-dialog-status").textContent = "";
  $("vault-entry-dialog").showModal();
  $("vault-entry-form").elements.namedItem("label").focus();
});

$("vault-cancel-entry").addEventListener("click", () => {
  $("vault-entry-dialog").close();
  $("vault-entry-form").reset();
  editingVaultEntryId = null;
});

$("vault-entry-dialog").addEventListener("close", () => {
  $("vault-entry-form").reset();
  editingVaultEntryId = null;
});

$("vault-entry-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  showStatus($("vault-dialog-status"), editingVaultEntryId ? "Updating encrypted entry..." : "Encrypting entry...");
  try {
    const entry = {
      label: values.get("label"),
      username: values.get("username"),
      password: values.get("password"),
      notes: values.get("notes")
    };
    const savedId = editingVaultEntryId;
    const entries = savedId
      ? await window.frost.updateVaultEntry(savedId, entry)
      : await window.frost.saveVaultEntry(entry);
    form.reset();
    $("vault-entry-dialog").close();
    editingVaultEntryId = null;
    selectedVaultEntryId = savedId || entries[0]?.id || null;
    renderVaultEntries(entries);
    showStatus($("vault-entry-status"), savedId
      ? "Account updated and encrypted on this device."
      : "Entry encrypted and saved on this device.");
  } catch (error) {
    showStatus($("vault-dialog-status"), error.message || "The entry could not be saved.", true);
  } finally {
    button.disabled = false;
  }
});

$("edit-vault-account").addEventListener("click", async event => {
  const entry = vaultEntries.find(item => item.id === selectedVaultEntryId);
  if (!entry) return;
  const button = event.currentTarget;
  button.disabled = true;
  editingVaultEntryId = entry.id;
  $("vault-entry-form").reset();
  $("vault-entry-dialog-title").textContent = "Edit account";
  $("vault-entry-submit").textContent = "Save changes";
  $("vault-dialog-status").textContent = "";
  $("vault-entry-form").elements.namedItem("label").value = entry.label;
  $("vault-entry-form").elements.namedItem("username").value = entry.username;
  $("vault-entry-form").elements.namedItem("notes").value = entry.notes || "";
  $("vault-entry-form").elements.namedItem("password").value = "";
  $("vault-entry-dialog").showModal();
  showStatus($("vault-dialog-status"), "Loading saved password...");
  try {
    const password = await window.frost.revealVaultPassword(entry.id);
    if (!$("vault-entry-dialog").open || editingVaultEntryId !== entry.id) return;
    $("vault-entry-form").elements.namedItem("password").value = password;
    $("vault-dialog-status").textContent = "";
    $("vault-entry-form").elements.namedItem("label").focus();
  } catch (error) {
    $("vault-entry-dialog").close();
    editingVaultEntryId = null;
    showStatus($("vault-entry-status"), error.message || "Account could not be opened for editing.", true);
  } finally {
    button.disabled = false;
  }
});

$("vault-entry-list").addEventListener("click", async event => {
  const row = event.target.closest("button[data-vault-id]");
  if (!row) return;
  selectedVaultEntryId = row.dataset.vaultId;
  renderVaultEntries(vaultEntries);
});

$("vault-account-search").addEventListener("input", () => renderVaultEntries(vaultEntries));

$("open-riot-client").addEventListener("click", async () => {
  const button = $("open-riot-client");
  if (!selectedVaultEntryId) return;
  button.disabled = true;
  showStatus($("vault-entry-status"), "Opening Riot Client and looking for its sign-in form...");
  try {
    const result = await window.frost.openRiotClient(selectedVaultEntryId);
    showStatus($("vault-entry-status"), result.message);
  } catch (error) {
    showStatus($("vault-entry-status"), error.message || "Riot Client could not be opened.", true);
  } finally {
    button.disabled = false;
  }
});

$("copy-vault-username").addEventListener("click", async () => {
  try {
    await window.frost.copyVaultUsername(selectedVaultEntryId);
    showStatus($("vault-entry-status"), "Username copied to clipboard.");
  } catch (error) {
    showStatus($("vault-entry-status"), error.message || "Username could not be copied.", true);
  }
});

$("copy-vault-detail-password").addEventListener("click", async () => {
  try {
    await window.frost.copyVaultPassword(selectedVaultEntryId);
    showStatus($("vault-entry-status"), "Password copied. Clipboard clears after 30 seconds if unchanged.");
  } catch (error) {
    showStatus($("vault-entry-status"), error.message || "Password could not be copied.", true);
  }
});

$("reveal-vault-detail-password").addEventListener("click", async () => {
  try {
    const password = await window.frost.revealVaultPassword(selectedVaultEntryId);
    $("vault-detail-password").textContent = password;
    window.setTimeout(() => {
      if ($("vault-detail-password").isConnected) $("vault-detail-password").textContent = "••••••••";
    }, 15000);
  } catch (error) {
    showStatus($("vault-entry-status"), error.message || "Password could not be revealed.", true);
  }
});

$("delete-vault-account").addEventListener("click", async () => {
  const selectedEntry = vaultEntries.find(entry => entry.id === selectedVaultEntryId);
  if (!selectedEntry || !window.confirm(`Delete ${selectedEntry.label} from the vault?`)) return;
  try {
    const entries = await window.frost.deleteVaultEntry(selectedVaultEntryId);
    selectedVaultEntryId = null;
    renderVaultEntries(entries);
    showStatus($("vault-entry-status"), "Account deleted.");
  } catch (error) {
    showStatus($("vault-entry-status"), error.message || "Account could not be deleted.", true);
  }
});

function bindPasscodeHoldReveal(buttonId, inputId) {
  const button = $(buttonId);
  const input = $(inputId);
  const reveal = () => { input.type = "text"; };
  const mask = () => { input.type = "password"; };
  button.addEventListener("pointerdown", event => {
    event.preventDefault();
    reveal();
    button.setPointerCapture(event.pointerId);
  });
  button.addEventListener("pointerup", mask);
  button.addEventListener("pointercancel", mask);
  button.addEventListener("keydown", event => {
    if (event.code === "Space" || event.code === "Enter") reveal();
  });
  button.addEventListener("keyup", mask);
  button.addEventListener("blur", mask);
}

function bindNumericPasscode(inputId) {
  const input = $(inputId);
  input.addEventListener("beforeinput", event => {
    if (event.inputType.startsWith("insert") && event.data && /\D/.test(event.data)) {
      event.preventDefault();
    }
  });
  input.addEventListener("input", () => {
    const digits = input.value.replace(/\D/g, "").slice(0, 6);
    if (input.value !== digits) input.value = digits;
  });
}

for (const inputId of [
  "vault-passcode", "vault-confirm", "new-vault-passcode", "confirm-vault-passcode"
]) {
  bindNumericPasscode(inputId);
}

bindPasscodeHoldReveal("vault-passcode-reveal", "vault-passcode");
bindPasscodeHoldReveal("vault-confirm-reveal", "vault-confirm");

initializeVault().catch(error => {
  $("app-shell").hidden = true;
  $("vault-gate").hidden = false;
  showStatus($("vault-gate-status"), error.message || "Could not check the local vault.", true);
});

refreshHenrikDevStatus().catch(error => {
  showStatus($("api-key-status"), error.message || "Could not check HenrikDev settings.", true);
  $("rank-submit").disabled = true;
});
