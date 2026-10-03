const demoClipNames = new Set(["Counter-Strike 2 clutch", "Minecraft nether run", "Fortnite final circle"]);

const state = {
  replayOn: false,
  clipSaving: false,
  micOn: true,
  metricsOn: true,
  metricsLive: false,
  lastEngineError: null,
  sessionLive: false,
  engineLive: false,
  autoStartPending: false,
  engineCaptureMethod: null,
  engineError: false,
  sessionGame: null,
  sessionProcess: null,
  sessionWindowTitle: null,
  sessionProcessId: null,
  sessionIconProcessId: null,
  sessionIconLoadingProcessId: null,
  sessionIconLastAttemptProcessId: null,
  sessionIconLastAttemptAt: 0,
  replayLength: 30,
  postRollSeconds: 2,
  bufferSeconds: 0,
  config: null,
  hotkeys: { save: "F8", toggle: "F9", microphone: "F10" },
  hotkeyCapture: null,
  filter: "all",
  clips: loadClips(),
  cloudClips: [],
  profile: null,
  pendingAvatarData: undefined,
  cloudLibraryLoading: false,
  activeView: "feed",
  backendStatus: null,
  backendCheckInFlight: false,
  account: null,
  authMode: "login",
  authBusy: false,
  feed: [],
  feedCursor: null,
  feedLoading: false,
  feedHasMore: false,
  feedError: "",
  uploadQueue: [],
  toastTimer: null,
  uiPolling: false,
  uiTimers: []
};

function loadClips() {
  if (localStorage.getItem("clipfarm-cloud-media-migration") !== "1") {
    localStorage.removeItem("clipfarm-clips");
    localStorage.setItem("clipfarm-cloud-media-migration", "1");
    return [];
  }
  try {
    const saved = JSON.parse(localStorage.getItem("clipfarm-clips"));
    return Array.isArray(saved) ? saved.filter((clip) => !demoClipNames.has(clip.name)) : [];
  } catch { return []; }
}

function persistClips() { localStorage.setItem("clipfarm-clips", JSON.stringify(state.clips)); }
function $(id) { return document.getElementById(id); }

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function playClipOutcome(success, { notifyOverlay = true, message = "" } = {}) {
  if (window.clipfarmNative?.notifyClipOutcome) {
    if (notifyOverlay) {
      window.clipfarmNative.notifyClipOutcome({ outcome: success ? "success" : "failed", message }).catch(() => {});
    }
    return;
  }
  const sound = $(success ? "clipSuccessSound" : "clipFailureSound");
  if (sound) {
    sound.currentTime = success ? 1.16 : 0.34;
    const playback = sound.play();
    if (playback?.catch) playback.catch(() => {});
  }
}

function setView(view) {
  if (!["feed", "session", "library", "settings", "profile"].includes(view)) return;
  state.activeView = view;
  document.querySelectorAll(".nav-item").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.querySelectorAll(".view").forEach((panel) => {
    const active = panel.dataset.panel === view;
    panel.hidden = !active;
    panel.classList.toggle("is-visible", active);
  });
  const headings = {
    feed: ["Feed", "Momente aus deinen Spielen"],
    session: ["Session", "Capture-Workbench"],
    library: ["Meine Clips", "Auf diesem PC"],
    settings: ["Einstellungen", "Dein Setup"],
    profile: ["Mein Profil", "Dein Konto"]
  };
  $("pageTitle").textContent = headings[view][0];
  $("pageEyebrow").textContent = headings[view][1];
  if (view === "library") renderLibrary();
  if (view === "library") loadLibraryClips();
  if (view === "profile") loadProfile();
}

function toggleSwitch(button) {
  const enabled = button.classList.toggle("is-on");
  button.setAttribute("aria-pressed", String(enabled));
  return enabled;
}

function encoderLabel(encoder) {
  return encoder === "h264_amf" ? "AMD AMF AVC" : "AMD AMF HEVC";
}

function eventHotkeySpec(event) {
  const base = String(event.key || "").toUpperCase();
  if (!/^F(?:[1-9]|1[0-2])$/.test(base) && !/^[A-Z0-9]$/.test(base)) return null;
  const modifiers = [];
  if (event.ctrlKey) modifiers.push("CTRL");
  if (event.altKey) modifiers.push("ALT");
  if (event.shiftKey) modifiers.push("SHIFT");
  if (event.metaKey) modifiers.push("WIN");
  return `${modifiers.join("+")}${modifiers.length ? "+" : ""}${base}`;
}

function applyConfig(config) {
  if (!config) return;
  state.config = config;
  state.hotkeys = { ...state.hotkeys, ...(config.hotkeys || {}) };
  state.replayLength = Number(config.replayLength) || state.replayLength;
  const controls = {
    replayLength: $("replayLengthSelect"),
    resolution: $("resolutionSelect"),
    fps: $("fpsSelect"),
    bitrate: $("bitrateSelect"),
    encoder: $("encoderSelect"),
    quality: $("qualitySelect"),
    captureMethod: $("captureMethodSelect")
  };
  Object.entries(controls).forEach(([key, control]) => {
    if (control && config[key] !== undefined && [...control.options].some((option) => option.value === String(config[key]))) control.value = String(config[key]);
  });
  $("replayLengthButton").textContent = `${state.replayLength} Sek.`;
  $("captureResolution").textContent = String(config.resolution || "").replace("x", " × ");
  $("captureFps").textContent = `${config.fps} FPS`;
  $("captureEncoder").textContent = encoderLabel(config.encoder);
  $("saveHotkey").textContent = state.hotkeys.save;
  $("toggleHotkey").textContent = state.hotkeys.toggle;
  $("microphoneHotkey").textContent = state.hotkeys.microphone;
  for (const id of ["globalSaveKey", "railSaveHotkey", "sessionSaveHotkey"]) if ($(id)) $(id).textContent = state.hotkeys.save;
  for (const id of ["railToggleHotkey"]) if ($(id)) $(id).textContent = state.hotkeys.toggle;
  for (const id of ["microphoneQuickHotkey", "railMicHotkey"]) if ($(id)) $(id).textContent = state.hotkeys.microphone;
  if ($("microphoneVolumeSelect") && config.microphoneVolume !== undefined) $("microphoneVolumeSelect").value = String(config.microphoneVolume);
  if ($("clipDirectoryInput") && config.clipDirectory) $("clipDirectoryInput").value = config.clipDirectory;
  if ($("bufferDirectoryInput") && config.bufferDirectory) $("bufferDirectoryInput").value = config.bufferDirectory;
  if ($("maxStorageSelect") && config.maxStorageGb !== undefined) $("maxStorageSelect").value = String(config.maxStorageGb);
  if ($("cleanupPolicySelect") && config.cleanupPolicy) $("cleanupPolicySelect").value = config.cleanupPolicy;
  for (const [id, key] of [["gameAudioSwitch", "gameAudio"], ["gameAudioSettingsSwitch", "gameAudio"], ["separateTracksSwitch", "separateTracks"]]) {
    const control = $(id);
    if (!control || config[key] === undefined) continue;
    control.classList.toggle("is-on", Boolean(config[key]));
    control.setAttribute("aria-pressed", String(Boolean(config[key])));
  }
  if ($("gameAudioStatus")) $("gameAudioStatus").textContent = config.gameAudio ? "Windows-Audio aktiv" : "Windows-Audio aus";
  if ($("backgroundPrioritySwitch") && config.backgroundPriority !== undefined) {
    $("backgroundPrioritySwitch").classList.toggle("is-on", Boolean(config.backgroundPriority));
    $("backgroundPrioritySwitch").setAttribute("aria-pressed", String(Boolean(config.backgroundPriority)));
  }
  updateReplayUI();
}

function updateReplayUI() {
  const bufferReady = state.engineLive && state.bufferSeconds >= state.replayLength;
  const hasBuffer = state.bufferSeconds > 0;
  $("replayStateLabel").textContent = state.engineLive ? bufferReady ? "AN" : "FÜLLT" : state.autoStartPending ? "WARTET" : hasBuffer ? "TEILPUFFER" : state.engineError ? "FEHLER" : "AUS";
  const replayDot = $("replayStatusDot");
  if (replayDot) {
    replayDot.classList.toggle("is-active", state.engineLive);
    replayDot.classList.toggle("is-error", state.engineError);
  }
  $("replayStateDetail").textContent = state.engineLive
    ? bufferReady ? "Puffer bereit" : `${state.bufferSeconds} / ${state.replayLength} SEK`
    : state.autoStartPending ? "Wartet auf sichtbares Spiel" : hasBuffer ? `${state.bufferSeconds} SEK SPEICHERBAR` : state.engineError ? "Aufnahme nicht gestartet" : "Puffer pausiert";
  $("replayTime").textContent = `${state.replayLength} SEK`;
  $("replayCopy").textContent = state.engineLive
    ? bufferReady
      ? `Die letzten ${state.replayLength} Sekunden bleiben bereit; ${state.postRollSeconds} Sekunden Nachlauf halten Audio und Spielmoment vollständig im Clip.`
      : `Replay läuft. ${state.bufferSeconds} Sekunden sind bereits verfügbar; der Clip-Button speichert sofort die verfügbare Länge.`
    : state.autoStartPending
      ? "Das Spiel ist minimiert. Clipfarm prüft jede Sekunde erneut und beginnt automatisch, sobald das Spielfenster wieder sichtbar ist."
      : hasBuffer
      ? `Die Aufnahme ist pausiert. ${state.bufferSeconds} Sekunden aus dem vorhandenen Puffer können noch gespeichert werden.`
      : state.engineError
        ? "Der Puffer konnte nicht starten. Bei minimiertem Spielfenster liefert Windows keine neuen Spielbilder."
        : "Der Replay-Puffer ist pausiert und verbraucht keine Capture-Ressourcen.";
  $("toggleReplayButton").textContent = state.engineLive || state.autoStartPending ? "Puffer stoppen" : "Puffer starten";
  const fill = Math.min(1, Math.max(0, state.bufferSeconds / state.replayLength));
  $("replayRuleFill").style.transform = `scaleX(${fill})`;
  $("replayProgress").setAttribute("aria-valuenow", String(Math.round(fill * 100)));
  const head = document.querySelector(".timeline-head");
  if (head) head.style.left = `${fill * 100}%`;
  // The button remains actionable so it can explain when the replay buffer is empty.
  $("saveClipButton").disabled = state.clipSaving;
  $("saveClipButton").setAttribute("aria-busy", String(state.clipSaving));
  $("saveClipButton").title = hasBuffer ? `Clip mit ${state.bufferSeconds} Sekunden Puffer speichern` : "Noch keine Replay-Segmente verfügbar";
  renderCaptureStatus();
}

function formatNow() {
  const now = new Date();
  return now.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

async function saveClip() {
  if (state.clipSaving) return;
  if (state.bufferSeconds <= 0) {
    const message = state.engineError
      ? `Aufnahme nicht gestartet: ${state.lastEngineError || 'Prüfe die Aufnahme-Einstellungen.'}`
      : state.autoStartPending
        ? 'Der Puffer wartet auf ein sichtbares Spielfenster. Stelle das Spiel wieder her und warte auf die ersten Segmente.'
        : !state.engineLive
          ? 'Der Replay-Puffer ist pausiert. Starte ihn mit F9 und warte mindestens eine halbe Sekunde.'
          : 'Der Replay-Puffer startet noch. Warte auf die ersten Segmente und versuche es erneut.';
    playClipOutcome(false, { message }); showToast(message); return;
  }
  state.clipSaving = true;
  $("saveClipButton").disabled = true;
  $("saveClipButton").setAttribute("aria-busy", "true");
  const savingMessage = state.engineLive
    ? `${state.bufferSeconds} Sekunden Puffer + ${state.postRollSeconds} Sekunden Nachlauf – Clip wird gesichert.`
    : `${state.bufferSeconds} Sekunden aus dem vorhandenen Puffer werden gesichert.`;
  try {
    if (!window.clipfarmNative?.saveClip) throw new Error('Clipfarm kann den Clip nur in der Desktop-App sichern.');
    const payload = await window.clipfarmNative.saveClip();
    if (payload.localOnly) {
      addClip(payload.clip);
      await syncDiskClips();
      showToast('Clip nur auf diesem PC gespeichert.');
    } else {
      await refreshUploadQueue();
      showToast('Clip wird sicher zum Server hochgeladen.');
    }
  } catch (error) {
    playClipOutcome(false, { message: error.message });
    showToast(error.message);
  } finally {
    state.clipSaving = false;
    $("saveClipButton").disabled = false;
    $("saveClipButton").setAttribute("aria-busy", "false");
  }
}
function addClip(realClip = {}) {
  if (!realClip.file) return;
  const id = realClip.file;
  const seconds = Number(realClip.seconds || state.replayLength);
  const game = realClip.game || state.sessionGame || "Game";
  const size = realClip.sizeBytes ? `${(realClip.sizeBytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : "—";
  const name = realClip.name || `${game} ${formatNow()}`;
  const clip = { id, file: realClip.file, name, game, date: `Heute um ${formatNow()}`, duration: formatDuration(seconds), resolution: realClip.resolution || "n/a", fps: realClip.fps || "n/a", size, thumbnail: realClip.thumbnail || null };
  state.clips = [clip, ...state.clips];
  persistClips();
  renderLibrary();
  updateClipCount();
}

function thumbnail(clip, compact = false) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `thumb ${compact ? "library-thumb" : ""}`;
  const canPlay = Boolean(clip.file || clip.mediaUrl);
  el.disabled = !canPlay;
  el.setAttribute("aria-label", canPlay ? `Clip abspielen: ${clip.name}` : `Keine Videodatei für ${clip.name} verfügbar`);
  el.addEventListener("click", () => playClip(clip));
  const scene = document.createElement("span");
  scene.className = "thumb-scene";
  scene.setAttribute("aria-hidden", "true");
  el.append(scene);
  const label = document.createElement("span");
  label.className = "thumb-label";
  label.textContent = clip.game === "Counter-Strike 2" ? "CS2" : String(clip.game || "Game").toUpperCase().slice(0, 7);
  const duration = document.createElement("span");
  duration.className = "thumb-time";
  duration.textContent = clip.duration || "—";
  const playGlyph = document.createElement("span");
  playGlyph.className = "thumb-play";
  playGlyph.setAttribute("aria-hidden", "true");
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.classList.add("icon");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "./assets/clipfarm-icons.svg#play");
  icon.append(use);
  playGlyph.append(icon);
  el.append(label, duration, playGlyph);
  if (clip.thumbnail) {
    try {
      const imageUrl = new URL(clip.thumbnail, window.location.href);
      if (imageUrl.origin === window.location.origin && imageUrl.pathname === "/api/thumbnail") {
        el.classList.add("has-preview");
        el.style.backgroundImage = `url("${imageUrl.href}")`;
        el.style.backgroundSize = "cover";
        el.style.backgroundPosition = "center";
      }
    } catch { /* an invalid local thumbnail is left as a neutral clip frame */ }
  }
  return el;
}

function renderLibrary() {
  const list = $("libraryList");
  const query = $("clipSearch").value.trim().toLowerCase();
  const allClips = [...state.cloudClips, ...state.clips];
  const clips = allClips.filter((clip) => {
    const matchesQuery = !query || `${clip.name} ${clip.game}`.toLowerCase().includes(query);
    const date = clip.uploadedAt ? new Date(clip.uploadedAt).toLocaleDateString("de-DE") : String(clip.date || "");
    const matchesFilter = state.filter === "all" || date === new Date().toLocaleDateString("de-DE") || date.startsWith("Heute");
    return matchesQuery && matchesFilter;
  });
  list.replaceChildren();
  $("libraryTotalCount").textContent = allClips.length.toLocaleString("de-DE");
  $("libraryResultCount").textContent = `${clips.length} von ${allClips.length} ${allClips.length === 1 ? "Clip" : "Clips"}`;
  $("emptyLibrary").hidden = clips.length > 0;
  const hasSavedClips = allClips.length > 0;
  $("emptyLibrary").querySelector("h3").textContent = hasSavedClips ? "Kein Clip gefunden" : "Noch keine Clips gespeichert";
  $("emptyLibrary").querySelector("p").textContent = hasSavedClips
    ? "Ändere den Suchbegriff oder setze den Heute-Filter zurück."
    : state.profile?.localOnly ? "Sichere einen Moment mit F8. Deine lokalen Clips erscheinen hier." : "Sichere einen Moment mit F8. Deine Clips erscheinen hier, sobald der Upload fertig ist.";
  $("emptySessionButton").textContent = hasSavedClips ? "Filter zurücksetzen" : "Zur Aufnahme";
  clips.forEach((clip) => {
    const card = document.createElement("article"); card.className = "clip-library-card";
    card.append(thumbnail(clip, true));
    const body = document.createElement("div"); body.className = "clip-card-body";
    const heading = document.createElement("div"); heading.className = "clip-card-heading";
    const title = document.createElement("h3"); title.textContent = clip.name;
    const game = document.createElement("p"); game.textContent = clip.game || "Spielaufnahme";
    heading.append(title, game);
    const meta = document.createElement("div"); meta.className = "clip-card-details";
    const saved = document.createElement("span"); saved.textContent = clip.uploadedAt ? new Date(clip.uploadedAt).toLocaleString("de-DE", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : clip.date || "";
    const format = document.createElement("span"); format.textContent = `${clip.duration || (clip.durationSeconds ? formatDuration(clip.durationSeconds) : "—")} · ${clip.size || (clip.sizeBytes ? `${(clip.sizeBytes / 1048576).toFixed(1).replace(".", ",")} MB` : "Online")}`;
    meta.append(saved, format);
    const actions = document.createElement("div"); actions.className = "clip-card-actions";
    const play = document.createElement("button"); play.className = "clip-card-play"; play.type = "button"; play.disabled = !(clip.file || clip.mediaUrl); play.textContent = clip.mediaUrl ? "Vom Server ansehen" : "Abspielen"; play.addEventListener("click", () => playClip(clip));
    actions.append(play);
    if (!clip.mediaUrl) {
    const more = document.createElement("details"); more.className = "clip-card-more";
    const summary = document.createElement("summary"); summary.textContent = "···"; summary.title = `Weitere Aktionen für ${clip.name}`; summary.setAttribute("aria-label", `Weitere Aktionen für ${clip.name}`);
    const menu = document.createElement("div"); menu.className = "clip-actions-menu";
    const action = (label, callback, className = "") => {
      const button = document.createElement("button"); button.type = "button"; button.className = className; button.textContent = label;
      button.addEventListener("click", async () => { more.open = false; await callback(); });
      menu.append(button);
    };
    action("In Windows öffnen", () => fileAction(clip, "open"));
    action("Im Ordner anzeigen", () => fileAction(clip, "reveal"));
    action("Umbenennen", async () => {
      const nextName = window.prompt("Clip umbenennen", clip.name);
      if (!nextName || !nextName.trim()) return;
      try { await renameClipFile(clip, nextName.trim()); persistClips(); renderLibrary(); showToast("Clip umbenannt."); }
      catch (error) { showToast(error.message); }
    });
    action("Löschen", async () => {
      if (!window.confirm(`„${clip.name}“ dauerhaft löschen?`)) return;
      try { await deleteClipFile(clip); }
      catch (error) { showToast(error.message); return; }
      removeClip(clip.id);
    }, "is-danger");
    more.append(summary, menu);
    actions.append(more);
    }
    body.append(heading, meta, actions);
    card.append(body);
    list.append(card);
  });
}

function playClip(clip) {
  if (clip.mediaUrl) { openCloudClip(clip); return; }
  if (!clip.file || !window.location.protocol.startsWith("http")) { showToast("Dieser Eintrag verweist auf keine lokale Videodatei."); return; }
  const dialog = $("playbackDialog");
  const video = $("playbackVideo");
  $("playbackTitle").textContent = clip.name;
  video.src = `/api/clip/play?file=${encodeURIComponent(clip.file)}`;
  dialog.showModal();
  video.play().catch(() => showToast("Clip konnte nicht gestartet werden."));
}

async function fileAction(clip, action) {
  if (!clip.file || !window.location.protocol.startsWith("http")) { showToast(action === "reveal" ? "Explorer-Aktion wird an die native Bridge übergeben." : `Öffnen wird an die native Bridge übergeben: ${clip.name}`); return; }
  try {
    const response = await fetch("/api/file/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: clip.file, action }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Dateiaktion fehlgeschlagen");
    showToast(action === "reveal" ? "Clip im Explorer geöffnet." : "Clip geöffnet.");
  } catch (error) { showToast(error.message); }
}

async function renameClipFile(clip, nextName) {
  if (!clip.file || !window.location.protocol.startsWith("http")) { clip.name = nextName; return; }
  const response = await fetch("/api/file/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: clip.file, name: nextName }) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Umbenennen fehlgeschlagen");
  clip.file = payload.file;
  clip.name = payload.name;
}

async function deleteClipFile(clip) {
  if (!clip.file || !window.location.protocol.startsWith("http")) return;
  const response = await fetch("/api/file/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: clip.file }) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Löschen fehlgeschlagen");
}

function renameClip(id) {
  const clip = state.clips.find((item) => item.id === id);
  if (!clip) return;
  const nextName = window.prompt("Clip umbenennen", clip.name);
  if (!nextName || !nextName.trim()) return;
  clip.name = nextName.trim();
  persistClips();
  renderLibrary();
  showToast("Clip umbenannt.");
}

function removeClip(id) { state.clips = state.clips.filter((clip) => clip.id !== id); persistClips(); renderLibrary(); updateClipCount(); showToast("Clip aus der Bibliothek entfernt."); }
function updateClipCount() { $("clipCount").textContent = state.cloudClips.length + state.clips.length; }

function updateMetrics() {
  if (!state.metricsOn) return;
  if (!state.metricsLive) {
    $("cpuValue").textContent = "n/a";
    $("ramValue").textContent = "n/a";
    $("gpuValue").textContent = "n/a";
    return;
  }
}

function applyLiveMetrics(metrics) {
  state.metricsLive = true;
  const hostCpu = metrics.hostCpuPercent ?? metrics.cpuPercent;
  const formatCpu = (value) => value === null || value === undefined ? "n/a" : `${value.toFixed(2).replace(".", ",")}%`;
  $("cpuValue").textContent = `${formatCpu(hostCpu)} / ${formatCpu(metrics.engineCpuPercent)}`;
  $("ramValue").textContent = `${(metrics.ramBytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
  $("gpuValue").textContent = metrics.gpuAvailable && metrics.gpuPercent !== null ? `${metrics.gpuPercent.toFixed(2).replace(".", ",")}%` : "n/a";
  $("metricGrid").setAttribute("data-metric-source", metrics.gpuAvailable ? "local process + Windows GPU counter" : "local process; GPU counter pending");
  $("measurementNote").textContent = metrics.gpuAvailable
    ? "Host, FFmpeg und Windows-Audioaufnahme werden gemessen; der UI-Renderer ist nicht enthalten. GPU stammt vom Windows GPU Engine Counter."
    : "Host, FFmpeg und Windows-Audioaufnahme werden gemessen; der UI-Renderer ist nicht enthalten. GPU wird über den Windows GPU Engine Counter gelesen.";
}

async function pollLiveMetrics() {
  if (!state.metricsOn || !window.location.protocol.startsWith("http")) return;
  try {
    const response = await fetch("/api/metrics", { cache: "no-store" });
    if (!response.ok) throw new Error("metrics unavailable");
    applyLiveMetrics(await response.json());
  } catch {
    state.metricsLive = false;
    updateMetrics();
  }
}

function applySession(session) {
  state.sessionLive = true;
  state.sessionGame = session.game;
  state.sessionProcess = session.process;
  state.sessionProcessId = Number(session.processId) || null;
  state.sessionWindowTitle = session.windowTitle || null;
  updateSessionLogo(session);
  renderCaptureStatus();
}

function gameMonogram(game) {
  const marks = {
    "Counter-Strike 2": "CS2",
    Minecraft: "MC",
    Fortnite: "FN",
    VALORANT: "V",
    "Apex Legends": "APEX",
    "Overwatch 2": "OW",
    "Call of Duty": "COD",
    "Rainbow Six Siege": "R6",
    "PUBG: Battlegrounds": "PUBG",
    "Rocket League": "RL",
    "Grand Theft Auto V": "GTA",
    Rust: "RUST",
    Roblox: "RBLX",
    "League of Legends": "LOL",
    "Dota 2": "DOTA",
    "Forza Horizon 5": "FH5",
    Warframe: "WF",
    "Cyberpunk 2077": "2077",
    "Elden Ring": "ER",
    Terraria: "T"
  };
  return marks[game] || String(game || "GAME").replace(/[^A-Z0-9]/gi, "").slice(0, 4).toUpperCase() || "GAME";
}

function updateSessionLogo(session) {
  const image = $("sessionGameIcon");
  const fallback = $("sessionGameMonogram");
  const mark = $("sessionLogo");
  if (!image || !fallback || !mark) return;
  const processId = Number(session.processId) || null;
  const game = session.game || "Kein Spiel erkannt";
  fallback.textContent = gameMonogram(session.game);
  mark.title = game;
  if (state.sessionIconProcessId === processId) return;
  if (state.sessionIconLastAttemptProcessId !== processId) {
    state.sessionIconLastAttemptProcessId = processId;
    state.sessionIconLastAttemptAt = 0;
    state.sessionIconLoadingProcessId = null;
  }
  if (state.sessionIconProcessId !== processId) {
    image.removeAttribute("src");
    image.hidden = true;
    fallback.hidden = false;
  }
  if (!processId || !window.clipfarmNative?.getGameIcon || state.sessionIconLoadingProcessId === processId) return;
  if (Date.now() - state.sessionIconLastAttemptAt < 15000) return;
  state.sessionIconLastAttemptAt = Date.now();
  state.sessionIconLoadingProcessId = processId;
  window.clipfarmNative.getGameIcon(processId).then((icon) => {
    if (state.sessionProcessId !== processId) return;
    if (!icon) { state.sessionIconLoadingProcessId = null; return; }
    image.onload = () => {
      if (state.sessionProcessId !== processId) return;
      state.sessionIconProcessId = processId;
      state.sessionIconLoadingProcessId = null;
      image.hidden = false;
      fallback.hidden = true;
    };
    image.onerror = () => {
      state.sessionIconLoadingProcessId = null;
      image.hidden = true;
      fallback.hidden = false;
    };
    image.src = icon;
  }).catch(() => { state.sessionIconLoadingProcessId = null; });
}

function renderCaptureStatus() {
  const hasGame = Boolean(state.sessionGame);
  const method = state.engineCaptureMethod;
  const captureLabel = method === "display" ? "MONITOR" : method === "game" || method === "window" ? "SPIELFENSTER" : state.engineError ? "FEHLER" : "BEREIT";
  $("activeGameName").textContent = hasGame ? state.sessionGame : "Kein Spiel erkannt";
  $("captureMode").textContent = captureLabel;
  $("sessionShort").textContent = hasGame ? (state.sessionGame === "Counter-Strike 2" ? "CS2" : state.sessionGame.slice(0, 20)) : method === "display" ? "Desktop" : "Wartet auf Spiel";
  const captureWindow = state.sessionWindowTitle || (state.sessionProcess || "").replace(/\.exe$/i, "");
  const sessionDescription = hasGame ? "Fenster · " + captureWindow : method === "display" ? "Ganzer Monitor" : "Kein Spielprozess erkannt";
  $("sessionDetail").textContent = sessionDescription;
  $("sessionWindowDetail").textContent = sessionDescription;
  $("captureSignal").textContent = state.engineLive
    ? `PUFFER · ${state.bufferSeconds} SEK`
    : state.bufferSeconds > 0 ? `${state.bufferSeconds} SEK BEREIT` : state.autoStartPending ? "WARTET AUF SPIEL" : state.engineError ? "PUFFER FEHLER" : "PUFFER PAUSIERT";
  $("sessionCaptureStatus").textContent = $("captureSignal").textContent;
  $("engineCapturePath").textContent = method === "display" ? "Monitor" : method === "game" || method === "window" ? "Spielfenster" : "—";
}

function applyEngine(engine) {
  state.engineLive = engine.state === "running";
  state.autoStartPending = Boolean(engine.autoStartPending);
  state.replayOn = state.engineLive || state.autoStartPending;
  state.engineCaptureMethod = state.engineLive ? engine.captureMethod : null;
  state.engineError = engine.state === "error";
  state.bufferSeconds = Number(engine.bufferSeconds) || 0;
  state.postRollSeconds = Number(engine.postRollSeconds) || 2;
  applyConfig(engine.config);
  if (engine.state === "error" && engine.error && engine.error !== state.lastEngineError) {
    state.lastEngineError = engine.error;
    showToast(engine.error);
  } else if (engine.state !== "error") {
    state.lastEngineError = null;
  }
  $("engineStateLabel").textContent = state.engineLive ? "Engine aktiv" : state.autoStartPending ? "Wartet auf Spiel" : engine.state === "error" ? "Engine Fehler" : "Engine bereit";
  $("captureContextLabel").textContent = state.engineLive ? "Aufnahme läuft" : state.autoStartPending ? "Startet bei sichtbarem Spiel" : engine.state === "error" ? "Aufnahmefehler" : "Aufnahme bereit";
  for (const id of ["engineStatusDot", "captureContextDot"]) {
    const dot = $(id);
    dot.classList.toggle("is-active", state.engineLive);
    dot.classList.toggle("is-error", state.engineError);
  }
  $("toggleReplayButton").textContent = state.engineLive || state.autoStartPending ? "Puffer stoppen" : "Puffer starten";
  if (typeof engine.micEnabled === "boolean") {
    state.micOn = engine.micEnabled;
    $("micSwitch").classList.toggle("is-on", state.micOn);
    $("micSwitch").setAttribute("aria-pressed", String(state.micOn));
    $("microphoneSettingSwitch").classList.toggle("is-on", state.micOn);
    $("microphoneSettingSwitch").setAttribute("aria-pressed", String(state.micOn));
  }
}

function beginHotkeyCapture(name) {
  state.hotkeyCapture = name;
  showToast("Drücke jetzt die gewünschte Taste oder Tastenkombination.");
}

async function finishHotkeyCapture(event) {
  if (!state.hotkeyCapture) return false;
  event.preventDefault();
  event.stopPropagation();
  const value = eventHotkeySpec(event);
  if (!value) return true;
  const name = state.hotkeyCapture;
  state.hotkeyCapture = null;
  const hotkeys = { ...state.hotkeys, [name]: value };
  await updateEngineConfig("hotkeys", hotkeys);
  return true;
}

async function updateEngineConfig(key, value) {
  if (!window.location.protocol.startsWith("http")) {
    applyConfig({ ...(state.config || {}), [key]: value });
    return;
  }
  const previousHotkeys = key === "hotkeys" ? { ...state.hotkeys } : null;
  try {
    const response = await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [key]: value }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Einstellung konnte nicht gespeichert werden");
    applyEngine(payload.engine);
    if (key === "hotkeys" && window.clipfarmNative?.syncHotkeys) {
      const shortcutState = await window.clipfarmNative.syncHotkeys(value);
      if (shortcutState.failed.length) {
        await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hotkeys: previousHotkeys }) });
        applyConfig({ ...(state.config || {}), hotkeys: previousHotkeys });
        const status = shortcutState.restored ? "Vorherige Hotkeys bleiben aktiv." : "Hotkeys konnten nicht registriert werden.";
        showToast(`${shortcutState.failed.join(", ")} ist bereits belegt. ${status}`);
        return;
      }
      showToast("Globale Hotkeys gespeichert.");
      return;
    }
    showToast(key === "hotkeys" ? "Hotkeys gespeichert." : "Aufnahme-Einstellung gespeichert.");
  } catch (error) {
    showToast(error.message);
    pollEngine();
  }
}

async function toggleMicrophone() {
  if (!window.location.protocol.startsWith("http")) { state.micOn = toggleSwitch($("micSwitch")); return; }
  try {
    const response = await fetch("/api/audio/mic", { method: "POST" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Mikrofon konnte nicht umgeschaltet werden");
    state.micOn = payload.micEnabled;
    $("micSwitch").classList.toggle("is-on", state.micOn);
    $("micSwitch").setAttribute("aria-pressed", String(state.micOn));
    $("microphoneSettingSwitch").classList.toggle("is-on", state.micOn);
    $("microphoneSettingSwitch").setAttribute("aria-pressed", String(state.micOn));
    showToast(state.micOn ? "Mikrofon aktiviert." : "Mikrofon stummgeschaltet.");
  } catch (error) { showToast(error.message); }
}

async function setEngine(shouldRun) {
  if (!window.location.protocol.startsWith("http")) {
    state.replayOn = shouldRun;
    updateReplayUI();
    return;
  }
  try {
    const endpoint = shouldRun ? "/api/engine/start" : "/api/engine/stop";
    const response = await fetch(endpoint, { method: "POST" });
    const engine = await response.json();
    if (!response.ok) throw new Error(engine.error || "Capture Engine konnte nicht geändert werden");
    applyEngine(engine);
    state.replayOn = shouldRun;
    updateReplayUI();
    const methodLabel = engine.captureMethod === "game" ? "Spielfenster" : engine.captureMethod === "window" ? "Fensteraufnahme" : "Monitoraufnahme";
    showToast(shouldRun ? `${methodLabel} und Replay-Puffer aktiv.` : "Replay-Puffer pausiert.");
  } catch (error) { showToast(error.message); }
}

async function pollEngine() {
  if (!window.location.protocol.startsWith("http")) return;
  try {
    const response = await fetch("/api/engine", { cache: "no-store" });
    if (!response.ok) throw new Error("engine unavailable");
    applyEngine(await response.json());
  } catch { state.engineLive = false; }
}

async function pollBackendStatus() {
  if (state.backendCheckInFlight) return;
  state.backendCheckInFlight = true;
  try {
    if (!window.clipfarmNative?.getBackendStatus) throw new Error('Der Serverstatus ist nur in der sicheren Electron-Oberfläche verfügbar.');
    const status = await window.clipfarmNative.getBackendStatus();
    state.backendStatus = status;
    if (status.available && state.account && !state.feed.length) await loadCommunityFeed();
    if (state.account && !status.available && !state.feed.length) {
      state.feedError = status.message;
      renderCommunityFeed();
    }
  } catch (error) {
    state.backendStatus = null;
    if (state.account && !state.feed.length) {
      state.feedError = error.message;
      renderCommunityFeed();
    }
  } finally {
    state.backendCheckInFlight = false;
  }
}
function setAuthMode(mode) {
  state.authMode = mode === 'register' ? 'register' : 'login';
  const registering = state.authMode === 'register';
  $('loginModeButton').classList.toggle('is-selected', !registering);
  $('registerModeButton').classList.toggle('is-selected', registering);
  $('loginModeButton').setAttribute('aria-selected', String(!registering));
  $('registerModeButton').setAttribute('aria-selected', String(registering));
  $('authFormTitle').textContent = registering ? 'Konto erstellen' : 'Willkommen zurück';
  $('authSubmitButton').textContent = registering ? 'Konto erstellen' : 'Anmelden';
  $('authPassword').autocomplete = registering ? 'new-password' : 'current-password';
  $('authError').hidden = true;
}

function paintSidebarAvatar(account) {
  const avatar = $('sidebarAvatar');
  if (!avatar) return;
  avatar.replaceChildren();
  if (account?.avatarUrl) {
    const image = document.createElement('img');
    image.src = account.avatarUrl;
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    avatar.append(image);
  } else {
    avatar.textContent = String(account?.displayName || account?.username || 'C').trim().charAt(0).toUpperCase() || 'C';
  }
}

function renderProfile(profile) {
  if (!profile) return;
  $('profileUsername').textContent = '@' + (profile.username || state.account?.username || 'username');
  $('profileDisplayName').value = profile.displayName || profile.username || '';
  $('profileBio').value = profile.bio || '';
  $('profileBioCount').textContent = String(($('profileBio').value || '').length);
  const preview = $('profileAvatarPreview');
  const fallback = $('profileAvatarFallback');
  fallback.textContent = String(profile.displayName || profile.username || 'C').trim().charAt(0).toUpperCase() || 'C';
  if (profile.avatarUrl) {
    preview.src = profile.avatarUrl + (profile.avatarUrl.includes('?') ? '&' : '?') + 'v=' + Date.now();
    preview.hidden = false;
    fallback.hidden = true;
  } else {
    preview.removeAttribute('src');
    preview.hidden = true;
    fallback.hidden = false;
  }
  paintSidebarAvatar(profile);
  $('accountStatusLabel').textContent = profile.displayName || profile.username;
  $('accountStatusDetail').textContent = '@' + profile.username;
  $('shareClipsSwitch').classList.toggle('is-on', profile.shareClips !== false);
  $('shareClipsSwitch').setAttribute('aria-pressed', String(profile.shareClips !== false));
  $('localOnlySwitch').classList.toggle('is-on', profile.localOnly === true);
  $('localOnlySwitch').setAttribute('aria-pressed', String(profile.localOnly === true));
}

async function loadProfile() {
  if (!state.account || !window.clipfarmNative?.getProfile) return;
  $('profileSaveStatus').textContent = 'Profil wird geladen …';
  try {
    state.profile = await window.clipfarmNative.getProfile();
    renderProfile(state.profile);
    $('profileSaveStatus').textContent = '';
    await syncDiskClips();
  } catch (error) {
    $('profileSaveStatus').textContent = error.message || 'Profil konnte nicht geladen werden.';
  }
}

async function loadLibraryClips() {
  if (!state.account || state.cloudLibraryLoading || !window.clipfarmNative?.getMyClips) return;
  state.cloudLibraryLoading = true;
  try {
    const clips = [];
    let cursor = null;
    do {
      const page = await window.clipfarmNative.getMyClips(cursor);
      for (const item of page.clips || []) {
        const when = new Date(item.uploadedAt);
        clips.push({
          id: item.id,
          name: item.title || 'Spielmoment',
          game: item.game || 'Unbekanntes Spiel',
          uploadedAt: item.uploadedAt,
          durationSeconds: item.durationSeconds,
          sizeBytes: item.sizeBytes,
          creator: item.creator,
          mediaUrl: item.mediaUrl,
          date: Number.isNaN(when.getTime()) ? '' : when.toLocaleString('de-DE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
          cloud: true
        });
      }
      cursor = page.nextCursor || null;
    } while (cursor);
    state.cloudClips = clips;
  } catch (error) {
    if (!state.cloudClips.length) showToast(error.message || 'Deine Online-Clips konnten nicht geladen werden.');
  } finally {
    state.cloudLibraryLoading = false;
    renderLibrary();
    updateClipCount();
  }
}

async function saveProfile() {
  if (!state.profile || !window.clipfarmNative?.updateProfile) return;
  const button = $('saveProfileButton');
  const status = $('profileSaveStatus');
  button.disabled = true;
  status.textContent = 'Änderungen werden gespeichert …';
  const update = {
    displayName: $('profileDisplayName').value.trim(),
    bio: $('profileBio').value.trim(),
    shareClips: state.profile.shareClips !== false,
    localOnly: state.profile.localOnly === true
  };
  if (state.pendingAvatarData !== undefined) update.avatarData = state.pendingAvatarData;
  try {
    state.profile = await window.clipfarmNative.updateProfile(update);
    state.pendingAvatarData = undefined;
    renderProfile(state.profile);
    status.textContent = 'Profil gespeichert.';
    await loadCommunityFeed();
    await loadLibraryClips();
  } catch (error) {
    status.textContent = error.message || 'Das Profil konnte nicht gespeichert werden.';
  } finally { button.disabled = false; }
}

async function savePrivacySettings() {
  if (!state.profile || !window.clipfarmNative?.updateProfile) return;
  const status = $('privacySaveStatus');
  const buttons = [$('shareClipsSwitch'), $('localOnlySwitch')];
  buttons.forEach((button) => { button.disabled = true; });
  status.textContent = 'Datenschutzeinstellungen werden gespeichert …';
  try {
    state.profile = await window.clipfarmNative.updateProfile({
      displayName: state.profile.displayName || state.profile.username,
      bio: state.profile.bio || '',
      shareClips: $('shareClipsSwitch').classList.contains('is-on'),
      localOnly: $('localOnlySwitch').classList.contains('is-on')
    });
    renderProfile(state.profile);
    status.textContent = 'Einstellungen gespeichert.';
    await loadCommunityFeed();
    if (state.profile.localOnly) await syncDiskClips();
  } catch (error) {
    status.textContent = error.message || 'Einstellungen konnten nicht gespeichert werden.';
    renderProfile(state.profile);
  } finally { buttons.forEach((button) => { button.disabled = false; }); }
}

function applyAccount(user, loadFeed = true) {
  state.account = user && typeof user.username === 'string' ? { id: user.id, username: user.username, displayName: user.displayName || user.username, avatarUrl: user.avatarUrl || null } : null;
  const signedIn = Boolean(state.account);
  $('accountGate').hidden = signedIn;
  $('appShell').hidden = !signedIn;
  $('logoutButton').hidden = !signedIn;
  $('accountStatusLabel').textContent = signedIn ? state.account.displayName : 'Nicht angemeldet';
  $('accountStatusDetail').textContent = signedIn ? '@' + state.account.username : 'Mein Profil';
  paintSidebarAvatar(state.account);
  $('profileUsername').textContent = signedIn ? '@' + state.account.username : '@username';
  if (!signedIn) {
    state.profile = null;
    state.cloudClips = [];
    state.feed = [];
    state.feedCursor = null;
    state.feedHasMore = false;
    state.feedError = '';
    renderCommunityFeed();
    renderLibrary();
    $('authUsername').focus();
  } else {
    if (loadFeed) loadProfile();
    if (loadFeed) loadCommunityFeed();
  }
}

async function initializeAccount() {
  try {
    if (!window.clipfarmNative?.getAccount) throw new Error('Melde dich in der Clipfarm-Desktop-App an.');
    const result = await window.clipfarmNative.getAccount();
    applyAccount(result?.user || null, false);
    if (result?.offline && result.user) {
      state.feedError = 'Die gespeicherte Sitzung ist vorhanden, der Server ist aber gerade nicht erreichbar.';
      renderCommunityFeed();
    }
  } catch (error) {
    applyAccount(null, false);
    $('accountGateStatus').lastElementChild.textContent = error.message;
  }
  await refreshUploadQueue();
  pollBackendStatus();
  if (state.account) {
    await loadProfile();
    loadCommunityFeed();
  }
}

async function submitAccount(event) {
  event.preventDefault();
  if (state.authBusy) return;
  const username = $('authUsername').value.trim();
  const password = $('authPassword').value;
  const errorNode = $('authError');
  const button = $('authSubmitButton');
  errorNode.hidden = true;
  state.authBusy = true;
  button.disabled = true;
  button.classList.add('is-busy');
  button.textContent = state.authMode === 'register' ? 'Konto wird erstellt' : 'Anmeldung läuft';
  try {
    if (!window.clipfarmNative?.login) throw new Error('Die sichere Anmeldung ist nur in der Clipfarm-Desktop-App verfügbar.');
    const account = await window.clipfarmNative.login(state.authMode, { username, password });
    $('accountForm').reset();
    applyAccount(account, false);
    showToast(state.authMode === 'register' ? 'Dein Konto ist bereit.' : 'Du bist angemeldet.');
    await refreshUploadQueue();
    await loadProfile();
    await loadCommunityFeed();
  } catch (error) {
    errorNode.textContent = error.message || 'Die Anmeldung ist fehlgeschlagen.';
    errorNode.hidden = false;
    $('authPassword').focus();
  } finally {
    state.authBusy = false;
    button.disabled = false;
    button.classList.remove('is-busy');
    button.textContent = state.authMode === 'register' ? 'Konto erstellen' : 'Anmelden';
  }
}

function renderCommunityFeed() {
  const list = $('cloudClipList');
  list.replaceChildren();
  for (const clip of state.feed) {
    const article = document.createElement('article');
    article.className = 'cloud-clip';
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'cloud-clip-preview';
    play.setAttribute('aria-label', 'Clip abspielen: ' + clip.title);
    play.addEventListener('click', () => openCloudClip(clip));
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'icon');
    icon.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', './assets/clipfarm-icons.svg#play');
    icon.append(use);
    const game = document.createElement('span');
    game.className = 'cloud-clip-game';
    game.textContent = clip.game || 'Unbekanntes Spiel';
    const duration = document.createElement('span');
    duration.className = 'cloud-clip-duration';
    duration.textContent = formatDuration(clip.durationSeconds);
    play.append(icon, game, duration);

    const copy = document.createElement('div');
    copy.className = 'cloud-clip-copy';
    const author = document.createElement('div');
    author.className = 'cloud-clip-author';
    const avatar = document.createElement('span');
    avatar.className = 'cloud-clip-avatar';
    const avatarLabel = String(clip.creator || clip.creatorUsername || '?').trim().charAt(0).toUpperCase() || '?';
    const expectedOrigin = state.backendStatus?.origin || 'https://benni-projects.de';
    try {
      const avatarUrl = new URL(clip.creatorAvatarUrl);
      if (avatarUrl.origin === expectedOrigin) {
        const image = document.createElement('img');
        image.src = avatarUrl.href;
        image.alt = '';
        image.loading = 'lazy';
        image.decoding = 'async';
        image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => { avatar.replaceChildren(); avatar.textContent = avatarLabel; }, { once: true });
        avatar.append(image);
      } else avatar.textContent = avatarLabel;
    } catch { avatar.textContent = avatarLabel; }
    const authorCopy = document.createElement('div');
    authorCopy.className = 'cloud-clip-author-copy';
    const creator = document.createElement('strong');
    creator.textContent = clip.creator || 'Unbekannter Spieler';
    const handle = document.createElement('span');
    handle.textContent = '@' + (clip.creatorUsername || clip.creator || 'unbekannt');
    authorCopy.append(creator, handle);
    author.append(avatar, authorCopy);
    const title = document.createElement('h3');
    title.textContent = clip.title || 'Spielmoment';
    const byline = document.createElement('div');
    byline.className = 'cloud-clip-byline';
    const uploaded = document.createElement('time');
    uploaded.dateTime = clip.uploadedAt || '';
    const date = new Date(clip.uploadedAt);
    uploaded.textContent = Number.isNaN(date.getTime()) ? 'Upload-Zeit unbekannt' : 'Hochgeladen ' + date.toLocaleString('de-DE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    byline.append(uploaded);
    const details = document.createElement('p');
    const gameTag = document.createElement('span');
    gameTag.className = 'cloud-clip-game-tag';
    gameTag.textContent = clip.game || 'Unbekanntes Spiel';
    const durationTag = document.createElement('span');
    durationTag.className = 'cloud-clip-duration-tag';
    durationTag.textContent = formatDuration(clip.durationSeconds);
    details.append(gameTag, durationTag);
    copy.append(author, title, byline, details);
    article.append(play, copy);
    list.append(article);
  }

  $('feedLoading').hidden = !state.feedLoading;
  $('feedError').hidden = !state.feedError;
  $('feedError').textContent = state.feedError;
  const empty = $('feedEmpty');
  empty.hidden = state.feedLoading || state.feed.length > 0 || Boolean(state.feedError);
  if (state.feed.length === 0 && !state.feedError) {
    $('feedEmptyTitle').textContent = state.account ? 'Noch keine Clips im Feed' : 'Melde dich an, um den Feed zu öffnen';
    $('feedEmptyText').textContent = state.account
      ? 'Sobald Spieler Clips hochladen, erscheinen sie hier. Der Name neben jedem Clip zeigt, wer ihn aufgenommen hat.'
      : 'Melde dich an, damit du Spielmomente aus der Community ansehen kannst.';
  }
  $('loadMoreClipsButton').hidden = !state.feedHasMore || !state.account;
  $('loadMoreClipsButton').disabled = state.feedLoading;
  $('refreshFeedButton').disabled = state.feedLoading;
}

async function loadCommunityFeed(append = false) {
  if (!state.account || state.feedLoading || (append && !state.feedHasMore)) return;
  state.feedLoading = true;
  state.feedError = '';
  renderCommunityFeed();
  try {
    if (!window.clipfarmNative?.getFeed) throw new Error('Der Community-Feed ist nur in der sicheren Desktop-App verfügbar.');
    const page = await window.clipfarmNative.getFeed(append ? state.feedCursor : null);
    const incoming = Array.isArray(page.clips) ? page.clips : [];
    if (append) {
      const known = new Set(state.feed.map((clip) => clip.id));
      state.feed = [...state.feed, ...incoming.filter((clip) => !known.has(clip.id))];
    } else {
      state.feed = incoming;
    }
    state.feedCursor = page.nextCursor || null;
    state.feedHasMore = Boolean(page.nextCursor);
  } catch (error) {
    state.feedError = error.message || 'Der Community-Feed konnte nicht geladen werden.';
  } finally {
    state.feedLoading = false;
    renderCommunityFeed();
  }
}

function openCloudClip(clip) {
  if (!clip.mediaUrl || !clip.mediaUrl.startsWith('https://')) {
    showToast('Dieser Clip hat keine sichere Wiedergabeadresse.');
    return;
  }
  $('playbackKind').textContent = 'COMMUNITY-CLIP';
  $('playbackTitle').textContent = clip.title || 'Spielmoment';
  const video = $('playbackVideo');
  video.preload = 'none';
  video.src = clip.mediaUrl;
  $('playbackDialog').showModal();
  video.play().catch(() => showToast('Clip konnte nicht gestartet werden.'));
}

function uploadStatusText(item) {
  if (item.status === 'uploading') return 'Upload läuft · ' + item.progress + '%';
  if (item.status === 'retrying') return 'Verbindung unterbrochen · erneuter Versuch';
  if (item.status === 'waiting-auth') return 'Wartet auf Anmeldung';
  if (item.status === 'failed') return 'Upload fehlgeschlagen';
  return 'Wartet auf Upload';
}

function renderUploadQueue() {
  const panel = $('uploadQueuePanel');
  const list = $('uploadQueueList');
  const items = state.uploadQueue || [];
  panel.hidden = items.length === 0;
  $('uploadQueueCount').textContent = String(items.length);
  list.replaceChildren();
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'upload-row';
    row.dataset.state = item.status;
    const main = document.createElement('div');
    main.className = 'upload-row-main';
    const title = document.createElement('strong');
    title.textContent = item.title || 'Spielmoment';
    const game = document.createElement('span');
    game.textContent = item.game || 'Spiel';
    main.append(title, game);
    const stateLabel = document.createElement('div');
    stateLabel.className = 'upload-row-state';
    stateLabel.textContent = uploadStatusText(item);
    if (item.status === 'failed' && item.retryable && window.clipfarmNative?.retryUpload) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'upload-retry';
      retry.textContent = 'Erneut versuchen';
      retry.addEventListener('click', () => retryCommunityUpload(item.id));
      stateLabel.append(retry);
    }
    const progress = document.createElement('progress');
    progress.className = 'upload-progress';
    progress.max = 100;
    progress.value = Number(item.progress) || 0;
    progress.setAttribute('aria-label', 'Upload-Fortschritt für ' + (item.title || 'Spielmoment'));
    row.append(main, stateLabel, progress);
    if (item.error) {
      const error = document.createElement('p');
      error.className = 'upload-row-error';
      error.textContent = item.error;
      row.append(error);
    }
    list.append(row);
  }
}

async function refreshUploadQueue() {
  if (!window.clipfarmNative?.getUploadQueue) return;
  try {
    state.uploadQueue = await window.clipfarmNative.getUploadQueue();
    renderUploadQueue();
  } catch { /* A broken upload queue must not stop local capture. */ }
}

async function retryCommunityUpload(id) {
  try {
    await window.clipfarmNative.retryUpload(id);
    await refreshUploadQueue();
  } catch (error) { showToast(error.message); }
}

function handleUploadUpdate(update) {
  if (update && Array.isArray(update.items)) {
    state.uploadQueue = update.items;
    renderUploadQueue();
  }
}

function handleUploadCommitted(result) {
  if (result?.localFile) {
    state.clips = state.clips.filter((clip) => clip.file !== result.localFile);
    persistClips();
    renderLibrary();
    updateClipCount();
  }
  state.cloudLibraryLoading = false;
  loadLibraryClips();
  loadCommunityFeed();
  if (result?.cleanupWarning) showToast(result.cleanupWarning);
  else showToast('Clip erfolgreich hochgeladen und aus der lokalen Arbeitskopie entfernt.');
}

async function signOut() {
  const button = $('logoutButton');
  button.disabled = true;
  try {
    await window.clipfarmNative.logout();
    applyAccount(null, false);
    showToast('Du wurdest abgemeldet.');
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
}
async function syncDiskClips() {
  if (!window.location.protocol.startsWith("http")) return;
  if (state.profile && !state.profile.localOnly) return;
  try {
    const response = await fetch("/api/clips", { cache: "no-store" });
    if (!response.ok) throw new Error("clip library unavailable");
    const payload = await response.json();
    const diskClips = payload.clips.map((clip) => ({
      id: clip.file,
      file: clip.file,
      name: clip.name,
      game: clip.game || clip.name.split("_")[0] || "Game",
      date: new Date(clip.savedAt).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
      duration: clip.seconds ? `00:${String(clip.seconds).padStart(2, "0")}` : "n/a",
      resolution: clip.resolution || "n/a",
      fps: clip.fps || "n/a",
      size: `${(clip.sizeBytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`,
      thumbnail: clip.thumbnail,
      tone: "orange"
    }));
    state.clips = [...diskClips, ...state.clips.filter((clip) => !clip.file)];
    persistClips();
    updateClipCount();
    if (state.activeView === "library") renderLibrary();
  } catch { /* localStorage remains the offline fallback */ }
}

async function pollSession() {
  if (!window.location.protocol.startsWith("http")) return;
  try {
    const response = await fetch("/api/session", { cache: "no-store" });
    if (!response.ok) throw new Error("session unavailable");
    applySession(await response.json());
  } catch {
    state.sessionLive = false;
  }
}

async function pollAudioDevices() {
  if (!window.location.protocol.startsWith("http")) return;
  try {
    const response = await fetch("/api/audio/devices", { cache: "no-store" });
    if (!response.ok) throw new Error("audio devices unavailable");
    const payload = await response.json();
    const select = $("microphoneDeviceSelect");
    if (!select) return;
    const selected = payload.selected || "";
    select.replaceChildren();
    if (!payload.devices.length) {
      select.add(new Option(payload.error || "Kein Windows-Mikrofon gefunden", ""));
      return;
    }
    payload.devices.forEach((device) => select.add(new Option(`${device.name}${device.isDefault ? " · Windows-Standard" : ""}`, device.id)));
    select.value = selected && payload.devices.some((device) => device.id === selected) ? selected : payload.devices.find((device) => device.isDefault)?.id || payload.devices[0].id;
  } catch { /* the recording engine keeps its existing audio selection */ }
}

document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
document.querySelectorAll("[data-view-link]").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); setView(link.dataset.viewLink); }));
$("goToSessionButton").addEventListener("click", () => setView("session"));
$("openSessionButton").addEventListener("click", () => setView("session"));
$("emptySessionButton").addEventListener("click", () => {
  if (!state.clips.length && !state.cloudClips.length) { setView("session"); return; }
  $("clipSearch").value = "";
  state.filter = "all";
  document.querySelectorAll(".filter-button").forEach((button) => {
    const selected = button.dataset.filter === "all";
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  renderLibrary();
});
$("accountForm").addEventListener("submit", submitAccount);
$("loginModeButton").addEventListener("click", () => setAuthMode("login"));
$("registerModeButton").addEventListener("click", () => setAuthMode("register"));
$("logoutButton").addEventListener("click", signOut);
$("profileButton").addEventListener("click", () => setView("profile"));
$("profileForm").addEventListener("submit", (event) => { event.preventDefault(); saveProfile(); });
$("passwordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const currentPassword = $("currentPasswordInput").value;
  const newPassword = $("newPasswordInput").value;
  const status = $("passwordSaveStatus");
  const button = $("savePasswordButton");
  if (newPassword !== $("confirmPasswordInput").value) { status.textContent = "Die neuen Passwörter stimmen nicht überein."; return; }
  if (!window.clipfarmNative?.changePassword) { status.textContent = "Passwortänderung ist nicht verfügbar."; return; }
  button.disabled = true;
  status.textContent = "Passwort wird geändert …";
  try {
    await window.clipfarmNative.changePassword(currentPassword, newPassword);
    $("passwordForm").reset();
    status.textContent = "Passwort geändert.";
  } catch (error) { status.textContent = error.message || "Passwort konnte nicht geändert werden."; }
  finally { button.disabled = false; }
});
$("profileBio").addEventListener("input", () => { $("profileBioCount").textContent = String($("profileBio").value.length); });
$("profileAvatarInput").addEventListener("change", () => {
  const file = $("profileAvatarInput").files?.[0];
  if (!file) return;
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 1_500_000) {
    $("profileSaveStatus").textContent = "Bitte wähle ein PNG-, JPG- oder WebP-Bild bis 1,5 MB.";
    $("profileAvatarInput").value = "";
    return;
  }
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    state.pendingAvatarData = String(reader.result || "");
    $("profileAvatarPreview").src = state.pendingAvatarData;
    $("profileAvatarPreview").hidden = false;
    $("profileAvatarFallback").hidden = true;
    $("profileSaveStatus").textContent = "Bild bereit. Speichere dein Profil, um es zu übernehmen.";
  });
  reader.readAsDataURL(file);
});
$("clearProfileAvatarButton").addEventListener("click", () => {
  state.pendingAvatarData = null;
  $("profileAvatarPreview").removeAttribute("src");
  $("profileAvatarPreview").hidden = true;
  $("profileAvatarFallback").hidden = false;
  $("profileAvatarInput").value = "";
});
$("shareClipsSwitch").addEventListener("click", () => { toggleSwitch($("shareClipsSwitch")); savePrivacySettings(); });
$("localOnlySwitch").addEventListener("click", () => { toggleSwitch($("localOnlySwitch")); savePrivacySettings(); });
$("refreshFeedButton").addEventListener("click", () => loadCommunityFeed());
$("loadMoreClipsButton").addEventListener("click", () => loadCommunityFeed(true));
$("saveClipButton").addEventListener("click", saveClip);
$("toggleReplayButton").addEventListener("click", () => setEngine(!(state.engineLive || state.autoStartPending)));
$("micSwitch").addEventListener("click", toggleMicrophone);
$("gameAudioSwitch").addEventListener("click", () => updateEngineConfig("gameAudio", !$("gameAudioSwitch").classList.contains("is-on")));
$("gameAudioSettingsSwitch").addEventListener("click", () => updateEngineConfig("gameAudio", !$("gameAudioSettingsSwitch").classList.contains("is-on")));
$("separateTracksSwitch").addEventListener("click", () => updateEngineConfig("separateTracks", !$("separateTracksSwitch").classList.contains("is-on")));
$("metricsToggle").addEventListener("click", () => { state.metricsOn = !state.metricsOn; $("metricGrid").hidden = !state.metricsOn; $("metricsToggle").textContent = state.metricsOn ? "Ausblenden" : "Einblenden"; });
$("openSettingsButton").addEventListener("click", () => setView("settings"));
$("clipSearch").addEventListener("input", renderLibrary);
$("replayLengthSelect").addEventListener("change", (event) => updateEngineConfig("replayLength", Number(event.target.value)));
$("resolutionSelect").addEventListener("change", (event) => updateEngineConfig("resolution", event.target.value));
$("fpsSelect").addEventListener("change", (event) => updateEngineConfig("fps", Number(event.target.value)));
$("bitrateSelect").addEventListener("change", (event) => updateEngineConfig("bitrate", event.target.value));
$("encoderSelect").addEventListener("change", (event) => updateEngineConfig("encoder", event.target.value));
$("qualitySelect").addEventListener("change", (event) => updateEngineConfig("quality", event.target.value));
$("captureMethodSelect").addEventListener("change", (event) => updateEngineConfig("captureMethod", event.target.value));
$("testOverlayButton").addEventListener("click", async () => {
  try {
    await window.clipfarmNative.notifyClipOutcome({ outcome: "test", message: "Diese lokale Testmeldung wurde angezeigt." });
  } catch {
    showToast("Das Overlay konnte nicht gestartet werden.");
  }
});
$("microphoneDeviceSelect").addEventListener("change", (event) => updateEngineConfig("microphoneDevice", event.target.value || null));
$("microphoneVolumeSelect").addEventListener("change", (event) => updateEngineConfig("microphoneVolume", Number(event.target.value)));
$("clipDirectoryInput").addEventListener("change", (event) => updateEngineConfig("clipDirectory", event.target.value.trim()));
$("bufferDirectoryInput").addEventListener("change", (event) => updateEngineConfig("bufferDirectory", event.target.value.trim()));
$("maxStorageSelect").addEventListener("change", (event) => updateEngineConfig("maxStorageGb", Number(event.target.value)));
$("cleanupPolicySelect").addEventListener("change", (event) => updateEngineConfig("cleanupPolicy", event.target.value));
$("backgroundPrioritySwitch").addEventListener("click", () => updateEngineConfig("backgroundPriority", !$("backgroundPrioritySwitch").classList.contains("is-on")));
$("replayLengthButton").addEventListener("click", () => { setView("settings"); showToast("Replay-Länge geöffnet."); });
document.querySelectorAll("[data-hotkey-name]").forEach((button) => button.addEventListener("click", () => beginHotkeyCapture(button.dataset.hotkeyName)));
const settingsTabs = [...document.querySelectorAll(".settings-tab")];
const settingsTabList = document.querySelector(".settings-nav");
function activateSettingsTab(tab) {
  settingsTabs.forEach((item) => {
    const selected = item === tab;
    item.classList.toggle("is-active", selected);
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll(".settings-group").forEach((group) => group.classList.toggle("is-active", group.dataset.settingsGroup === tab.dataset.settingsTab));
}
settingsTabs.forEach((tab) => {
  tab.tabIndex = tab.classList.contains("is-active") ? 0 : -1;
  tab.addEventListener("click", () => activateSettingsTab(tab));
});
settingsTabList?.addEventListener("keydown", (event) => {
  const currentIndex = settingsTabs.indexOf(document.activeElement);
  if (currentIndex < 0) return;
  let nextIndex = currentIndex;
  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % settingsTabs.length;
  else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + settingsTabs.length) % settingsTabs.length;
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = settingsTabs.length - 1;
  else return;
  event.preventDefault();
  settingsTabs[nextIndex].focus();
  activateSettingsTab(settingsTabs[nextIndex]);
});
function renderAppInfo(info) {
  if (!info) return;
  const version = `v${info.version || "—"}`;
  $("appInfoVersion").textContent = version;
  $("appInfoInstalledVersion").textContent = version;
  $("appInfoLatestVersion").textContent = info.latestVersion ? `v${info.latestVersion}` : "Noch nicht geprüft";
  $("appInfoPlatform").textContent = [info.platform, info.architecture].filter(Boolean).join(" · ");
  $("appInfoElectron").textContent = info.electronVersion || "—";
  $("appInfoUpdater").textContent = info.updaterIncluded ? "Im Installationspaket enthalten" : "Nur in der Windows-App";
  $("appInfoReleaseDate").textContent = info.publishedAt
    ? new Intl.DateTimeFormat("de-DE", { dateStyle: "medium" }).format(new Date(info.publishedAt))
    : "—";

  const statusLabels = {
    checking: "Suche nach Releases …",
    current: "Clipfarm ist aktuell",
    available: `Version v${info.latestVersion || ""} verfügbar`,
    installing: "Updater wird gestartet …",
    "updater-error": "Update erkannt, Updater konnte nicht starten",
    unavailable: "GitHub gerade nicht erreichbar",
    unsupported: "Für dieses System nicht verfügbar",
    development: "Automatische Prüfung beim Start"
  };
  const status = $("appInfoUpdateStatus");
  status.textContent = statusLabels[info.updateStatus] || "Status wird geprüft";
  status.dataset.state = info.updateStatus || "unknown";
  $("availableUpdate").hidden = info.updateStatus !== "available";
  if (info.updateStatus === "available") $("availableUpdateText").textContent = `Clipfarm ${info.latestVersion} ist bereit zur Installation.`;
  if (info.updateError) status.title = info.updateError;
  else status.removeAttribute("title");
}

async function loadAppInfo() {
  if (!window.clipfarmNative?.getAppInfo) return;
  try { renderAppInfo(await window.clipfarmNative.getAppInfo()); }
  catch { $("appInfoUpdateStatus").textContent = "Versionsdetails nicht verfügbar"; }
}

const checkForUpdatesButton = $("checkForUpdatesButton");
checkForUpdatesButton?.addEventListener("click", async () => {
  if (!window.clipfarmNative?.checkForUpdates) {
    showToast("Die Update-Prüfung ist nur in der Desktop-App verfügbar.");
    return;
  }
  checkForUpdatesButton.disabled = true;
  const label = checkForUpdatesButton.querySelector("span");
  const previousLabel = label.textContent;
  label.textContent = "Prüfe GitHub …";
  try {
    const info = await window.clipfarmNative.checkForUpdates();
    renderAppInfo(info);
    if (info.updateStatus === "current") showToast("Clipfarm ist auf dem neuesten Stand.");
    else if (info.updateStatus === "available") showToast(`Clipfarm ${info.latestVersion} ist verfügbar.`);
    else if (info.updateStatus === "unavailable") showToast("GitHub ist gerade nicht erreichbar. Versuch es später erneut.");
    else if (info.updateStatus === "updater-error") showToast("Der Updater konnte nicht gestartet werden.");
  } catch {
    showToast("Die Update-Prüfung ist fehlgeschlagen.");
  } finally {
    checkForUpdatesButton.disabled = false;
    label.textContent = previousLabel;
  }
});
$('installUpdateButton').addEventListener('click', async () => {
  const button = $('installUpdateButton');
  button.disabled = true;
  button.textContent = 'Updater startet …';
  try {
    const info = await window.clipfarmNative.installUpdate();
    renderAppInfo(info);
  } catch (error) {
    $('appInfoUpdateStatus').textContent = error.message || 'Das Update konnte nicht installiert werden.';
  } finally {
    button.disabled = false;
    button.textContent = 'Installieren';
  }
});
async function loadAutostartSetting() {
  if (!window.clipfarmNative?.getAutostart) return;
  try {
    const setting = await window.clipfarmNative.getAutostart();
    $('autostartSwitch').checked = Boolean(setting.enabled);
    $('autostartSwitch').disabled = !setting.supported;
  } catch { $('autostartSwitch').disabled = true; }
}
$('autostartSwitch').addEventListener('change', async () => {
  const control = $('autostartSwitch');
  control.disabled = true;
  try {
    const setting = await window.clipfarmNative.setAutostart(control.checked);
    control.checked = Boolean(setting.enabled);
    control.disabled = !setting.supported;
    showToast(setting.enabled ? 'Clipfarm startet künftig mit Windows im Hintergrund.' : 'Clipfarm startet nicht mehr automatisch mit Windows.');
  } catch (error) {
    control.checked = !control.checked;
    control.disabled = false;
    showToast(error.message || 'Autostart-Einstellung konnte nicht gespeichert werden.');
  }
});
loadAutostartSetting();
loadAppInfo();
document.querySelectorAll(".settings-list .switch:not(#microphoneSettingSwitch):not(#backgroundPrioritySwitch):not(#gameAudioSettingsSwitch):not(#separateTracksSwitch)").forEach((button) => button.addEventListener("click", () => toggleSwitch(button)));
$("microphoneSettingSwitch").addEventListener("click", toggleMicrophone);
$("playbackDialog").addEventListener("close", () => {
  const video = $("playbackVideo");
  video.pause();
  video.removeAttribute("src");
  video.load();
});
document.querySelectorAll(".filter-button").forEach((button) => {
  button.setAttribute("aria-pressed", String(button.classList.contains("is-selected")));
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll(".filter-button").forEach((item) => {
      const selected = item === button;
      item.classList.toggle("is-selected", selected);
      item.setAttribute("aria-pressed", String(selected));
    });
    renderLibrary();
    showToast(button.dataset.filter === "today" ? "Heute-Filter aktiviert." : "Alle Clips angezeigt.");
  });
});
document.addEventListener("keydown", async (event) => {
  if (state.hotkeyCapture) { await finishHotkeyCapture(event); return; }
  if (window.clipfarmNative || event.target.matches("input, select, textarea")) return;
  const hotkey = eventHotkeySpec(event);
  if (hotkey === state.hotkeys.save) { event.preventDefault(); saveClip(); }
  if (hotkey === state.hotkeys.toggle) { event.preventDefault(); setEngine(!(state.engineLive || state.autoStartPending)); }
  if (hotkey === state.hotkeys.microphone) { event.preventDefault(); toggleMicrophone(); }
});

window.clipfarmNative?.onStartupError((message) => showToast(message));
window.clipfarmNative?.onClipOutcome((result) => playClipOutcome(result.outcome === "success", { notifyOverlay: false, message: result.message }));
window.clipfarmNative?.onUpdateAvailable((info) => { renderAppInfo(info); });
window.clipfarmNative?.onUpdateState((info) => { renderAppInfo(info); });
window.clipfarmNative?.onUploadUpdate(handleUploadUpdate);
window.clipfarmNative?.onUploadCommitted(handleUploadCommitted);
window.clipfarmNative?.onAccountUpdate((user) => {
  if (!user) {
    applyAccount(null, false);
  } else if (state.account?.id !== user.id) {
    applyAccount(user);
  } else {
    state.account = { id: user.id, username: user.username, displayName: user.displayName || user.username, avatarUrl: user.avatarUrl || null };
    paintSidebarAvatar(state.account);
    $("accountStatusLabel").textContent = state.account.displayName;
    $("accountStatusDetail").textContent = '@' + state.account.username;
    if (state.profile) {
      state.profile.displayName = state.account.displayName;
      state.profile.avatarUrl = state.account.avatarUrl;
      if (state.activeView === 'profile') renderProfile(state.profile);
    }
  }
});

function startUiPolling() {
  if (state.uiPolling) return;
  state.uiPolling = true;
  pollLiveMetrics(); pollSession(); pollEngine(); pollAudioDevices(); pollBackendStatus();
  state.uiTimers = [setInterval(pollLiveMetrics, 4000), setInterval(pollSession, 5000), setInterval(pollEngine, 2000), setInterval(pollAudioDevices, 30000), setInterval(pollBackendStatus, 60000)];
}

function stopUiPolling() {
  state.uiTimers.forEach(clearInterval);
  state.uiTimers = [];
  state.uiPolling = false;
}

setAuthMode("login");
renderCommunityFeed();
renderUploadQueue();
renderLibrary(); updateClipCount(); updateReplayUI(); updateMetrics();
initializeAccount();
document.addEventListener("visibilitychange", () => { if (document.hidden) stopUiPolling(); else startUiPolling(); });
if (!document.hidden) startUiPolling();
