const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, globalShortcut, ipcMain, dialog, screen, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const https = require("node:https");
const backendConfig = require("./backend-config");
const { CommunityService } = require("./community-service");

app.setName("clipfarm");
app.setAppUserModelId("de.clipfarm.desktop");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const hasSingleInstance = app.requestSingleInstanceLock();
if (!hasSingleInstance) app.quit();

let localHost = null;
let baseUrl = null;
let mainWindow = null;
let splashWindow = null;
let tray = null;
let closing = false;
let shutdownPromise = null;
let startupError = null;
let activeHotkeys = {};
let pendingClipOutcomes = [];
let clipOverlayWindow = null;
let pendingOverlayOutcome = null;
let clipOverlayHideTimer = null;
let clipOverlayReady = false;
let sessionStorePath = null;
let pendingUploadDirectory = null;
let accountUser = null;
let accessToken = null;
let accessTokenExpiresAt = 0;
let refreshToken = null;
let sessionRemembered = false;
let sessionRestorePromise = null;
let clipSaveInFlight = null;
let uploadQueue = new Map();
let uploadWorkers = new Set();
let uploadRetryTimer = null;
let community = null;
let updateMonitorTimer = null;
let updatePromptPromise = null;
let promptedUpdateVersion = null;
const latestReleaseUrl = "https://api.github.com/repos/testaccount2109/clipfarm/releases/latest";
const startedHidden = process.argv.includes("--hidden");
let updateState = {
  status: app.isPackaged && process.platform === "win32" ? "checking" : "development",
  latestVersion: null,
  publishedAt: null,
  releaseUrl: null,
  error: null
};

function parseReleaseVersion(value) {
  const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const leftParts = parseReleaseVersion(left);
  const rightParts = parseReleaseVersion(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function requestLatestRelease() {
  return new Promise((resolve, reject) => {
    const request = https.get(latestReleaseUrl, {
      headers: {
        "User-Agent": "Clipfarm-Version-Check",
        Accept: "application/vnd.github+json"
      }
    }, (response) => {
      let body = "";
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`GitHub antwortet mit HTTP ${response.statusCode || "?"}.`));
        return;
      }
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 256 * 1024) request.destroy(new Error("Die Antwort von GitHub ist zu groß."));
      });
      response.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error("Die Versionsinformation von GitHub ist ungültig.")); }
      });
      response.on("error", reject);
    });
    request.setTimeout(5000, () => request.destroy(new Error("Zeitüberschreitung bei der GitHub-Abfrage.")));
    request.on("error", reject);
  });
}

function getAppInfo() {
  return {
    version: app.getVersion(),
    electronVersion: process.versions.electron || "Unbekannt",
    platform: process.platform === "win32" ? "Windows" : process.platform,
    architecture: process.arch,
    updaterIncluded: app.isPackaged && process.platform === "win32",
    updateStatus: updateState.status,
    latestVersion: updateState.latestVersion,
    publishedAt: updateState.publishedAt,
    releaseUrl: updateState.releaseUrl,
    updateError: updateState.error
  };
}

async function launchBundledUpdater() {
  if (!app.isPackaged || process.platform !== "win32") throw new Error("Der automatische Updater ist nur in der installierten Windows-Version verfügbar.");
  const bundledUpdater = path.join(process.resourcesPath, "Clipfarm-Updater.exe");
  if (!fs.existsSync(bundledUpdater)) throw new Error("Der mitgelieferte Clipfarm-Updater wurde nicht gefunden.");

  const updaterDirectory = path.join(app.getPath("temp"), "clipfarm-updater");
  fs.mkdirSync(updaterDirectory, { recursive: true });
  const temporaryUpdater = path.join(updaterDirectory, `Clipfarm-Updater-${app.getVersion()}.exe`);
  fs.copyFileSync(bundledUpdater, temporaryUpdater);

  await new Promise((resolve, reject) => {
    const updater = spawn(temporaryUpdater, [`--wait-pid=${process.pid}`], {
      cwd: updaterDirectory,
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    updater.once("error", reject);
    updater.once("spawn", () => {
      updater.unref();
      resolve();
    });
  });

  updateState.status = "installing";
  updateState.error = null;
  app.quit();
}

async function checkForUpdates() {
  if (process.platform !== "win32") {
    updateState = { ...updateState, status: "unsupported", error: null };
    return getAppInfo();
  }

  updateState = { ...updateState, status: "checking", error: null };
  try {
    const release = await requestLatestRelease();
    const latestVersion = parseReleaseVersion(release && release.tag_name)?.join(".");
    if (!latestVersion) throw new Error("Das neueste GitHub-Release hat keine gültige Versionsnummer.");

    updateState.latestVersion = latestVersion;
    updateState.publishedAt = release.published_at || null;
    updateState.releaseUrl = release.html_url || null;
    if (compareVersions(latestVersion, app.getVersion()) <= 0) {
      updateState.status = "current";
      return getAppInfo();
    }

    updateState.status = "available";
    if (app.isPackaged) {
      const assetNames = new Set(Array.isArray(release.assets) ? release.assets.map((asset) => asset && asset.name) : []);
      const archiveName = `clipfarm-App-${latestVersion}.zip`;
      if (!assetNames.has(archiveName) || !assetNames.has(`${archiveName}.sha256`)) {
        updateState.status = "updater-error";
        updateState.error = "Das neueste GitHub-Release enthält kein vollständiges Clipfarm-Updatepaket.";
      }
    }
    return getAppInfo();
  } catch (error) {
    updateState.status = "unavailable";
    updateState.error = error.message;
    return getAppInfo();
  }
}

async function installAvailableUpdate() {
  if (updateState.status !== "available" || !updateState.latestVersion) throw new Error("Es ist kein installierbares Update verfügbar.");
  await launchBundledUpdater();
  return getAppInfo();
}

async function promptForUpdate(info) {
  if (info.updateStatus !== "available" || promptedUpdateVersion === info.latestVersion || updatePromptPromise) return;
  promptedUpdateVersion = info.latestVersion;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("clipfarm:update:available", info);
  updatePromptPromise = (async () => {
    const options = {
      type: "info",
      title: "Clipfarm-Update verfügbar",
      message: `Clipfarm ${info.latestVersion} kann installiert werden.`,
      detail: "Deine Clips und Einstellungen bleiben erhalten. Clipfarm wird für die Installation neu gestartet.",
      buttons: ["Jetzt installieren", "Später"],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    };
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    if (result.response === 0) await installAvailableUpdate();
  })().catch((error) => {
    updateState = { ...updateState, status: "updater-error", error: error.message };
  }).finally(() => { updatePromptPromise = null; });
  await updatePromptPromise;
}

function startUpdateMonitor() {
  if (!app.isPackaged || process.platform !== "win32") return;
  const check = async () => {
    const info = await checkForUpdates();
    await promptForUpdate(info);
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send("clipfarm:update:state", getAppInfo());
    }
  };
  check().catch(() => {});
  clearInterval(updateMonitorTimer);
  updateMonitorTimer = setInterval(() => check().catch(() => {}), 5 * 60 * 1000);
  updateMonitorTimer.unref?.();
}

function getAutostartEnabled() {
  if (process.platform !== "win32" || !app.isPackaged) return false;
  const preferencePath = path.join(app.getPath("userData"), "startup-preference.json");
  try {
    const preference = JSON.parse(fs.readFileSync(preferencePath, "utf8"));
    return preference.enabled !== false;
  } catch { return true; }
}

function setAutostartEnabled(enabled) {
  if (process.platform !== "win32" || !app.isPackaged) return false;
  const preferencePath = path.join(app.getPath("userData"), "startup-preference.json");
  fs.mkdirSync(path.dirname(preferencePath), { recursive: true });
  fs.writeFileSync(preferencePath, JSON.stringify({ enabled: Boolean(enabled) }), "utf8");
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled), path: process.execPath, args: ["--hidden"] });
  return Boolean(enabled);
}

function ensureDefaultAutostart() {
  if (process.platform !== "win32" || !app.isPackaged) return;
  const enabled = getAutostartEnabled();
  if (enabled && !app.getLoginItemSettings().openAtLogin) {
    app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args: ["--hidden"] });
  } else if (!enabled && app.getLoginItemSettings().openAtLogin) {
    app.setLoginItemSettings({ openAtLogin: false });
  }
}

const productRoot = app.getAppPath();
const iconPath = app.isPackaged
  ? path.join(process.resourcesPath, "clipfarm.ico")
  : path.join(__dirname, "desktop", "branding", "clipfarm.ico");
const appIcon = nativeImage.createFromPath(iconPath);
let gameIconProcessId = null;
let gameIconDataUrl = null;

function normalizeGameName(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function findExecutableBelow(directory, executableName, maxDepth = 5) {
  const wantedName = path.basename(executableName).toLowerCase();
  if (!wantedName || !directory || !fs.existsSync(directory)) return null;
  const pending = [{ directory, depth: 0 }];
  const skippedDirectories = new Set([".egstore", "engine", "plugins", "saved", "node_modules", ".git"]);
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase() === wantedName) return path.join(current.directory, entry.name);
      if (entry.isDirectory() && current.depth < maxDepth && !skippedDirectories.has(entry.name.toLowerCase())) {
        pending.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
      }
    }
  }
  return null;
}

function findInstalledGameExecutable(session) {
  const processName = path.basename(String(session.process || ""));
  const gameName = normalizeGameName(session.game);
  if (!processName || !gameName) return null;
  const installRoots = [];
  const epicManifestDirectory = path.join(process.env.PROGRAMDATA || "C:\\ProgramData", "Epic", "EpicGamesLauncher", "Data", "Manifests");
  try {
    for (const name of fs.readdirSync(epicManifestDirectory)) {
      if (!name.toLowerCase().endsWith(".item")) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(epicManifestDirectory, name), "utf8"));
        if (normalizeGameName(manifest.DisplayName) === gameName && manifest.InstallLocation) installRoots.push(manifest.InstallLocation);
      } catch { /* ignore malformed launcher manifests */ }
    }
  } catch { /* Epic Games Launcher is optional */ }

  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const steamRoots = [path.join(programFilesX86, "Steam"), path.join(process.env.ProgramFiles || "C:\\Program Files", "Steam")];
  for (const steamRoot of steamRoots) {
    const libraries = new Set([steamRoot]);
    try {
      const folders = fs.readFileSync(path.join(steamRoot, "steamapps", "libraryfolders.vdf"), "utf8");
      for (const match of folders.matchAll(/"path"\s+"([^"]+)"/gi)) libraries.add(match[1].replace(/\\\\/g, "\\"));
    } catch { /* a single Steam library is enough when no library list is available */ }
    for (const library of libraries) {
      const steamApps = path.join(library, "steamapps");
      try {
        for (const manifestName of fs.readdirSync(steamApps)) {
          if (!/^appmanifest_\d+\.acf$/i.test(manifestName)) continue;
          try {
            const manifest = fs.readFileSync(path.join(steamApps, manifestName), "utf8");
            const name = manifest.match(/"name"\s+"([^"]+)"/i)?.[1];
            const installDirectory = manifest.match(/"installdir"\s+"([^"]+)"/i)?.[1];
            if (normalizeGameName(name) === gameName && installDirectory) installRoots.push(path.join(steamApps, "common", installDirectory));
          } catch { /* ignore malformed Steam manifests */ }
        }
      } catch { /* this Steam library is unavailable */ }
    }
  }

  for (const root of [...new Set(installRoots)]) {
    const executable = findExecutableBelow(root, processName);
    if (executable) return executable;
  }
  return null;
}

function prepareUserData() {
  const dataDirectory = app.getPath("userData");
  fs.mkdirSync(dataDirectory, { recursive: true });
  const destination = path.join(dataDirectory, "engine-config.json");

  if (!fs.existsSync(destination)) {
    const localAppData = process.env.LOCALAPPDATA || app.getPath("appData");
    const candidates = [
      path.join(localAppData, "Spool", "engine-config.json"),
      path.join(productRoot, "engine-config.json")
    ].filter((candidate) => fs.existsSync(candidate));
    candidates.sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
    if (candidates.length) {
      const initialConfig = JSON.parse(fs.readFileSync(candidates[0], "utf8"));
      if (!initialConfig.clipDirectory || !path.isAbsolute(initialConfig.clipDirectory)) {
        initialConfig.clipDirectory = path.join(app.getPath("videos"), "clipfarm");
      }
      if (!fs.existsSync(initialConfig.clipDirectory)) {
        initialConfig.clipDirectory = path.join(app.getPath("videos"), "clipfarm");
      }
      if (!initialConfig.bufferDirectory || !path.isAbsolute(initialConfig.bufferDirectory)) {
        initialConfig.bufferDirectory = path.join(app.getPath("temp"), "clipfarm-buffer");
      }
      fs.writeFileSync(destination, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf8");
    }
  }

  process.env.SPOOL_DATA_DIR = dataDirectory;
  process.env.CLIPFARM_PORT = "0";
  pendingUploadDirectory = path.join(dataDirectory, "pending-uploads");
  sessionStorePath = path.join(dataDirectory, "account-session.bin");
  fs.mkdirSync(pendingUploadDirectory, { recursive: true });
  process.env.CLIPFARM_STAGING_DIR = pendingUploadDirectory;
  process.env.CLIPFARM_AUDIO_HELPER = app.isPackaged
    ? path.join(process.resourcesPath, "clipfarm-audio.exe")
    : path.join(productRoot, "tools", "clipfarm-audio.exe");
}

async function clearLegacyOfflineClipsOnce() {
  const markerPath = path.join(app.getPath("userData"), "cloud-media-migration-v1.done");
  if (fs.existsSync(markerPath)) return;
  const config = await api("/api/config");
  const configuredDirectory = String(config.config?.clipDirectory || "");
  if (!path.isAbsolute(configuredDirectory)) {
    throw new Error("Der Clip-Ordner konnte für die einmalige Cloud-Migration nicht sicher bestimmt werden.");
  }
  const clipDirectory = path.resolve(configuredDirectory);
  if (clipDirectory === path.parse(clipDirectory).root) throw new Error("Der Clip-Ordner darf nicht auf einem Laufwerksstamm liegen.");
  await fs.promises.mkdir(clipDirectory, { recursive: true });
  for (const entry of await fs.promises.readdir(clipDirectory, { withFileTypes: true })) {
    if (!entry.name.toLowerCase().endsWith(".mp4")) continue;
    const target = path.join(clipDirectory, entry.name);
    try {
      const info = await fs.promises.lstat(target);
      if (info.isFile() || info.isSymbolicLink()) await fs.promises.rm(target, { force: true });
    } catch { /* A clip removed by another cleanup can be ignored. */ }
  }
  await fs.promises.rm(path.join(clipDirectory, ".thumbs"), { recursive: true, force: true });
  // Keep queued cloud uploads so CommunityService can finish syncing them.
  await fs.promises.writeFile(markerPath, new Date().toISOString(), { flag: "wx" });
}

function toElectronAccelerator(specification) {
  const parts = String(specification || "").toUpperCase().split("+").filter(Boolean);
  const key = parts.pop();
  const modifiers = { CTRL: "Ctrl", ALT: "Alt", SHIFT: "Shift", WIN: "Super" };
  if (!key || parts.some((part) => !modifiers[part])) return null;
  return [...parts.map((part) => modifiers[part]), key].join("+");
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, silent: true }).show();
}

function showClipOutcomeOverlay(outcome) {
  if (!clipOverlayWindow || clipOverlayWindow.isDestroyed()) createClipOverlayWindow();
  const overlay = clipOverlayWindow;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.bounds;
  const overlayWidth = 400;
  const overlayHeight = 104;
  overlay.setBounds({
    x: Math.round(x + 22),
    y: Math.round(y + height - overlayHeight - 24),
    width: overlayWidth,
    height: overlayHeight
  });
  pendingOverlayOutcome = outcome;
  if (clipOverlayReady) presentClipOutcomeOverlay();
}

function presentClipOutcomeOverlay() {
  const overlay = clipOverlayWindow;
  if (!overlay || overlay.isDestroyed() || !clipOverlayReady || !pendingOverlayOutcome) return;
  const outcome = pendingOverlayOutcome;
  pendingOverlayOutcome = null;
  overlay.webContents.send("clipfarm:overlay-outcome", outcome);
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.showInactive();
  overlay.moveTop();
  const duration = outcome.outcome === "saving" ? 2600 : 3900;
  clearTimeout(clipOverlayHideTimer);
  clipOverlayHideTimer = setTimeout(() => {
    if (clipOverlayWindow && !clipOverlayWindow.isDestroyed()) clipOverlayWindow.hide();
  }, duration);
}

function createClipOverlayWindow() {
  clipOverlayWindow = new BrowserWindow({
    width: 360,
    height: 92,
    x: 22,
    y: 22,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "overlay-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  const overlay = clipOverlayWindow;
  clipOverlayReady = false;
  overlay.setMenuBarVisibility(false);
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setContentProtection(true);
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.once("closed", () => {
    if (clipOverlayWindow === overlay) {
      clipOverlayWindow = null;
      clipOverlayReady = false;
    }
    pendingOverlayOutcome = null;
    clearTimeout(clipOverlayHideTimer);
  });
  overlay.webContents.once("did-finish-load", () => {
    clipOverlayReady = true;
    presentClipOutcomeOverlay();
  });
  overlay.loadFile(path.join(__dirname, "overlay.html")).catch(() => overlay.hide());
}

function reportClipOutcome(outcome, message = "") {
  const result = { outcome, message: String(message || "").slice(0, 180) };
  showClipOutcomeOverlay(result);
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed() || mainWindow.webContents.isLoading()) {
    pendingClipOutcomes.push(result);
    pendingClipOutcomes = pendingClipOutcomes.slice(-4);
    return;
  }
  mainWindow.webContents.send("clipfarm:clip-outcome", result);
}

function flushClipOutcomes() {
  const outcomes = pendingClipOutcomes;
  pendingClipOutcomes = [];
  outcomes.forEach((outcome) => mainWindow.webContents.send("clipfarm:clip-outcome", outcome));
}

async function api(pathname, options = {}) {
  if (!baseUrl) throw new Error("Clipfarm ist noch nicht gestartet.");
  const response = await fetch(`${baseUrl}${pathname}`, options);
  let payload = {};
  try { payload = await response.json(); } catch { /* an empty response is reported below */ }
  if (!response.ok) throw new Error(payload.error || `Clipfarm antwortet mit ${response.status}.`);
  return payload;
}

async function getBackendStatus() {
  const checkedAt = new Date().toISOString();
  try {
    const response = await fetch(`${backendConfig.apiBase}${backendConfig.healthPath}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(7000),
      redirect: "error"
    });
    const basicAuthRequired = response.status === 401 && /\bBasic\b/i.test(response.headers.get("www-authenticate") || "");
    let payload = {};
    try { payload = await response.json(); } catch { /* Unrecognized API responses are reported below. */ }
    const inspection = backendConfig.inspectHealth(response.ok ? payload : null);
    return {
      origin: backendConfig.origin,
      checkedAt,
      reachable: true,
      secure: true,
      status: response.status,
      basicAuthRequired,
      ...inspection,
      message: basicAuthRequired
        ? "Der API-Endpunkt verlangt HTTP-Basic-Auth. Zugangsdaten werden nicht gesendet."
        : response.ok
          ? inspection.message
          : `Der Server antwortet mit HTTP ${response.status}.`
    };
  } catch (error) {
    return {
      origin: backendConfig.origin,
      checkedAt,
      reachable: false,
      secure: true,
      status: null,
      basicAuthRequired: false,
      apiConfirmed: false,
      serverVersion: null,
      capabilities: [],
      missingCapabilities: [...backendConfig.requiredCapabilities],
      available: false,
      compatible: false,
      outdated: false,
      minimumApiVersion: backendConfig.minimumApiVersion,
      message: error.name === "TimeoutError"
        ? "Zeitüberschreitung beim Verbinden mit der Clipfarm-API."
        : "Die Clipfarm-API ist nicht erreichbar. Prüfe deine Internetverbindung und den Serverstatus."
    };
  }
}

function isTrustedRenderer(event) {
  if (!baseUrl || !event.senderFrame) return false;
  try {
    return new URL(event.senderFrame.url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

async function saveReplay() {
  if (clipSaveInFlight) return;
  clipSaveInFlight = true;
  showClipOutcomeOverlay({ outcome: "saving", message: "2 Sekunden Nachlauf – Clip wird gesichert." });
  try {
    const [settings, session] = await Promise.all([api("/api/config"), api("/api/session")]);
    const result = await api("/api/clip/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seconds: settings.config.replayLength, game: session.game || "Game" })
    });

    const keepLocal = (message) => {
      const fullMessage = message + " · " + path.basename(result.clip.file);
      reportClipOutcome("success", fullMessage);
      return { ...result, localOnly: true, message };
    };

    if (!community) return keepLocal("Clip lokal gesichert. Die Upload-Warteschlange wird noch gestartet.");
    let account;
    try { account = await community.getAccount(); }
    catch { return keepLocal("Clip lokal gesichert. Die Konto-API ist nicht erreichbar; es wurde kein Upload gestartet."); }
    if (!account?.user) return keepLocal("Clip lokal gesichert. Melde dich an, wenn du ihn hochladen möchtest.");

    let profile;
    try {
      profile = await community.getProfile();
    } catch (error) {
      // Version 1.0 APIs lack profile routes; their default behavior shares uploads.
      if (error.status === 404) profile = { localOnly: false };
      else return keepLocal("Clip lokal gesichert. API-Profilstatus nicht verfügbar; Upload ausgesetzt.");
    }

    if (profile.localOnly) return keepLocal("Clip nur auf diesem PC gespeichert.");
    let queued;
    try { queued = await community.queueClip(result.clip, true); }
    catch { return keepLocal("Clip lokal gesichert. Er konnte nicht in die Upload-Warteschlange übernommen werden."); }
    const message = "Clip lokal gesichert · Upload vorgemerkt";
    reportClipOutcome("success", message + " · " + (result.clip.name || "Clip"));
    return { ...result, localOnly: false, upload: queued, message };
  } catch (error) {
    reportClipOutcome("failed", error.message);
    throw error;
  } finally {
    clipSaveInFlight = false;
  }
}

async function toggleReplay() {
  const engine = await api("/api/engine");
  const next = await api(engine.state === "running" ? "/api/engine/stop" : "/api/engine/start", { method: "POST" });
  notify("clipfarm", next.state === "running" ? "Instant Replay läuft." : "Instant Replay pausiert.");
}

async function toggleMicrophone() {
  const result = await api("/api/audio/mic", { method: "POST" });
  notify("clipfarm", result.micEnabled ? "Mikrofon aktiviert." : "Mikrofon deaktiviert.");
}

function runHotkey(action) {
  const actions = { save: saveReplay, toggle: toggleReplay, microphone: toggleMicrophone };
  actions[action]?.().catch((error) => { if (action !== "save") notify("clipfarm", error.message); });
}

function registerGlobalHotkeys(hotkeys = {}) {
  const previous = activeHotkeys;
  const candidate = { save: hotkeys.save, toggle: hotkeys.toggle, microphone: hotkeys.microphone };
  const attempt = (specifications) => {
    globalShortcut.unregisterAll();
    const registered = [];
    const failed = [];
    for (const action of ["save", "toggle", "microphone"]) {
      const specification = String(specifications[action] || "");
      const accelerator = toElectronAccelerator(specification);
      if (!accelerator || !globalShortcut.register(accelerator, () => runHotkey(action))) {
        failed.push(specification || action);
        continue;
      }
      registered.push(specification);
    }
    return { registered, failed };
  };

  const result = attempt(candidate);
  if (!result.failed.length) {
    activeHotkeys = candidate;
    return result;
  }

  const restored = attempt(previous);
  if (!restored.failed.length) activeHotkeys = previous;
  else activeHotkeys = {};
  return { ...result, restored: restored.failed.length === 0 };
}

function openMainWindow() {
  if (!baseUrl || closing) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray || !fs.existsSync(iconPath)) return;
  tray = new Tray(appIcon.isEmpty() ? nativeImage.createFromPath(iconPath) : appIcon);
  tray.setToolTip("clipfarm · Lokales Instant Replay");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "clipfarm öffnen", click: openMainWindow },
    { type: "separator" },
    { label: "Letzten Clip speichern", click: () => runHotkey("save") },
    { label: "Replay an / aus", click: () => runHotkey("toggle") },
    { label: "Mikrofon an / aus", click: () => runHotkey("microphone") },
    { type: "separator" },
    { label: "Beenden", click: () => app.quit() }
  ]));
  tray.on("double-click", openMainWindow);
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 390,
    height: 224,
    frame: false,
    resizable: false,
    movable: true,
    show: true,
    center: true,
    backgroundColor: "#111411",
    icon: iconPath,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  if (!appIcon.isEmpty()) splashWindow.setIcon(appIcon);
  splashWindow.removeMenu();
  splashWindow.loadFile(path.join(__dirname, "splash.html"));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    title: "clipfarm",
    width: 1280,
    height: 840,
    minWidth: 1060,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0d0f10",
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  if (!appIcon.isEmpty()) mainWindow.setIcon(appIcon);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, destination) => {
    try {
      if (new URL(destination).origin !== new URL(baseUrl).origin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  mainWindow.on("close", (event) => {
    if (!closing) {
      event.preventDefault();
      const window = mainWindow;
      mainWindow = null;
      window.destroy();
    }
  });
  mainWindow.once("closed", () => { if (mainWindow?.isDestroyed()) mainWindow = null; });
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    splashWindow = null;
    if (startupError) mainWindow.webContents.send("clipfarm:startup-error", startupError);
  });
  mainWindow.webContents.once("did-finish-load", flushClipOutcomes);
  mainWindow.loadURL(baseUrl).catch((error) => {
    dialog.showErrorBox("clipfarm konnte nicht geöffnet werden", error.message);
    app.quit();
  });
}

ipcMain.handle("clipfarm:hotkeys:sync", (event, hotkeys) => {
  if (!isTrustedRenderer(event)) throw new Error("Nicht vertrauenswürdiger Renderer.");
  return registerGlobalHotkeys(hotkeys);
});
ipcMain.handle("clipfarm:app:info", (event) => {
  if (!isTrustedRenderer(event)) throw new Error("Nicht vertrauenswürdiger Renderer.");
  return getAppInfo();
});
ipcMain.handle("clipfarm:update:check", async (event) => {
  if (!isTrustedRenderer(event)) throw new Error("Nicht vertrauenswürdiger Renderer.");
  return checkForUpdates();
});
ipcMain.handle("clipfarm:update:install", async (event) => {
  if (!isTrustedRenderer(event)) throw new Error("Nicht vertrauenswürdiger Renderer.");
  return installAvailableUpdate();
});
ipcMain.handle("clipfarm:startup:get", (event) => {
  if (!isTrustedRenderer(event)) throw new Error("Nicht vertrauenswürdiger Renderer.");
  return { enabled: getAutostartEnabled(), supported: app.isPackaged && process.platform === "win32" };
});
ipcMain.handle("clipfarm:startup:set", (event, enabled) => {
  if (!isTrustedRenderer(event)) throw new Error("Nicht vertrauenswürdiger Renderer.");
  return { enabled: setAutostartEnabled(enabled), supported: app.isPackaged && process.platform === "win32" };
});
ipcMain.handle("clipfarm:backend:status", async (event) => {
  if (!isTrustedRenderer(event)) throw new Error("Nicht vertrauenswürdiger Renderer.");
  return community ? community.getBackendStatus() : getBackendStatus();
});
ipcMain.handle("clipfarm:account:get", async (event) => {
  if (!isTrustedRenderer(event)) throw new Error("Nicht vertrauenswürdiger Renderer.");
  return community ? community.getAccount() : { user: null, offline: true };
});
ipcMain.handle("clipfarm:account:login", async (event, mode, credentials) => {
  if (!isTrustedRenderer(event)) throw new Error("Nicht vertrauenswürdiger Renderer.");
  if (!community || !["login", "register"].includes(mode)) throw new Error("Anmeldung ist derzeit nicht verfügbar.");
  return community.authenticate(mode, credentials);
});
ipcMain.handle("clipfarm:account:logout", async (event) => {
  if (!isTrustedRenderer(event)) throw new Error("Nicht vertrauenswürdiger Renderer.");
  if (!community) return true;
  try {
    const account = await community.getAccount();
    if (account.user) await community.authenticatedRequest("/auth/logout", { method: "POST" });
  } catch { /* Forget the local session even when the server is offline. */ }
  await community.clearSession();
  return true;
});
ipcMain.handle("clipfarm:feed:get", async (event, cursor) => {
  if (!isTrustedRenderer(event)) throw new Error("Nicht vertrauenswürdiger Renderer.");
  if (!community) throw new Error("Die Konto-API wird noch gestartet.");
  return community.getFeed(cursor === undefined ? null : cursor);
});
ipcMain.handle("clipfarm:clips:mine", async (event, cursor) => {
  if (!isTrustedRenderer(event)) throw new Error("Nicht vertrauenswürdiger Renderer.");
  if (!community) throw new Error("Clipfarm wird noch gestartet.");
  return community.getMyClips(cursor === undefined ? null : cursor);
});
ipcMain.handle("clipfarm:profile:get", async (event) => {
  if (!isTrustedRenderer(event)) throw new Error("Nicht vertrauenswürdiger Renderer.");
  if (!community) throw new Error("Clipfarm wird noch gestartet.");
  return community.getProfile();
});
ipcMain.handle("clipfarm:profile:update", async (event, profile) => {
  if (!isTrustedRenderer(event)) throw new Error("Nicht vertrauenswürdiger Renderer.");
  if (!community) throw new Error("Clipfarm wird noch gestartet.");
  return community.updateProfile(profile);
});
ipcMain.handle("clipfarm:profile:password", async (event, currentPassword, newPassword) => {
  if (!isTrustedRenderer(event)) throw new Error("Nicht vertrauenswürdiger Renderer.");
  if (!community) throw new Error("Clipfarm wird noch gestartet.");
  return community.changePassword(currentPassword, newPassword);
});
ipcMain.handle("clipfarm:clip:save", async (event) => {
  if (!isTrustedRenderer(event)) throw new Error("Nicht vertrauenswürdiger Renderer.");
  return saveReplay();
});
ipcMain.handle("clipfarm:upload:list", (event) => {
  if (!isTrustedRenderer(event)) throw new Error("Nicht vertrauenswürdiger Renderer.");
  return community ? community.getUploads() : [];
});
ipcMain.handle("clipfarm:upload:queue", async (event, clip) => {
  if (!isTrustedRenderer(event)) throw new Error("Nicht vertrauenswürdiger Renderer.");
  if (!community) throw new Error("Die Upload-Warteschlange wird noch gestartet.");
  return community.queueClip(clip, true);
});
ipcMain.handle("clipfarm:upload:retry", async (event, id) => {
  if (!isTrustedRenderer(event)) throw new Error("Nicht vertrauenswürdiger Renderer.");
  if (!community) throw new Error("Die Upload-Warteschlange wird noch gestartet.");
  return community.retryUpload(id);
});
ipcMain.handle("clipfarm:clip-outcome", (event, result) => {
  if (!isTrustedRenderer(event)) throw new Error("Nicht vertrauenswürdiger Renderer.");
  if (!result || !["success", "failed", "saving", "test"].includes(result.outcome)) return false;
  showClipOutcomeOverlay({ outcome: result.outcome, message: String(result.message || "").slice(0, 180) });
  return true;
});
ipcMain.handle("clipfarm:game-icon", async (event, requestedProcessId) => {
  if (!isTrustedRenderer(event)) throw new Error("Nicht vertrauenswürdiger Renderer.");
  const processId = Number(requestedProcessId);
  if (!Number.isSafeInteger(processId) || processId <= 0) return null;
  if (gameIconProcessId === processId && gameIconDataUrl) return gameIconDataUrl;
  try {
    const session = await api("/api/session");
    if (Number(session.processId) !== processId) return null;
    const command = `$target=Get-Process -Id ${processId} -ErrorAction Stop; if($target.Path){[Console]::WriteLine($target.Path)}`;
    const executablePath = await new Promise((resolve) => {
      execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { windowsHide: true, timeout: 4000 }, (error, stdout) => {
        resolve(!error ? String(stdout || "").trim() : "");
      });
    });
    const iconPath = executablePath && path.isAbsolute(executablePath) && fs.existsSync(executablePath)
      ? executablePath
      : findInstalledGameExecutable(session);
    const icon = iconPath
      ? await app.getFileIcon(iconPath, { size: "large" })
      : nativeImage.createEmpty();
    gameIconProcessId = processId;
    gameIconDataUrl = icon.isEmpty() ? null : icon.toDataURL();
    return gameIconDataUrl;
  } catch {
    return null;
  }
});

async function startClipfarm() {
  if (!startedHidden && !splashWindow) createSplashWindow();
  prepareUserData();
  localHost = require("./server.js");
  const port = await localHost.startServer(0);
  baseUrl = `http://127.0.0.1:${port}`;
  await clearLegacyOfflineClipsOnce();
  community = new CommunityService({
    safeStorage,
    sessionPath: sessionStorePath,
    profileCachePath: path.join(app.getPath("userData"), "profile-cache.json"),
    stagingDirectory: pendingUploadDirectory,
    getClipDirectory: async () => {
      const config = await api("/api/config");
      if (!config.config || typeof config.config.clipDirectory !== "string") throw new Error("Der lokale Clip-Ordner ist nicht verfügbar.");
      return config.config.clipDirectory;
    }
  });
  community.on("upload-update", (update) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send("clipfarm:upload:update", update);
    }
  });
  community.on("account", (user) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send("clipfarm:account:update", user);
    }
  });
  community.on("upload-committed", (result) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send("clipfarm:upload:committed", result);
    }
    if (result.cleanupWarning) notify("Clipfarm-Upload", result.cleanupWarning);
    else notify("Clipfarm", "Dein Clip ist im Feed angekommen.");
  });
  await community.initialize();
  createClipOverlayWindow();

  const settings = await api("/api/config");
  const shortcutState = registerGlobalHotkeys(settings.config.hotkeys);
  if (shortcutState.failed.length) {
    startupError = `Diese globalen Hotkeys sind bereits belegt und konnten nicht aktiviert werden: ${shortcutState.failed.join(", ")}`;
  }

  if (process.env.CLIPFARM_START_REPLAY !== "0") {
    try {
      await api("/api/engine/start", { method: "POST" });
    } catch (error) {
      startupError = [startupError, `Replay konnte nicht automatisch starten: ${error.message}`].filter(Boolean).join("\n");
    }
  }

  createTray();
  if (!startedHidden) createMainWindow();
}

async function stopClipfarm() {
  globalShortcut.unregisterAll();
  if (tray) {
    tray.destroy();
    tray = null;
  }
  clearTimeout(clipOverlayHideTimer);
  if (clipOverlayWindow && !clipOverlayWindow.isDestroyed()) clipOverlayWindow.destroy();
  clipOverlayWindow = null;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
  if (localHost) await localHost.shutdown();
}

if (hasSingleInstance) {
  app.on("second-instance", openMainWindow);
  app.whenReady().then(async () => {
    ensureDefaultAutostart();
    await startClipfarm();
    startUpdateMonitor();
  }).catch(async (error) => {
    dialog.showErrorBox("clipfarm konnte nicht gestartet werden", error.message);
    await stopClipfarm().catch(() => {});
    app.quit();
  });
  app.on("activate", openMainWindow);
  app.on("before-quit", (event) => {
    if (closing) return;
    event.preventDefault();
    if (shutdownPromise) return;
    closing = true;
    clearInterval(updateMonitorTimer);
    shutdownPromise = stopClipfarm().finally(() => app.quit());
  });
}
