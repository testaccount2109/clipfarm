const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const root = __dirname;
const port = Number(process.env.CLIPFARM_PORT || 4174);
const dataDirectory = path.resolve(process.env.SPOOL_DATA_DIR || root);
const captureRuntimeDirectory = path.join(process.env.LOCALAPPDATA || (process.env.SPOOL_DATA_DIR ? dataDirectory : os.tmpdir()), "Clipfarm", "capture-runtime");
const stagingDirectory = path.resolve(process.env.CLIPFARM_STAGING_DIR || path.join(dataDirectory, "pending-uploads"));
const audioControlPort = Number(process.env.CLIPFARM_AUDIO_CONTROL_PORT || 0);
const CLIP_POSTROLL_SECONDS = 2;
const SEGMENT_DURATION_SECONDS = 0.5;
const CLIP_BUFFER_MARGIN_SECONDS = 15;
const CAPTURE_STARTUP_TIMEOUT_MS = 15000;
const CAPTURE_HEALTH_CHECK_INTERVAL_MS = 2000;
const CAPTURE_STALE_OUTPUT_TIMEOUT_MS = 10000;
const logicalProcessors = Math.max(1, os.cpus().length);
let previousCpu = process.cpuUsage();
let previousTime = process.hrtime.bigint();
let gameCache = { game: null, process: null, captureMethod: "waiting" };
let gameCacheAt = 0;
let gameDetectionPromise = null;
let bufferDirectory = process.env.CLIPFARM_BUFFER || path.join(os.tmpdir(), "clipfarm-buffer");
let clipDirectory = process.env.CLIPFARM_CLIPS || path.join(dataDirectory, "clips");
const logDirectory = path.join(dataDirectory, "logs");
const logFile = path.join(logDirectory, "clipfarm.log");
const configFile = path.join(dataDirectory, "engine-config.json");
const allowedReplayLengths = [15, 30, 60, 120];
const allowedResolutions = ["1920x1080", "2560x1440", "3840x2160"];
const allowedFps = [60, 120];
const allowedBitrates = ["18M", "28M", "45M"];
const allowedEncoders = ["hevc_amf", "h264_amf"];
const allowedQualities = ["performance", "balanced", "quality"];
const allowedCaptureMethods = ["auto", "display", "game", "window"];
const hotkeyNames = ["save", "toggle", "microphone"];
const hotkeyPattern = /^(?:(?:CTRL|ALT|SHIFT|WIN)\+){0,3}(?:F(?:[1-9]|1[0-2])|[A-Z]|[0-9])$/;
const defaultEngineConfig = {
  replayLength: 30,
  resolution: "1920x1080",
  fps: 60,
  bitrate: "28M",
  encoder: "hevc_amf",
  quality: "balanced",
  captureMethod: "display",
  hotkeys: { save: "F8", toggle: "F9", microphone: "F10" },
  microphoneDevice: null,
  microphoneVolume: 100,
  gameAudio: true,
  audioCaptureVersion: 1,
  separateTracks: false,
  clipDirectory,
  bufferDirectory,
  maxStorageGb: 50,
  cleanupPolicy: "limit",
  backgroundPriority: false,
  capturePriorityVersion: 1
};

function loadEngineConfig() {
  try {
    return normalizeEngineConfig(JSON.parse(fs.readFileSync(configFile, "utf8")));
  } catch {
    return { ...defaultEngineConfig };
  }
}

function saveEngineConfig() {
  fs.writeFileSync(configFile, `${JSON.stringify(engineConfig, null, 2)}\n`, "utf8");
}

function normalizeEngineConfig(input = {}) {
  const next = { ...defaultEngineConfig, ...input };
  const migrateCapturePriority = Number(input.capturePriorityVersion || 0) < 1;
  const useSystemAudio = Object.prototype.hasOwnProperty.call(input, "audioCaptureVersion") ? Boolean(next.gameAudio) : true;
  const hotkeys = { ...defaultEngineConfig.hotkeys, ...(input.hotkeys || {}) };
  if (!allowedReplayLengths.includes(Number(next.replayLength))) throw new Error("Replay-Länge muss 15, 30, 60 oder 120 Sekunden sein");
  if (!allowedResolutions.includes(String(next.resolution))) throw new Error("Auflösung wird nicht unterstützt");
  if (!allowedFps.includes(Number(next.fps))) throw new Error("FPS muss 60 oder 120 sein");
  if (!allowedBitrates.includes(String(next.bitrate))) throw new Error("Bitrate wird nicht unterstützt");
  if (!allowedEncoders.includes(String(next.encoder))) throw new Error("Nur AMD AMF Hardware-Encoding ist verfügbar");
  if (!allowedQualities.includes(String(next.quality))) throw new Error("Qualitäts-Preset wird nicht unterstützt");
  if (!allowedCaptureMethods.includes(String(next.captureMethod))) throw new Error("Capture-Methode wird nicht unterstützt");
  if (next.microphoneDevice !== null && next.microphoneDevice !== undefined && String(next.microphoneDevice).length > 240) throw new Error("Mikrofonname ist zu lang");
  if (![0, 25, 50, 75, 100, 125].includes(Number(next.microphoneVolume))) throw new Error("Mikrofonlautstärke wird nicht unterstützt");
  if (!path.isAbsolute(String(next.clipDirectory)) || !path.isAbsolute(String(next.bufferDirectory))) throw new Error("Clip- und Pufferordner müssen absolute Windows-Pfade sein");
  if (![10, 50, 100].includes(Number(next.maxStorageGb))) throw new Error("Speicherlimit wird nicht unterstützt");
  if (!["limit", "never"].includes(String(next.cleanupPolicy))) throw new Error("Bereinigungsregel wird nicht unterstützt");
  for (const name of hotkeyNames) {
    const value = String(hotkeys[name] || "").toUpperCase();
    if (!hotkeyPattern.test(value)) throw new Error(`Ungültiger Hotkey für ${name}`);
    hotkeys[name] = value;
  }
  return {
    replayLength: Number(next.replayLength),
    resolution: String(next.resolution),
    fps: Number(next.fps),
    bitrate: String(next.bitrate),
    encoder: String(next.encoder),
    quality: String(next.quality),
    captureMethod: String(next.captureMethod),
    hotkeys,
    microphoneDevice: next.microphoneDevice ? String(next.microphoneDevice) : null,
    microphoneVolume: Number(next.microphoneVolume),
    gameAudio: useSystemAudio,
    audioCaptureVersion: 1,
    separateTracks: Boolean(next.separateTracks),
    clipDirectory: path.resolve(String(next.clipDirectory)),
    bufferDirectory: path.resolve(String(next.bufferDirectory)),
    maxStorageGb: Number(next.maxStorageGb),
    cleanupPolicy: String(next.cleanupPolicy),
    backgroundPriority: migrateCapturePriority ? false : Boolean(next.backgroundPriority),
    capturePriorityVersion: 1
  };
}

let engineConfig = loadEngineConfig();
bufferDirectory = engineConfig.bufferDirectory;
clipDirectory = engineConfig.clipDirectory;
try { saveEngineConfig(); } catch { /* settings remain in memory if the file is temporarily unavailable */ }
let captureProcess = null;
let captureState = { state: "stopped", pid: null, encoder: null, captureMethod: "display", error: null, bufferDirectory, micEnabled: true, audioControlPort, microphoneLiveControl: false, config: engineConfig };
let engineWorkingSetBytes = 0;
let engineCpuPercent = null;
let previousEngineCpu = null;
let ffmpegRuntimePromise = null;
const encoderProbeCache = new Map();
let gpuPercent = null;
let gpuAvailable = false;
let gpuSource = "Windows GPU Engine counter";
let gpuSampleInFlight = false;
let restartAttempts = 0;
let restartTimer = null;
let minimizedRetryTimer = null;
let captureHealthTimer = null;
let captureRequested = false;
let shuttingDown = false;
let audioDevices = [];
let audioDevicesAt = 0;
let audioDiscoveryPromise = null;
let audioDiscoveryError = null;
let audioHelperProcess = null;
let audioPipeServers = [];
let audioPipeSockets = [];
let audioHelperReady = false;
let clipsCache = [];
let clipsCacheSignature = "";
let clipSaveInFlight = null;
let completedSegmentCache = [];
let completedSegmentCacheDirectory = bufferDirectory;

const knownGames = [
  { game: "Counter-Strike 2", processes: ["cs2.exe", "csgo.exe"] },
  { game: "Minecraft", processes: ["minecraft.windows.exe"] },
  { game: "Fortnite", processes: ["fortniteclient-win64-shipping.exe"] },
  { game: "VALORANT", processes: ["valorant-win64-shipping.exe"] },
  { game: "Apex Legends", processes: ["r5apex.exe"] },
  { game: "Overwatch 2", processes: ["overwatch.exe"] },
  { game: "Call of Duty", processes: ["cod.exe", "modernwarfare.exe"] },
  { game: "Rainbow Six Siege", processes: ["rainbowsix.exe"] },
  { game: "PUBG: Battlegrounds", processes: ["tslgame.exe"] },
  { game: "Rocket League", processes: ["rocketleague.exe"] },
  { game: "Grand Theft Auto V", processes: ["gta5.exe", "gta5_enhanced.exe"] },
  { game: "Rust", processes: ["rustclient.exe"] },
  { game: "Roblox", processes: ["robloxplayerbeta.exe"] },
  { game: "League of Legends", processes: ["league of legends.exe"] },
  { game: "Dota 2", processes: ["dota2.exe"] },
  { game: "Forza Horizon 5", processes: ["forzahorizon5.exe"] },
  { game: "Warframe", processes: ["warframe.x64.exe"] },
  { game: "Cyberpunk 2077", processes: ["cyberpunk2077.exe"] },
  { game: "Elden Ring", processes: ["eldenring.exe"] },
  { game: "Terraria", processes: ["terraria.exe"] }
];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".mp3": "audio/mpeg"
};

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function logEvent(level, message, details = {}) {
  try {
    fs.mkdirSync(logDirectory, { recursive: true });
    fs.appendFileSync(logFile, `${JSON.stringify({ time: new Date().toISOString(), level, message, ...details })}\n`, "utf8");
  } catch { /* logging must never take down the capture host */ }
}

function readProcessMetrics() {
  const now = process.hrtime.bigint();
  const cpu = process.cpuUsage(previousCpu);
  const elapsedMicros = Number(now - previousTime) / 1000;
  const consumedMicros = cpu.user + cpu.system;
  previousCpu = process.cpuUsage();
  previousTime = now;

  return {
    cpuPercent: elapsedMicros > 0 ? round((consumedMicros / elapsedMicros) * 100 / logicalProcessors, 2) : null,
    hostCpuPercent: elapsedMicros > 0 ? round((consumedMicros / elapsedMicros) * 100 / logicalProcessors, 2) : null,
    engineCpuPercent,
    ramBytes: process.memoryUsage().rss + engineWorkingSetBytes,
    hostRamBytes: process.memoryUsage().rss,
    engineRamBytes: engineWorkingSetBytes,
    gpuPercent,
    gpuAvailable,
    gpuSource,
    logicalProcessors,
    sampledAt: new Date().toISOString()
  };
}

function sampleEngineMemory() {
  const pids = [captureProcess?.pid, audioHelperProcess?.pid].filter((pid) => Number.isInteger(pid));
  if (!pids.length) { engineWorkingSetBytes = 0; engineCpuPercent = null; previousEngineCpu = null; return; }
  const pidKey = pids.slice().sort((left, right) => left - right).join(",");
  const command = `$ids=@(${pidKey}); $p=Get-Process -Id $ids -ErrorAction SilentlyContinue; $memory=($p | Measure-Object -Property WorkingSet64 -Sum).Sum; $cpu=($p | Measure-Object -Property CPU -Sum).Sum; [Console]::WriteLine([string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0}|{1}', $memory, $cpu))`;
  execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { windowsHide: true, timeout: 3000 }, (error, stdout) => {
    if (error) return;
    const [workingSetBytes, cpuSeconds] = String(stdout).trim().split("|").map(Number);
    if (!Number.isFinite(workingSetBytes) || !Number.isFinite(cpuSeconds)) return;
    engineWorkingSetBytes = workingSetBytes;
    const sampledAt = process.hrtime.bigint();
    if (previousEngineCpu?.pidKey === pidKey) {
      const elapsedSeconds = Number(sampledAt - previousEngineCpu.sampledAt) / 1e9;
      if (elapsedSeconds > 0) engineCpuPercent = round(Math.max(0, (cpuSeconds - previousEngineCpu.cpuSeconds) / elapsedSeconds * 100 / logicalProcessors), 2);
    }
    previousEngineCpu = { pidKey, cpuSeconds, sampledAt };
  });
}

function applyCapturePriority(pid) {
  if (!engineConfig.backgroundPriority) return;
  execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `$process=Get-Process -Id ${pid} -ErrorAction Stop; $process.PriorityClass='BelowNormal'`], { windowsHide: true, timeout: 3000 }, (error) => {
    if (error) logEvent("warn", "capture priority could not be lowered", { pid, error: error.message });
    else logEvent("info", "capture process priority lowered", { pid, priority: "BelowNormal" });
  });
}

function sampleGpuMetrics() {
  const pid = captureProcess?.pid;
  if (!pid || gpuSampleInFlight) {
    if (!pid) { gpuPercent = null; gpuAvailable = false; }
    return;
  }
  gpuSampleInFlight = true;
  const command = `$targetPid=${pid}; $samples=(Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -SampleInterval 1 -MaxSamples 1).CounterSamples; $sum=($samples | Where-Object { $_.Path -match "pid_${pid}_" } | Measure-Object -Property CookedValue -Sum).Sum; if ($null -eq $sum) { [Console]::WriteLine('n/a') } else { [Console]::WriteLine(([Math]::Min(100, [Math]::Max(0, $sum))).ToString([Globalization.CultureInfo]::InvariantCulture)) }`;
  execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { windowsHide: true, timeout: 15000 }, (error, stdout) => {
    gpuSampleInFlight = false;
    if (captureProcess?.pid !== pid) return;
    const value = Number(String(stdout || "").trim());
    if (!error && Number.isFinite(value)) { gpuPercent = round(value, 2); gpuAvailable = true; gpuSource = "Windows GPU Engine counter"; }
    else { gpuPercent = null; gpuAvailable = false; gpuSource = "Windows GPU Engine counter unavailable"; }
  });
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function detectGame() {
  const now = Date.now();
  if (now - gameCacheAt < 5000) return Promise.resolve(gameCache);
  if (gameDetectionPromise) return gameDetectionPromise;

  gameDetectionPromise = new Promise((resolve) => {
    const finish = (result) => {
      gameCache = result;
      gameCacheAt = Date.now();
      gameDetectionPromise = null;
      resolve(gameCache);
    };
    const parseRows = (output) => String(output).split(/\r?\n/).flatMap((line) => {
      const fields = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => match[1].replace(/""/g, '"'));
      const processId = Number(fields[1]);
      return fields.length >= 2 && Number.isSafeInteger(processId) && processId > 0
        ? [{ name: fields[0].toLowerCase(), processId, title: (fields[8] || "").trim() }]
        : [];
    });
    execFile("tasklist.exe", ["/FO", "CSV", "/NH"], { windowsHide: true, timeout: 3000 }, (error, stdout) => {
      if (error) {
        finish({ game: null, process: null, captureMethod: "waiting", error: error.killed ? "tasklist timed out" : `tasklist failed: ${error.code || error.message}` });
        return;
      }
      const processRows = parseRows(stdout);
      let match = knownGames.find((candidate) => candidate.processes.some((name) => processRows.some((row) => row.name === name)));
      if (match) {
        const processRow = processRows.find((row) => match.processes.includes(row.name));
        finish({ game: match.game, process: processRow.name, processId: processRow.processId, windowTitle: processRow.title, captureMethod: "game" });
        return;
      }
      if (!processRows.some((row) => row.name === "javaw.exe")) {
        finish({ game: null, process: null, captureMethod: "waiting" });
        return;
      }
      execFile("tasklist.exe", ["/V", "/FI", "IMAGENAME eq javaw.exe", "/FO", "CSV", "/NH"], { windowsHide: true, timeout: 3000 }, (titleError, titleOutput) => {
        const javaGame = !titleError && parseRows(titleOutput).find((row) => row.name === "javaw.exe" && /minecraft|fabric|forge/i.test(row.title));
        finish(javaGame
          ? { game: "Minecraft", process: "javaw.exe", processId: javaGame.processId, windowTitle: javaGame.title, captureMethod: "game" }
          : { game: null, process: null, captureMethod: "waiting" });
      });
    });
  });
  return gameDetectionPromise;
}

function getMainWindowState(processId) {
  const targetId = Number(processId);
  if (!Number.isSafeInteger(targetId) || targetId <= 0) return Promise.resolve(null);
  const nativeMethods = 'using System; using System.Runtime.InteropServices; public static class ClipfarmWindowState { [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd); }';
  const command = "$target = Get-Process -Id " + targetId + " -ErrorAction Stop; $target.Refresh(); $handle = $target.MainWindowHandle; if ($handle -eq [IntPtr]::Zero) { exit 2 }; Add-Type -TypeDefinition '" + nativeMethods + "'; $minimized = [ClipfarmWindowState]::IsIconic($handle); $visible = [ClipfarmWindowState]::IsWindowVisible($handle); [Console]::Out.WriteLine($handle.ToInt64().ToString([Globalization.CultureInfo]::InvariantCulture) + '|' + $minimized + '|' + $visible)";
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      const match = String(stdout || "").trim().match(/^(\d+)\|(True|False)\|(True|False)$/i);
      const handle = Number(match?.[1]);
      resolve(!error && Number.isSafeInteger(handle) && handle > 0 ? {
        handle,
        minimized: match[2].toLowerCase() === "true",
        visible: match[3].toLowerCase() === "true"
      } : null);
    });
  });
}

function findFfmpeg() {
  if (process.env.CLIPFARM_FFMPEG && fs.existsSync(process.env.CLIPFARM_FFMPEG)) return process.env.CLIPFARM_FFMPEG;
  const bundled = path.join(root, "tools", "ffmpeg.exe");
  if (fs.existsSync(bundled)) return bundled;
  const managed = path.join(captureRuntimeDirectory, "ffmpeg", "bin", "ffmpeg.exe");
  if (fs.existsSync(managed)) return managed;
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const packageRoot = path.join(localAppData, "Microsoft", "WinGet", "Packages");
    if (fs.existsSync(packageRoot)) {
      for (const packageName of fs.readdirSync(packageRoot)) {
        if (!packageName.toLowerCase().includes("ffmpeg")) continue;
        const candidateRoot = path.join(packageRoot, packageName);
        const candidate = findFile(candidateRoot, "ffmpeg.exe", 4);
        if (candidate) return candidate;
      }
    }
  }
  return "ffmpeg.exe";
}

function findFfprobe() {
  const ffmpeg = findFfmpeg();
  const sibling = path.join(path.dirname(ffmpeg), "ffprobe.exe");
  return fs.existsSync(sibling) ? sibling : "ffprobe.exe";
}

function findAudioHelper() {
  const configured = process.env.CLIPFARM_AUDIO_HELPER;
  if (configured && fs.existsSync(configured)) return configured;
  const bundled = path.join(root, "tools", "clipfarm-audio.exe");
  return fs.existsSync(bundled) ? bundled : null;
}

function discoverAudioDevices() {
  const now = Date.now();
  if (now - audioDevicesAt < 30000) return Promise.resolve(audioDevices);
  if (audioDiscoveryPromise) return audioDiscoveryPromise;
  const helper = findAudioHelper();
  if (!helper) {
    audioDevices = [];
    audioDiscoveryError = "Die integrierte Windows-Audioaufnahme fehlt.";
    audioDevicesAt = now;
    return Promise.resolve(audioDevices);
  }
  audioDiscoveryPromise = new Promise((resolve) => {
    execFile(helper, ["--list-microphones"], { windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      try {
        if (error) throw new Error(String(stderr || error.message).trim());
        const payload = JSON.parse(stdout);
        audioDevices = Array.isArray(payload.devices) ? payload.devices.filter((device) => device?.id && device?.name) : [];
        audioDiscoveryError = null;
        audioDevices.default = payload.default || null;
      } catch (discoveryError) {
        audioDevices = [];
        audioDiscoveryError = String(discoveryError.message || "Windows-Audiogeräte konnten nicht gelesen werden").slice(0, 240);
      }
      audioDevicesAt = Date.now();
      audioDiscoveryPromise = null;
      resolve(audioDevices);
    });
  });
  return audioDiscoveryPromise;
}

function findFile(directory, filename, depth) {
  if (depth < 0 || !fs.existsSync(directory)) return null;
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) return candidate;
    if (entry.isDirectory()) {
      const found = findFile(candidate, filename, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

function runCaptureTool(file, args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message || "Das Aufnahmeprogramm konnte nicht gestartet werden.").trim().slice(-1200)));
        return;
      }
      resolve(`${stdout || ""}\n${stderr || ""}`);
    });
  });
}

async function inspectFfmpeg(ffmpeg) {
  const [filters, encoders, formats] = await Promise.all([
    runCaptureTool(ffmpeg, ["-hide_banner", "-filters"]),
    runCaptureTool(ffmpeg, ["-hide_banner", "-encoders"]),
    runCaptureTool(ffmpeg, ["-hide_banner", "-muxers"])
  ]);
  const missing = [];
  if (!/\bgfxcapture\b/i.test(filters)) missing.push("gfxcapture (Windows-Bildschirmaufnahme)");
  if (!/\blibx264\b/i.test(encoders)) missing.push("libx264 (CPU-Notfall-Encoder)");
  if (!/\baac\b/i.test(encoders)) missing.push("AAC-Audioencoder");
  if (!/\bmp4\b/i.test(formats)) missing.push("MP4-Ausgabeformat");
  const ffprobe = path.join(path.dirname(ffmpeg), "ffprobe.exe");
  try {
    await runCaptureTool(fs.existsSync(ffprobe) ? ffprobe : "ffprobe.exe", ["-version"]);
  } catch {
    missing.push("FFprobe");
  }
  if (missing.length) throw new Error(`FFmpeg kann Clipfarm-Aufnahmen nicht erstellen. Es fehlen: ${missing.join(", ")}.`);
  return { ffmpeg, encoders };
}

function openFfmpegDownload(address, redirects = 0) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(address); }
    catch { reject(new Error("Die FFmpeg-Downloadadresse ist ungültig.")); return; }
    if (url.protocol !== "https:" || url.port || !["www.gyan.dev", "gyan.dev"].includes(url.hostname)) {
      reject(new Error("Der FFmpeg-Download wurde aus Sicherheitsgründen abgebrochen: nicht vertrauenswürdiger Download-Server."));
      return;
    }
    const request = https.get(url, { headers: { "User-Agent": "Clipfarm-Capture-Setup/1.0", Accept: "application/octet-stream, text/plain" } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirects >= 5) { reject(new Error("Der FFmpeg-Download enthält zu viele Weiterleitungen.")); return; }
        const next = new URL(response.headers.location, url).href;
        openFfmpegDownload(next, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Der FFmpeg-Server antwortet mit HTTP ${response.statusCode || "?"}.`));
        return;
      }
      resolve({ response, finalUrl: url.href });
    });
    request.setTimeout(60000, () => request.destroy(new Error("Zeitüberschreitung beim Verbinden mit dem FFmpeg-Server.")));
    request.once("error", reject);
  });
}

async function readFfmpegChecksum(address) {
  const { response } = await openFfmpegDownload(address);
  let body = "";
  for await (const chunk of response) {
    body += chunk.toString("utf8");
    if (body.length > 4096) throw new Error("Die FFmpeg-Prüfsumme ist ungültig.");
  }
  const match = body.trim().match(/^([a-f0-9]{64})(?:\s|$)/i);
  if (!match) throw new Error("Der FFmpeg-Server hat keine gültige SHA-256-Prüfsumme geliefert.");
  return match[1].toLowerCase();
}

async function downloadFfmpegArchive(address, destination) {
  const { response, finalUrl } = await openFfmpegDownload(address);
  const declaredSize = Number(response.headers["content-length"] || 0);
  const maximumSize = 300 * 1024 * 1024;
  if (declaredSize > maximumSize) {
    response.once("error", () => {});
    response.destroy();
    throw new Error("Das FFmpeg-Archiv ist unerwartet groß.");
  }
  let downloadedSize = 0;
  try {
    await pipeline(
      response,
      new Transform({ transform(chunk, _encoding, callback) {
        downloadedSize += chunk.length;
        if (downloadedSize > maximumSize) { callback(new Error("Das FFmpeg-Archiv überschreitet die erlaubte Größe.")); return; }
        callback(null, chunk);
      } }),
      fs.createWriteStream(destination, { flags: "wx" })
    );
  } catch (error) {
    await fs.promises.rm(destination, { force: true }).catch(() => {});
    throw error;
  }
  return finalUrl;
}

async function installFfmpegRuntime() {
  const runtimeParent = captureRuntimeDirectory;
  const staging = path.join(runtimeParent, `.install-${process.pid}-${Date.now()}`);
  const archive = path.join(staging, "ffmpeg.zip");
  const unpacked = path.join(staging, "unpacked");
  const target = path.join(runtimeParent, "ffmpeg");
  const backup = path.join(runtimeParent, `.previous-${process.pid}-${Date.now()}`);
  await fs.promises.mkdir(staging, { recursive: true });
  logEvent("info", "downloading required FFmpeg capture runtime", { source: "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" });
  try {
    const archiveUrl = await downloadFfmpegArchive("https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip", archive);
    const expectedHash = await readFfmpegChecksum(`${archiveUrl}.sha256`);
    const actualHash = await new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      const input = fs.createReadStream(archive);
      input.on("error", reject);
      input.on("data", (chunk) => hash.update(chunk));
      input.on("end", () => resolve(hash.digest("hex")));
    });
    if (actualHash !== expectedHash) throw new Error("Die SHA-256-Prüfung des FFmpeg-Downloads ist fehlgeschlagen. Die Datei wurde nicht installiert.");

    await fs.promises.mkdir(unpacked, { recursive: true });
    const extractScript = "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:CLIPFARM_FFMPEG_ARCHIVE -DestinationPath $env:CLIPFARM_FFMPEG_STAGE -Force";
    await new Promise((resolve, reject) => {
      const encodedScript = Buffer.from(extractScript, "utf16le").toString("base64");
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedScript], {
        windowsHide: true,
        timeout: 300000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, CLIPFARM_FFMPEG_ARCHIVE: archive, CLIPFARM_FFMPEG_STAGE: unpacked }
      }, (error, _stdout, stderr) => error
        ? reject(new Error(String(stderr || error.message || "FFmpeg konnte nicht entpackt werden.").trim().slice(-1200)))
        : resolve());
    });

    const stagedExecutable = findFile(unpacked, "ffmpeg.exe", 6);
    const stagedProbe = stagedExecutable && path.join(path.dirname(stagedExecutable), "ffprobe.exe");
    if (!stagedExecutable || !stagedProbe || !fs.existsSync(stagedProbe)) throw new Error("Im heruntergeladenen FFmpeg-Paket fehlen ffmpeg.exe oder ffprobe.exe.");
    await inspectFfmpeg(stagedExecutable);
    const packageDirectory = path.dirname(path.dirname(stagedExecutable));

    let hadPrevious = false;
    try { await fs.promises.rename(target, backup); hadPrevious = true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    try { await fs.promises.rename(packageDirectory, target); }
    catch (error) {
      if (hadPrevious) await fs.promises.rename(backup, target).catch(() => {});
      throw error;
    }
    if (hadPrevious) await fs.promises.rm(backup, { recursive: true, force: true });
    const installed = path.join(target, "bin", "ffmpeg.exe");
    await inspectFfmpeg(installed);
    logEvent("info", "FFmpeg capture runtime installed", { ffmpeg: installed, sha256: actualHash });
    return installed;
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

function ensureFfmpegRuntime() {
  if (!ffmpegRuntimePromise) {
    ffmpegRuntimePromise = (async () => {
      const candidate = findFfmpeg();
      try {
        const details = await inspectFfmpeg(candidate);
        process.env.CLIPFARM_FFMPEG = candidate;
        logEvent("info", "FFmpeg capture requirements verified", { ffmpeg: candidate });
        return details;
      } catch (error) {
        logEvent("warn", "installed FFmpeg is missing capture requirements", { ffmpeg: candidate, error: error.message });
      }
      try {
        const installed = await installFfmpegRuntime();
        const details = await inspectFfmpeg(installed);
        process.env.CLIPFARM_FFMPEG = installed;
        return details;
      } catch (error) {
        throw new Error(`FFmpeg fehlt oder ist nicht für Clipfarm geeignet. Clipfarm versucht die passende Version automatisch zu installieren, konnte das aber nicht abschließen. Prüfe die Internetverbindung und starte Clipfarm erneut. Details: ${error.message}`);
      }
    })().catch((error) => {
      ffmpegRuntimePromise = null;
      throw error;
    });
  }
  return ffmpegRuntimePromise;
}

async function canUseVideoEncoder(ffmpeg, encoder) {
  const cacheKey = `${ffmpeg}\n${encoder}`;
  if (encoderProbeCache.has(cacheKey)) return encoderProbeCache.get(cacheKey);
  const args = ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=1", "-frames:v", "1"];
  if (encoder === "libx264") args.push("-c:v", encoder, "-preset", "ultrafast", "-tune", "zerolatency");
  else args.push("-vf", "format=nv12", "-c:v", encoder, "-usage", "lowlatency", "-quality", "balanced");
  args.push("-f", "null", "-");
  const probe = runCaptureTool(ffmpeg, args, 15000).then(() => true, () => false);
  encoderProbeCache.set(cacheKey, probe);
  const available = await probe;
  encoderProbeCache.set(cacheKey, available);
  return available;
}

async function selectVideoEncoder(ffmpeg, availableEncoders) {
  const candidates = engineConfig.encoder === "hevc_amf"
    ? ["hevc_amf", "h264_amf", "libx264"]
    : ["h264_amf", "libx264"];
  for (const encoder of candidates) {
    if (encoder !== "libx264" && !new RegExp(`\\b${encoder}\\b`, "i").test(availableEncoders)) continue;
    if (await canUseVideoEncoder(ffmpeg, encoder)) {
      if (encoder !== engineConfig.encoder) {
        logEvent("warn", "configured video encoder unavailable; using compatible fallback", { configured: engineConfig.encoder, selected: encoder });
      }
      return encoder;
    }
  }
  throw new Error("Weder AMD AMF noch der CPU-Encoder libx264 konnten gestartet werden. Aktualisiere den Grafiktreiber und starte Clipfarm erneut.");
}

function ringSegmentCount() {
  return Math.ceil((engineConfig.replayLength + CLIP_POSTROLL_SECONDS + CLIP_BUFFER_MARGIN_SECONDS) / SEGMENT_DURATION_SECONDS);
}

function getCaptureState() {
  const bufferSeconds = Math.round(Math.min(engineConfig.replayLength, listSegments().length * SEGMENT_DURATION_SECONDS) * 10) / 10;
  return {
    ...captureState,
    config: engineConfig,
    ffmpeg: findFfmpeg(),
    segmentCount: ringSegmentCount(),
    postRollSeconds: CLIP_POSTROLL_SECONDS,
    bufferSeconds,
    bufferReady: bufferSeconds >= engineConfig.replayLength,
    autoStartPending: Boolean(captureRequested && (minimizedRetryTimer || (captureState.state === "error" && /ist minimiert/i.test(captureState.error || "")))),
    audioControlPort,
    audioHelperReady,
    audioDiscoveryError
  };
}

function createAudioPipe(childFd) {
  return new Promise((resolve, reject) => {
    const pipeServer = net.createServer((socket) => {
      const destination = captureProcess?.stdio?.[childFd];
      if (!destination || destination.destroyed) { socket.destroy(); return; }
      socket.setNoDelay(true);
      audioPipeSockets.push(socket);
      socket.once("close", () => { audioPipeSockets = audioPipeSockets.filter((item) => item !== socket); });
      socket.on("error", () => {});
      destination.on("error", () => socket.destroy());
      socket.pipe(destination);
    });
    pipeServer.once("error", reject);
    pipeServer.listen(0, "127.0.0.1", () => {
      pipeServer.removeListener("error", reject);
      audioPipeServers.push(pipeServer);
      resolve(pipeServer.address().port);
    });
  });
}

function closeAudioPipeline() {
  const helper = audioHelperProcess;
  audioHelperProcess = null;
  audioHelperReady = false;
  if (helper && !helper.killed && helper.exitCode === null) {
    if (helper.stdin?.writable) helper.stdin.end();
    const forceStop = setTimeout(() => { if (helper.exitCode === null) helper.kill(); }, 1000);
    helper.once("exit", () => clearTimeout(forceStop));
  }
  for (const socket of audioPipeSockets) socket.destroy();
  audioPipeSockets = [];
  for (const pipeServer of audioPipeServers) {
    try { pipeServer.close(); } catch { /* already closed */ }
  }
  audioPipeServers = [];
}

function startAudioHelper(systemPort, microphonePort, microphoneId, gain) {
  const helperPath = findAudioHelper();
  if (!helperPath) return Promise.reject(new Error("Die integrierte Windows-Audioaufnahme fehlt. Clipfarm kann nicht gestartet werden."));
  return new Promise((resolve, reject) => {
    const helper = spawn(helperPath, [String(systemPort || 0), String(microphonePort || 0), microphoneId || "default", String(gain)], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    audioHelperProcess = helper;
    let stdoutBuffer = "";
    let errorBuffer = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(errorBuffer.trim().replace(/^ERROR\s*/, "") || "Windows-Audioaufnahme wurde nicht rechtzeitig bereit.");
      closeAudioPipeline();
      reject(error);
    }, 10000);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        closeAudioPipeline();
        reject(error);
      } else {
        audioHelperReady = true;
        resolve(helper);
      }
    };
    helper.stdout.setEncoding("utf8");
    helper.stderr.setEncoding("utf8");
    helper.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      if (lines.some((line) => line.trim() === "READY")) finish();
    });
    helper.stderr.on("data", (chunk) => { errorBuffer = `${errorBuffer}${chunk}`.slice(-1000); });
    helper.once("error", (error) => finish(error));
    helper.once("exit", (code) => {
      if (audioHelperProcess !== helper) return;
      audioHelperProcess = null;
      audioHelperReady = false;
      if (!settled) finish(new Error(errorBuffer.trim().replace(/^ERROR\s*/, "") || `Windows-Audioaufnahme endete mit Code ${code}.`));
      else if (captureProcess && captureState.state === "running" && !shuttingDown) {
        captureState.error = errorBuffer.trim().replace(/^ERROR\s*/, "") || "Windows-Audioaufnahme wurde unerwartet beendet";
        logEvent("error", "audio helper exited", { code, error: captureState.error });
        captureProcess.kill("SIGINT");
      }
    });
  });
}

function scheduleCaptureRestart(reason) {
  if (shuttingDown || restartTimer || restartAttempts >= 3) return;
  restartAttempts += 1;
  captureState.state = "recovering";
  logEvent("warn", "capture engine restart scheduled", { reason, attempt: restartAttempts });
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startCapture().then(() => logEvent("info", "capture engine recovered")).catch((error) => logEvent("error", "capture engine recovery failed", { error: error.message }));
  }, 750);
}

function scheduleMinimizedRetry() {
  if (!captureRequested || shuttingDown || minimizedRetryTimer) return;
  minimizedRetryTimer = setTimeout(() => {
    minimizedRetryTimer = null;
    if (!captureRequested || shuttingDown) return;
    startCapture().catch((error) => {
      if (!/ist minimiert/i.test(error.message)) logEvent("warn", "automatic capture retry failed", { error: error.message });
    });
  }, 1000);
}

function clearBufferSegments() {
  completedSegmentCache = [];
  completedSegmentCacheDirectory = bufferDirectory;
  if (!fs.existsSync(bufferDirectory)) return;
  for (const name of fs.readdirSync(bufferDirectory)) {
    if (/^(segment|concat)-\d+(?:\.mp4|\.txt)$/i.test(name) || name === "segments.ffconcat" || name.startsWith("clip-snapshot-")) {
      fs.rmSync(path.join(bufferDirectory, name), { recursive: true, force: true });
    }
  }
}

function hasPlayableSegment() {
  const candidates = listSegments().slice(-3).filter(({ file }) => {
    try { return fs.statSync(file).size > 1024; }
    catch { return false; }
  });
  return Promise.all(candidates.map(({ file }) => new Promise((resolve) => {
    execFile(findFfprobe(), ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { windowsHide: true, timeout: 1200 }, (error, stdout) => resolve(!error && Number(stdout) > 0));
  }))).then((results) => results.some(Boolean));
}

function latestCaptureOutputTime() {
  let latestMtime = 0;
  try {
    for (const name of fs.readdirSync(bufferDirectory)) {
      if (name !== "segments.ffconcat" && !/^segment-\d{3}\.mp4$/i.test(name)) continue;
      try { latestMtime = Math.max(latestMtime, fs.statSync(path.join(bufferDirectory, name)).mtimeMs); }
      catch { /* a segment may rotate while the directory is being checked */ }
    }
  } catch { /* the output directory may not exist yet */ }
  return latestMtime;
}

function scheduleCaptureHealthCheck(pid) {
  if (captureHealthTimer) clearTimeout(captureHealthTimer);
  captureHealthTimer = setTimeout(() => {
    captureHealthTimer = null;
    if (captureProcess?.pid !== pid || captureState.state !== "running" || shuttingDown) return;

    const lastOutputAt = latestCaptureOutputTime();
    const staleForMs = lastOutputAt ? Date.now() - lastOutputAt : Infinity;
    if (staleForMs >= CAPTURE_STALE_OUTPUT_TIMEOUT_MS) {
      const reason = lastOutputAt
        ? `FFmpeg hat ${Math.round(staleForMs / 1000)} Sekunden lang keine neuen Replay-Segmente geschrieben`
        : "FFmpeg hat noch keine Replay-Segmente geschrieben";
      captureState.error = reason;
      logEvent("error", "capture engine output stalled", {
        pid, staleForMs: Number.isFinite(staleForMs) ? staleForMs : null,
        lastOutputAt: lastOutputAt ? new Date(lastOutputAt).toISOString() : null
      });
      captureProcess.kill("SIGINT");
      return;
    }

    scheduleCaptureHealthCheck(pid);
  }, CAPTURE_HEALTH_CHECK_INTERVAL_MS);
}

async function startCapture() {
  try {
    return await startCaptureInternal();
  } catch (error) {
    const message = String(error?.message || error || "Unbekannter Fehler beim Starten der Aufnahme");
    if (!captureProcess) {
      closeAudioPipeline();
      captureState = {
        ...captureState,
        state: "error",
        pid: null,
        encoder: null,
        error: message,
        config: engineConfig
      };
    }
    logEvent("error", "capture start failed", {
      error: message,
      captureMethod: captureState.captureMethod,
      captureState: captureState.state
    });
    throw error;
  }
}

async function startCaptureInternal() {
  if (captureProcess && captureState.state === "running") return Promise.resolve(getCaptureState());
  if (clipSaveInFlight) await clipSaveInFlight.catch(() => {});
  const { ffmpeg, encoders } = await ensureFfmpegRuntime();
  process.env.CLIPFARM_FFMPEG = ffmpeg;
  const videoEncoder = await selectVideoEncoder(ffmpeg, encoders);
  const session = await detectGame();
  const [width, height] = engineConfig.resolution.split("x").map(Number);
  const quality = { performance: "speed", balanced: "balanced", quality: "quality" }[engineConfig.quality];
  const segmentCount = ringSegmentCount();
  let actualCaptureMethod = engineConfig.captureMethod === "auto" ? (session.processId ? "game" : "display") : engineConfig.captureMethod;
  if (actualCaptureMethod !== "display" && !session.processId) {
    const error = "Für Game- oder Window-Capture wurde kein unterstütztes Spiel erkannt";
    captureState = { ...captureState, state: "error", pid: null, encoder: null, captureMethod: actualCaptureMethod, error, config: engineConfig };
    logEvent("warn", "capture start rejected", { reason: error, captureMethod: actualCaptureMethod });
    throw new Error(error);
  }
  let captureWindowHandle = null;
  if (actualCaptureMethod !== "display") {
    const windowState = await getMainWindowState(session.processId);
    captureWindowHandle = windowState?.handle || null;
    if (!captureWindowHandle && engineConfig.captureMethod === "auto") {
      logEvent("warn", "game window handle unavailable; falling back to monitor capture", { game: session.game, process: session.process, processId: session.processId });
      actualCaptureMethod = "display";
    } else if (!captureWindowHandle) {
      const error = "Das erkannte Spiel hat kein sichtbares Fenster für die Aufnahme";
      captureState = { ...captureState, state: "error", pid: null, encoder: null, captureMethod: actualCaptureMethod, error, config: engineConfig };
      logEvent("warn", "capture start rejected", { reason: error, captureMethod: actualCaptureMethod, processId: session.processId });
      throw new Error(error);
    }
    if (actualCaptureMethod !== "display" && windowState?.minimized) {
      const error = `${session.game || "Das erkannte Spiel"} ist minimiert. Windows liefert so keine neuen Spielbilder; Clipfarm versucht automatisch erneut zu starten, sobald das Spielfenster wieder sichtbar ist.`;
      captureState = { ...captureState, state: "error", pid: null, encoder: null, captureMethod: actualCaptureMethod, error, config: engineConfig };
      logEvent("warn", "capture start rejected", { reason: error, captureMethod: actualCaptureMethod, processId: session.processId, captureWindowHandle });
      scheduleMinimizedRetry();
      throw new Error(error);
    }
    if (actualCaptureMethod !== "display" && !windowState?.visible) {
      const error = "Das Spielfenster ist nicht sichtbar. Stelle das Spielfenster wieder her und starte den Replay-Puffer erneut.";
      captureState = { ...captureState, state: "error", pid: null, encoder: null, captureMethod: actualCaptureMethod, error, config: engineConfig };
      logEvent("warn", "capture start rejected", { reason: error, captureMethod: actualCaptureMethod, processId: session.processId, captureWindowHandle });
      throw new Error(error);
    }
  }
  const devices = await discoverAudioDevices();
  const requestedMicrophone = process.env.CLIPFARM_MIC_DEVICE || engineConfig.microphoneDevice;
  const selectedMicrophone = devices.find((device) => device.id === requestedMicrophone || device.name === requestedMicrophone)
    || devices.find((device) => device.isDefault)
    || devices[0]
    || null;
  const microphone = selectedMicrophone?.id || null;
  const captureTarget = actualCaptureMethod === "display"
    ? `gfxcapture=monitor_idx=0:max_framerate=${engineConfig.fps}:capture_cursor=0:width=${width}:height=${height}`
    : `gfxcapture=hwnd=${captureWindowHandle}:max_framerate=${engineConfig.fps}:capture_cursor=0:width=${width}:height=${height}`;
  const includeSystemAudio = engineConfig.gameAudio;
  const includeMicrophone = Boolean(microphone);
  const audioInputCount = Number(includeSystemAudio) + Number(includeMicrophone);
  const systemFd = includeSystemAudio ? 3 : null;
  const microphoneFd = includeMicrophone ? (includeSystemAudio ? 4 : 3) : null;
  let systemPort = 0;
  let microphonePort = 0;
  if (audioInputCount > 0) {
    if (!findAudioHelper()) throw new Error("Die integrierte Windows-Audioaufnahme fehlt. Bitte Clipfarm neu installieren.");
    fs.mkdirSync(bufferDirectory, { recursive: true });
    fs.mkdirSync(clipDirectory, { recursive: true });
    clearBufferSegments();
    if (includeSystemAudio) systemPort = await createAudioPipe(systemFd);
    if (includeMicrophone) microphonePort = await createAudioPipe(microphoneFd);
  }
  fs.mkdirSync(bufferDirectory, { recursive: true });
  fs.mkdirSync(clipDirectory, { recursive: true });
  clearBufferSegments();
  const args = [
    "-hide_banner", "-loglevel", "warning", "-filter_complex_threads", "1",
    "-thread_queue_size", "4", "-f", "lavfi", "-i", captureTarget
  ];
  let nextInput = 1;
  let systemInput = null;
  let microphoneInput = null;
  if (includeSystemAudio) {
    systemInput = nextInput++;
    args.push("-thread_queue_size", "4", "-f", "f32le", "-ar", "48000", "-ac", "2", "-i", `pipe:${systemFd}`);
  }
  if (includeMicrophone) {
    microphoneInput = nextInput++;
    args.push("-thread_queue_size", "4", "-f", "f32le", "-ar", "48000", "-ac", "2", "-i", `pipe:${microphoneFd}`);
  }
  if (audioInputCount === 0) {
    args.push("-map", "0:v:0", "-an");
  } else if (includeSystemAudio && includeMicrophone && engineConfig.separateTracks) {
    args.push("-map", "0:v:0", "-map", `${systemInput}:a:0`, "-map", `${microphoneInput}:a:0`);
  } else if (includeSystemAudio && includeMicrophone) {
    args.push("-filter_complex", `[${systemInput}:a:0][${microphoneInput}:a:0]amix=inputs=2:duration=longest:dropout_transition=0[aout]`, "-map", "0:v:0", "-map", "[aout]");
  } else {
    const audioInput = includeSystemAudio ? systemInput : microphoneInput;
    args.push("-map", "0:v:0", "-map", `${audioInput}:a:0`);
  }
  if (audioInputCount > 0) args.push("-c:a", "aac", "-b:a", includeSystemAudio && includeMicrophone && engineConfig.separateTracks ? "128k" : "160k", "-ar", "48000", "-ac", "2");
  if (includeSystemAudio && includeMicrophone && engineConfig.separateTracks) args.push("-metadata:s:a:0", "title=PC-Ton", "-metadata:s:a:1", "title=Mikrofon");
  args.push("-r", String(engineConfig.fps), "-fps_mode", "cfr");
  if (videoEncoder === "libx264") {
    const x264Preset = engineConfig.quality === "quality" ? "superfast" : "ultrafast";
    args.push(
      "-vf", "hwdownload,format=bgra,format=yuv420p",
      "-c:v", videoEncoder, "-preset", x264Preset, "-tune", "zerolatency", "-pix_fmt", "yuv420p",
      "-b:v", engineConfig.bitrate, "-maxrate", engineConfig.bitrate, "-bufsize", `${Number.parseInt(engineConfig.bitrate, 10) * 2}M`,
      "-g", String(Math.max(1, Math.round(engineConfig.fps * SEGMENT_DURATION_SECONDS)))
    );
  } else {
    args.push(
      "-c:v", videoEncoder, "-usage", "lowlatency", "-quality", quality,
      "-b:v", engineConfig.bitrate, "-g", String(Math.max(1, Math.round(engineConfig.fps * SEGMENT_DURATION_SECONDS))), "-pix_fmt", "d3d11"
    );
  }
  args.push(
    "-max_muxing_queue_size", "32",
    "-f", "segment", "-segment_time", String(SEGMENT_DURATION_SECONDS), "-segment_wrap", String(segmentCount),
    "-segment_list", path.join(bufferDirectory, "segments.ffconcat"), "-segment_list_type", "ffconcat",
    "-segment_list_size", String(segmentCount),
    "-reset_timestamps", "1", path.join(bufferDirectory, "segment-%03d.mp4")
  );
  captureState = {
    state: "starting", pid: null, encoder: videoEncoder, captureMethod: actualCaptureMethod, captureTarget,
    audioSource: [includeSystemAudio ? "Windows-Systemaudio" : null, includeMicrophone ? selectedMicrophone.name : null].filter(Boolean).join(" + ") || "none",
    error: null, bufferDirectory, micEnabled: captureState.micEnabled !== false, audioControlPort,
    microphoneLiveControl: includeMicrophone, config: engineConfig
  };
  logEvent("info", "capture engine starting", {
    encoder: videoEncoder, configuredEncoder: engineConfig.encoder, resolution: engineConfig.resolution, fps: engineConfig.fps, bitrate: engineConfig.bitrate,
    quality: engineConfig.quality, requestedCaptureMethod: engineConfig.captureMethod, captureMethod: actualCaptureMethod,
    captureTarget, systemAudio: includeSystemAudio, microphone: selectedMicrophone?.name || null,
    captureWindowTitle: session.windowTitle || null, captureWindowHandle, processId: session.processId || null,
    separateTracks: engineConfig.separateTracks, microphoneVolume: engineConfig.microphoneVolume
  });
  const childStdio = ["ignore", "ignore", "pipe", ...(audioInputCount ? ["pipe"] : [])];
  if (includeSystemAudio && includeMicrophone) childStdio.push("pipe");
  captureProcess = spawn(ffmpeg, args, { windowsHide: true, stdio: childStdio });
  const pid = captureProcess.pid;
  captureState.pid = pid;
  captureProcess.stderr.setEncoding("utf8");
  captureProcess.stderr.on("data", (chunk) => {
    const message = String(chunk).trim();
    if (message && /warning|error|failed|invalid/i.test(message)) {
      captureState.error = message.slice(-500);
      logEvent("warn", "capture ffmpeg output", { pid, message: message.slice(-500) });
    }
  });
  captureProcess.once("spawn", () => {
    captureState.state = "running";
    sampleEngineMemory();
    applyCapturePriority(pid);
    logEvent("info", "capture engine running", { pid });
    setTimeout(async () => {
      if (captureProcess?.pid !== pid || captureState.state !== "running") return;
      const playableSegment = await hasPlayableSegment();
      if (captureProcess?.pid !== pid || captureState.state !== "running") return;
      if (playableSegment) {
        scheduleCaptureHealthCheck(pid);
        return;
      }
      captureState.state = "error";
      captureState.error = captureState.error || `FFmpeg hat innerhalb von ${CAPTURE_STARTUP_TIMEOUT_MS / 1000} Sekunden keinen gültigen Replay-Segmentpuffer erzeugt`;
      logEvent("error", "capture engine produced no playable segment", {
        pid, fps: engineConfig.fps, resolution: engineConfig.resolution, timeoutMs: CAPTURE_STARTUP_TIMEOUT_MS,
        ffmpegError: captureState.error
      });
      captureProcess.kill("SIGINT");
    }, CAPTURE_STARTUP_TIMEOUT_MS);
    setTimeout(() => { if (captureProcess?.pid === pid) restartAttempts = 0; }, 10000);
  });
  captureProcess.once("error", (error) => {
    captureState.state = "error";
    captureState.error = error.message;
    logEvent("error", "capture process error", { error: error.message });
    captureProcess = null;
    scheduleCaptureRestart(error.message);
  });
  captureProcess.once("exit", (code, signal) => {
    if (captureHealthTimer) clearTimeout(captureHealthTimer);
    captureHealthTimer = null;
    const wasStopping = captureState.state === "stopping";
    const hadStartupError = captureState.state === "error";
    captureState.state = wasStopping ? "stopped" : hadStartupError ? "error" : code === 0 ? "stopped" : "error";
    if (!wasStopping && code !== 0 && !captureState.error) captureState.error = `ffmpeg exited with code ${code || signal}`;
    logEvent(wasStopping || code === 0 ? "info" : "error", "capture process exited", { code, signal, error: captureState.error });
    captureProcess = null;
    captureState.pid = null;
    engineWorkingSetBytes = 0;
    engineCpuPercent = null;
    previousEngineCpu = null;
    const configurationFailure = Boolean(captureState.error && captureState.error.includes("keinen gültigen Replay-Segmentpuffer"));
    if (!wasStopping && !hadStartupError && code !== 0 && !configurationFailure) scheduleCaptureRestart(captureState.error || "ffmpeg exited unexpectedly");
    closeAudioPipeline();
  });
  if (audioInputCount > 0) {
    try {
      const gain = captureState.micEnabled ? engineConfig.microphoneVolume / 100 : 0;
      await startAudioHelper(systemPort, microphonePort, microphone, gain);
    } catch (error) {
      captureState.state = "error";
      captureState.error = error.message;
      logEvent("error", "Windows-Audioaufnahme konnte nicht gestartet werden", { error: error.message });
      captureProcess.kill("SIGINT");
      closeAudioPipeline();
      throw error;
    }
  }
  return new Promise((resolve) => setTimeout(() => resolve(getCaptureState()), 350));
}

function stopCapture() {
  if (captureHealthTimer) clearTimeout(captureHealthTimer);
  captureHealthTimer = null;
  if (!captureProcess) { closeAudioPipeline(); captureState = { ...captureState, state: "stopped", pid: null }; return Promise.resolve(getCaptureState()); }
  const processToStop = captureProcess;
  captureState.state = "stopping";
  processToStop.kill("SIGINT");
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => { if (!finished) { finished = true; resolve(getCaptureState()); } };
    processToStop.once("exit", finish);
    setTimeout(finish, 2000);
  });
}

async function updateEngineConfig(patch = {}) {
  const previous = engineConfig;
  const previousClipDirectory = clipDirectory;
  const previousBufferDirectory = bufferDirectory;
  const next = normalizeEngineConfig({ ...engineConfig, ...patch });
  const changed = JSON.stringify(previous) !== JSON.stringify(next);
  if (!changed) return getCaptureState();
  if (clipSaveInFlight) await clipSaveInFlight.catch(() => {});
  const captureFields = ["replayLength", "resolution", "fps", "bitrate", "encoder", "quality", "captureMethod", "microphoneDevice", "microphoneVolume", "gameAudio", "separateTracks", "bufferDirectory", "backgroundPriority"];
  const requiresRestart = captureFields.some((field) => previous[field] !== next[field]);
  const wasRunning = Boolean(captureProcess);
  engineConfig = next;
  clipDirectory = engineConfig.clipDirectory;
  bufferDirectory = engineConfig.bufferDirectory;
  if (previousClipDirectory !== clipDirectory) clipsCacheSignature = "";
  saveEngineConfig();
  logEvent("info", "engine configuration updated", { config: engineConfig, restarted: wasRunning && requiresRestart });
  if (!wasRunning || !requiresRestart) {
    if (captureState.state === "error") captureState = { ...captureState, state: "stopped", pid: null, encoder: null, error: null, config: engineConfig };
    captureState.config = engineConfig;
    captureState.bufferDirectory = bufferDirectory;
    return getCaptureState();
  }
  try {
    await stopCapture();
    return await startCapture();
  } catch (error) {
    engineConfig = previous;
    clipDirectory = previousClipDirectory;
    bufferDirectory = previousBufferDirectory;
    saveEngineConfig();
    logEvent("error", "engine configuration restart failed", { error: error.message });
    throw error;
  }
}

async function toggleMicrophone() {
  return setMicrophoneEnabled(captureState.micEnabled === false);
}

function setMicrophoneEnabled(enabled) {
  captureState.micEnabled = Boolean(enabled);
  if (audioHelperProcess && !audioHelperProcess.killed && audioHelperProcess.stdin?.writable) {
    const gain = captureState.micEnabled ? engineConfig.microphoneVolume / 100 : 0;
    audioHelperProcess.stdin.write(`gain ${gain}\n`);
  }
  logEvent("info", "microphone state changed", { enabled: captureState.micEnabled, liveControl: captureState.microphoneLiveControl });
  return getCaptureState();
}

function listSegments() {
  if (completedSegmentCacheDirectory !== bufferDirectory) {
    completedSegmentCache = [];
    completedSegmentCacheDirectory = bufferDirectory;
  }
  const listFile = path.join(bufferDirectory, "segments.ffconcat");
  const segmentCount = ringSegmentCount();
  const freshAfter = Date.now() - ((engineConfig.replayLength + CLIP_POSTROLL_SECONDS + CLIP_BUFFER_MARGIN_SECONDS) * 1000);
  const useCompletedCache = () => completedSegmentCache.filter((segment) => {
    try {
      const stat = fs.statSync(segment.file);
      return stat.mtimeMs === segment.mtime && stat.size === segment.size && stat.mtimeMs >= freshAfter;
    } catch { return false; }
  }).slice(-segmentCount);
  let listContents;
  try { listContents = fs.readFileSync(listFile, "utf8"); }
  catch { return useCompletedCache(); }
  const seen = new Set();
  const segments = [];
  for (const line of listContents.split(/\r?\n/)) {
    const match = /^file\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    let name = match[1].trim();
    if ((name.startsWith("'") && name.endsWith("'")) || (name.startsWith('"') && name.endsWith('"'))) name = name.slice(1, -1);
    name = path.basename(name);
    if (!/^segment-\d{3}\.mp4$/i.test(name) || seen.has(name)) continue;
    seen.add(name);
    const file = path.join(bufferDirectory, name);
    try {
      const stat = fs.statSync(file);
      if (stat.size > 0 && stat.mtimeMs >= freshAfter) segments.push({ file, mtime: stat.mtimeMs, size: stat.size });
    } catch { /* the ring may rotate while the segment list is being refreshed */ }
  }
  if (segments.length) completedSegmentCache = segments;
  return segments.length ? segments.slice(-segmentCount) : useCompletedCache();
}

function safeFilePart(value) {
  return String(value || "Game").replace(/[^a-z0-9 _-]/gi, "").trim().replace(/\s+/g, "_") || "Game";
}

function cleanupStorage() {
  if (engineConfig.cleanupPolicy === "never" || !fs.existsSync(clipDirectory)) return;
  const files = fs.readdirSync(clipDirectory)
    .filter((name) => name.toLowerCase().endsWith(".mp4"))
    .map((name) => {
      const file = path.join(clipDirectory, name);
      const stat = fs.statSync(file);
      return { file, size: stat.size, mtime: stat.mtimeMs };
    })
    .sort((a, b) => a.mtime - b.mtime);
  const limit = engineConfig.maxStorageGb * 1024 * 1024 * 1024;
  let total = files.reduce((sum, item) => sum + item.size, 0);
  while (total > limit && files.length > 1) {
    const oldest = files.shift();
    fs.rmSync(oldest.file, { force: true });
    total -= oldest.size;
    logEvent("info", "old clip removed by storage policy", { file: oldest.file, maxStorageGb: engineConfig.maxStorageGb });
  }
  clipsCacheSignature = "";
}

function thumbnailPathFor(file) {
  const stat = fs.statSync(file);
  const thumbDirectory = path.join(clipDirectory, ".thumbs");
  const base = safeFilePart(path.basename(file, path.extname(file)));
  return { directory: thumbDirectory, file: path.join(thumbDirectory, `${base}_${stat.size}_${Math.round(stat.mtimeMs)}.jpg`) };
}

function ensureThumbnail(file) {
  const target = thumbnailPathFor(file);
  if (fs.existsSync(target.file)) return Promise.resolve(target.file);
  fs.mkdirSync(target.directory, { recursive: true });
  return new Promise((resolve, reject) => {
    const job = spawn(findFfmpeg(), ["-hide_banner", "-loglevel", "error", "-ss", "0.5", "-i", file, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "5", "-an", "-y", target.file], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let errorText = "";
    job.stderr.setEncoding("utf8");
    job.stderr.on("data", (chunk) => { errorText += chunk; });
    job.once("error", reject);
    job.once("exit", (code) => {
      if (code === 0 && fs.existsSync(target.file)) resolve(target.file);
      else reject(new Error(errorText.trim() || `thumbnail failed with code ${code}`));
    });
  });
}

function resolveClipFile(filename) {
  const clipRoot = path.resolve(clipDirectory) + path.sep;
  const absolute = path.resolve(String(filename || ""));
  if (!absolute.startsWith(clipRoot) || !fs.existsSync(absolute)) throw new Error("clip file is outside the clip directory");
  return absolute;
}

function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function inferGameName(name) {
  const value = path.basename(String(name || ""), path.extname(String(name || "")));
  const match = value.match(/^(.*)_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:_\d+)?$/);
  return (match ? match[1] : value).replace(/_/g, " ") || "Game";
}

function uniqueClipPath(directory, gameName) {
  const baseName = `${safeFilePart(gameName)}_${stamp()}`;
  let suffix = 0;
  let outputFile;
  do {
    outputFile = path.join(directory, `${baseName}${suffix ? `_${suffix}` : ""}.mp4`);
    suffix += 1;
  } while (fs.existsSync(outputFile));
  return outputFile;
}

function saveClip(seconds = 30, gameName = "Game", uploadId = null) {
  if (clipSaveInFlight) return Promise.reject(new Error("Ein Clip wird gerade gesichert. Warte kurz und versuche es erneut."));
  const operation = saveClipFile(seconds, gameName, uploadId);
  let trackedOperation;
  trackedOperation = operation.finally(() => {
    if (clipSaveInFlight === trackedOperation) clipSaveInFlight = null;
  });
  clipSaveInFlight = trackedOperation;
  return trackedOperation;
}

async function saveClipFile(seconds = 30, gameName = "Game", uploadId = null) {
  const segmentsAtTrigger = listSegments();
  const readySeconds = Math.floor(segmentsAtTrigger.length * SEGMENT_DURATION_SECONDS);
  if (!readySeconds) {
    const reason = captureState.state === "error" && captureState.error
      ? `Der Replay-Puffer konnte nicht gestartet werden: ${captureState.error}`
      : captureState.state === "stopped"
        ? "Der Replay-Puffer ist pausiert."
        : "Es sind keine Replay-Segmente im Puffer vorhanden.";
    logEvent("warn", "clip save rejected", {
      reason,
      availableSeconds: 0,
      captureState: captureState.state,
      captureError: captureState.error,
      captureRequested
    });
    throw new Error(`${reason} ${captureState.state === "error" ? "Prüfe die Aufnahme-Einstellungen." : `Starte den Puffer mit F9 und warte mindestens ${SEGMENT_DURATION_SECONDS} Sekunde.`}`);
  }
  const requestedSeconds = Math.max(SEGMENT_DURATION_SECONDS, Math.min(engineConfig.replayLength, Number(seconds) || engineConfig.replayLength, readySeconds));
  const wasRecordingAtTrigger = Boolean(captureProcess && captureState.state === "running");
  if (wasRecordingAtTrigger) await new Promise((resolve) => setTimeout(resolve, (CLIP_POSTROLL_SECONDS + SEGMENT_DURATION_SECONDS) * 1000));
  const availableSegments = listSegments();
  const postRollSeconds = wasRecordingAtTrigger && captureProcess && captureState.state === "running" ? CLIP_POSTROLL_SECONDS : 0;
  const protectedWindowSeconds = requestedSeconds + postRollSeconds + (postRollSeconds ? SEGMENT_DURATION_SECONDS : 0);
  const requiredSegments = Math.max(1, Math.ceil(protectedWindowSeconds / SEGMENT_DURATION_SECONDS));
  const segments = availableSegments.slice(-Math.min(requiredSegments, availableSegments.length));
  if (!segments.length) throw new Error("Der Replay-Puffer enthält keine speicherbaren Segmente mehr.");
  if (uploadId && !/^[0-9a-f-]{36}$/i.test(String(uploadId))) throw new Error("Ungültige Upload-ID.");
  const destinationDirectory = uploadId ? stagingDirectory : clipDirectory;
  fs.mkdirSync(destinationDirectory, { recursive: true });
  const outputFile = uploadId ? path.join(destinationDirectory, `${uploadId}.mp4`) : uniqueClipPath(destinationDirectory, gameName);
  if (uploadId && fs.existsSync(outputFile)) throw new Error("Für diese Upload-ID wurde bereits ein Clip erstellt.");
  fs.mkdirSync(bufferDirectory, { recursive: true });
  const snapshotDirectory = fs.mkdtempSync(path.join(bufferDirectory, "clip-snapshot-"));
  const listFile = path.join(snapshotDirectory, "concat.txt");
  try {
    const snapshotSegments = [];
    for (let index = 0; index < segments.length; index += 1) {
      const snapshotFile = path.join(snapshotDirectory, `${String(index).padStart(3, "0")}.mp4`);
      try { await fs.promises.copyFile(segments[index].file, snapshotFile); }
      catch (error) { throw new Error(`Ein Replay-Segment konnte nicht für den Clip gesichert werden: ${error.message}`); }
      snapshotSegments.push(snapshotFile);
    }
    fs.writeFileSync(listFile, snapshotSegments.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
    await new Promise((resolve, reject) => {
      const job = spawn(findFfmpeg(), ["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-map", "0", "-c", "copy", "-movflags", "+faststart", outputFile], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      let errorText = "";
      job.stderr.setEncoding("utf8");
      job.stderr.on("data", (chunk) => { errorText += chunk; });
      job.once("error", reject);
      job.once("exit", (code) => {
        if (code === 0 && fs.existsSync(outputFile)) resolve();
        else reject(new Error(errorText.trim() || `clip mux failed with code ${code}`));
      });
    }).catch((error) => {
      fs.rmSync(outputFile, { force: true });
      logEvent("error", "clip mux failed", { error: error.message });
      throw error;
    });

    let metadata;
    try { metadata = await probeClip(outputFile); }
    catch (probeError) {
      fs.rmSync(outputFile, { force: true });
      logEvent("error", "clip rejected after probe", { file: outputFile, error: probeError.message });
      throw probeError;
    }
    const sizeBytes = fs.statSync(outputFile).size;
    cleanupStorage();
    logEvent("info", "clip saved", { file: outputFile, segments: segments.length, requestedSeconds, postRollSeconds });
    return { file: outputFile, game: gameName, ...metadata, sizeBytes };
  } finally {
    fs.rmSync(snapshotDirectory, { recursive: true, force: true });
  }
}

function probeClip(filename) {
  return new Promise((resolve, reject) => {
    execFile(findFfprobe(), ["-v", "error", "-select_streams", "v:0", "-show_entries", "format=duration:stream=width,height,avg_frame_rate,r_frame_rate", "-of", "json", filename], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error) { reject(error); return; }
      try {
        const data = JSON.parse(stdout);
        const stream = data.streams?.[0] || {};
        if (!stream.width || !stream.height) { reject(new Error("clip has no valid video stream")); return; }
        const measuredRate = stream.avg_frame_rate && stream.avg_frame_rate !== "0/0" ? stream.avg_frame_rate : stream.r_frame_rate;
        const [numerator, denominator] = String(measuredRate || "0/1").split("/").map(Number);
        resolve({
          seconds: Math.max(1, Math.round(Number(data.format?.duration || 0))),
          resolution: stream.width && stream.height ? `${stream.width} × ${stream.height}` : null,
          fps: numerator && denominator ? `${Math.round(numerator / denominator)} FPS` : null
        });
      } catch (parseError) { reject(parseError); }
    });
  });
}

async function listClips() {
  if (!fs.existsSync(clipDirectory)) return [];
  const files = fs.readdirSync(clipDirectory).filter((name) => name.toLowerCase().endsWith(".mp4")).map((name) => {
    const file = path.join(clipDirectory, name);
    const stat = fs.statSync(file);
    return { name, file, stat };
  });
  const signature = files.map(({ name, stat }) => `${name}:${stat.size}:${stat.mtimeMs}`).join("|");
  if (signature === clipsCacheSignature) return clipsCache;
  const entries = await Promise.all(files.map(async ({ name, file, stat }) => {
    try {
      const metadata = await probeClip(file);
      return { file, name: path.basename(name, path.extname(name)), game: inferGameName(name), thumbnail: `/api/thumbnail?file=${encodeURIComponent(file)}`, savedAt: stat.mtime.toISOString(), sizeBytes: stat.size, ...metadata };
    } catch (error) {
      logEvent("warn", "invalid clip hidden from library", { file, error: error.message });
      return null;
    }
  }));
  clipsCache = entries.filter(Boolean);
  clipsCacheSignature = signature;
  return clipsCache;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; if (body.length > 100000) request.destroy(); });
    request.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); } });
    request.on("error", reject);
  });
}

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const requested = decoded === "/" ? "/index.html" : decoded;
  const absolute = path.resolve(root, `.${requested}`);
  return absolute.startsWith(root + path.sep) ? absolute : null;
}

function serveStatic(response, urlPath) {
  const filename = safePath(urlPath);
  if (!filename) { sendJson(response, 400, { error: "invalid path" }); return; }
  fs.readFile(filename, (error, data) => {
    if (error) { sendJson(response, error.code === "ENOENT" ? 404 : 500, { error: "file not found" }); return; }
    const type = mimeTypes[path.extname(filename).toLowerCase()] || "application/octet-stream";
    response.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://benni-projects.de; media-src 'self' https://benni-projects.de; connect-src 'self'; font-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    });
    response.end(data);
  });
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  if (request.method === "POST" && requestUrl.pathname === "/api/config") {
    readRequestBody(request).then((body) => updateEngineConfig(body)).then((engine) => sendJson(response, 200, { ok: true, config: engine.config, engine })).catch((error) => sendJson(response, 400, { ok: false, error: error.message, config: engineConfig, engine: getCaptureState() }));
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/engine/start") { captureRequested = true; startCapture().then((state) => sendJson(response, 200, state)).catch((error) => sendJson(response, 500, { ...getCaptureState(), error: error.message })); return; }
  if (request.method === "POST" && requestUrl.pathname === "/api/engine/stop") { captureRequested = false; if (minimizedRetryTimer) clearTimeout(minimizedRetryTimer); minimizedRetryTimer = null; stopCapture().then((state) => sendJson(response, 200, state)).catch((error) => sendJson(response, 500, { ...getCaptureState(), error: error.message })); return; }
  if (request.method === "POST" && requestUrl.pathname === "/api/clip/save") {
    readRequestBody(request).then((body) => saveClip(body.seconds || 30, body.game || gameCache.game || "Game", body.uploadId || null)).then((clip) => sendJson(response, 200, { ok: true, clip })).catch((error) => sendJson(response, 409, { ok: false, error: error.message }));
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/audio/mic") {
    toggleMicrophone().then((state) => sendJson(response, 200, { ok: true, micEnabled: state.micEnabled, engine: state })).catch((error) => sendJson(response, 500, { ok: false, error: error.message }));
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/audio/mic/state") {
    readRequestBody(request).then((body) => setMicrophoneEnabled(body.enabled)).then((engine) => sendJson(response, 200, { ok: true, micEnabled: engine.micEnabled, engine })).catch((error) => sendJson(response, 400, { ok: false, error: error.message }));
    return;
  }
  if (request.method === "POST" && ["/api/file/open", "/api/file/delete", "/api/file/rename"].includes(requestUrl.pathname)) {
    readRequestBody(request).then((body) => {
      const file = resolveClipFile(body.file);
      if (requestUrl.pathname === "/api/file/delete") {
        fs.rmSync(file, { force: true });
        clipsCacheSignature = "";
        return { ok: true };
      }
      if (requestUrl.pathname === "/api/file/rename") {
        const nextName = `${safeFilePart(body.name)}.mp4`;
        const destination = path.join(path.dirname(file), nextName);
        if (!destination.startsWith(path.resolve(clipDirectory) + path.sep)) throw new Error("invalid destination");
        fs.renameSync(file, destination);
        clipsCacheSignature = "";
        return { ok: true, file: destination, name: path.basename(nextName, ".mp4") };
      }
      const action = body.action === "reveal" ? ["/select,", file] : [file];
      const explorer = spawn("explorer.exe", action, { detached: true, stdio: "ignore", windowsHide: true });
      explorer.unref();
      return { ok: true };
    }).then((result) => sendJson(response, 200, result)).catch((error) => sendJson(response, 400, { ok: false, error: error.message }));
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/thumbnail") {
    try {
      const source = resolveClipFile(requestUrl.searchParams.get("file"));
      ensureThumbnail(source).then((thumbnail) => fs.readFile(thumbnail, (error, data) => {
        if (error) { sendJson(response, 404, { error: "thumbnail not found" }); return; }
        response.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000", "Content-Length": data.length });
        response.end(data);
      })).catch((error) => sendJson(response, 404, { error: error.message }));
    } catch (error) { sendJson(response, 400, { error: error.message }); }
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/clip/play") {
    try {
      const file = resolveClipFile(requestUrl.searchParams.get("file"));
      const stat = fs.statSync(file);
      const range = request.headers.range;
      if (!range) {
        response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": stat.size, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
        fs.createReadStream(file).pipe(response);
        return;
      }
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        response.end();
        return;
      }
      const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
      const end = match[1] && match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
      if (!Number.isSafeInteger(start) || start < 0 || start > end || start >= stat.size) {
        response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        response.end();
        return;
      }
      response.writeHead(206, {
        "Content-Type": "video/mp4",
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store"
      });
      fs.createReadStream(file, { start, end }).pipe(response);
    } catch (error) { sendJson(response, 400, { error: error.message }); }
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/audio/devices") {
    discoverAudioDevices().then((devices) => {
      const requested = process.env.CLIPFARM_MIC_DEVICE || engineConfig.microphoneDevice;
      const selected = devices.find((device) => device.id === requested || device.name === requested)?.id
        || devices.find((device) => device.isDefault)?.id
        || devices[0]?.id
        || null;
      sendJson(response, 200, { devices, selected, default: devices.find((device) => device.isDefault)?.id || null, error: audioDiscoveryError, wasapiLoopback: Boolean(findAudioHelper()) });
    });
    return;
  }
  if (request.method !== "GET") { sendJson(response, 405, { error: "method not allowed" }); return; }
  if (requestUrl.pathname === "/api/health") { sendJson(response, 200, { ok: true, service: "clipfarm-local-host", pid: process.pid }); return; }
  if (requestUrl.pathname === "/api/logs") {
    let lines = [];
    try { lines = fs.readFileSync(logFile, "utf8").trim().split(/\r?\n/).slice(-100); } catch { /* no log yet */ }
    sendJson(response, 200, { file: logFile, lines });
    return;
  }
  if (requestUrl.pathname === "/api/metrics") { sendJson(response, 200, readProcessMetrics()); return; }
  if (requestUrl.pathname === "/api/session") { detectGame().then((session) => sendJson(response, 200, session)); return; }
  if (requestUrl.pathname === "/api/config") { sendJson(response, 200, { config: engineConfig }); return; }
  if (requestUrl.pathname === "/api/engine") { sendJson(response, 200, getCaptureState()); return; }
  if (requestUrl.pathname === "/api/clips") { listClips().then((clips) => sendJson(response, 200, { clips })).catch((error) => sendJson(response, 500, { error: error.message })); return; }
  serveStatic(response, requestUrl.pathname);
});

const memorySampleTimer = setInterval(sampleEngineMemory, 10000);
const gpuSampleTimer = setInterval(sampleGpuMetrics, 15000);

function startServer(requestedPort = port) {
  if (server.listening) return Promise.resolve(server.address().port);
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(requestedPort, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const address = server.address();
      const activePort = address && typeof address === "object" ? address.port : requestedPort;
      console.log(`clipfarm local host listening on http://127.0.0.1:${activePort}`);
      resolve(activePort);
    });
  });
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (minimizedRetryTimer) clearTimeout(minimizedRetryTimer);
  clearInterval(memorySampleTimer);
  clearInterval(gpuSampleTimer);
  if (clipSaveInFlight) await clipSaveInFlight.catch(() => {});
  if (captureProcess) await stopCapture();
  logEvent("info", "clipfarm host shutting down");
  if (server.listening) {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    });
  }
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(`clipfarm local host could not start: ${error.message}`);
    process.exitCode = 1;
  });
  process.on("SIGINT", () => shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => shutdown().then(() => process.exit(0)));
}

module.exports = { server, startServer, shutdown, getCaptureState };
