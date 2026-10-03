"use strict";

const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { PassThrough } = require("node:stream");
const backendConfig = require("./backend-config");

class CommunityApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class CommunityService extends EventEmitter {
  constructor({ safeStorage, sessionPath, profileCachePath, stagingDirectory, getClipDirectory }) {
    super();
    this.safeStorage = safeStorage;
    this.sessionPath = sessionPath;
    this.profileCachePath = profileCachePath;
    this.stagingDirectory = stagingDirectory;
    this.getClipDirectory = getClipDirectory;
    this.account = null;
    this.profileCache = null;
    this.accessToken = null;
    this.accessExpiresAt = 0;
    this.refreshToken = null;
    this.restorePromise = null;
    this.uploads = new Map();
    this.uploadWorker = null;
    this.retryTimer = null;
  }

  async initialize() {
    fs.mkdirSync(this.stagingDirectory, { recursive: true });
    try {
      const profile = JSON.parse(await fs.promises.readFile(this.profileCachePath, "utf8"));
      if (profile && typeof profile.id === "string" && typeof profile.localOnly === "boolean") this.profileCache = profile;
    } catch { /* A missing or invalid profile cache is reloaded after sign-in. */ }
    let entries = [];
    try {
      const value = JSON.parse(await fs.promises.readFile(this.manifestPath(), "utf8"));
      if (Array.isArray(value)) entries = value;
    } catch { /* A missing or damaged queue file must not stop capture. */ }

    for (const entry of entries) {
      if (!entry || !/^[0-9a-f-]{36}$/.test(String(entry.id || "")) ||
          !/^[0-9a-f-]{36}\.mp4$/i.test(String(entry.fileName || ""))) continue;
      const filePath = path.join(this.stagingDirectory, entry.fileName);
      try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile() || stat.size < 12) continue;
        this.uploads.set(entry.id, {
          id: entry.id,
          fileName: entry.fileName,
          filePath,
          sourceFile: typeof entry.sourceFile === "string" ? entry.sourceFile : null,
          isNewCapture: entry.isNewCapture === true,
          ownerUserId: typeof entry.ownerUserId === "string" ? entry.ownerUserId : null,
          title: this.cleanText(entry.title, 100) || "Spielmoment",
          game: this.cleanText(entry.game, 80) || "Unbekanntes Spiel",
          durationSeconds: Math.max(1, Math.min(86400, Number(entry.durationSeconds) || 1)),
          sizeBytes: stat.size,
          idempotencyKey: /^[A-Za-z0-9_-]{16,128}$/.test(String(entry.idempotencyKey || "")) ? entry.idempotencyKey : entry.id,
          createdAt: Number(entry.createdAt) || Date.now(),
          attempts: Math.max(0, Number(entry.attempts) || 0),
          nextRetryAt: 0,
          progress: 0,
          status: "queued",
          error: "",
          retryable: true
        });
      } catch { /* Remove orphan entries from the next manifest write. */ }
    }
    await this.persistUploads();
  }

  manifestPath() {
    return path.join(path.dirname(this.stagingDirectory), "pending-uploads.json");
  }

  cleanText(value, maximum) {
    return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maximum);
  }

  publicAccount(account = this.account) {
    if (!account || typeof account.id !== "string" || typeof account.username !== "string") return null;
    return {
      id: account.id,
      username: account.username,
      displayName: this.cleanText(account.displayName, 32) || account.username,
      avatarUrl: typeof account.avatarUrl === "string" ? account.avatarUrl : null
    };
  }

  async requireSecureStorage() {
    if (!this.safeStorage || !this.safeStorage.isEncryptionAvailable()) {
      throw new Error("Die sichere Windows-Sitzungsspeicherung ist nicht verfügbar. Clipfarm speichert das Konto nicht unverschlüsselt.");
    }
  }

  async persistSession() {
    await this.requireSecureStorage();
    const session = {
      accessToken: this.accessToken,
      accessExpiresAt: this.accessExpiresAt,
      refreshToken: this.refreshToken,
      user: this.publicAccount()
    };
    const encrypted = this.safeStorage.encryptString(JSON.stringify(session));
    const temporaryPath = this.sessionPath + ".tmp";
    await fs.promises.writeFile(temporaryPath, encrypted, { mode: 0o600 });
    await fs.promises.rename(temporaryPath, this.sessionPath);
  }

  async removeStoredSession() {
    try { await fs.promises.rm(this.sessionPath, { force: true }); } catch { /* best effort */ }
    try { await fs.promises.rm(this.sessionPath + ".tmp", { force: true }); } catch { /* best effort */ }
  }

  async clearSession() {
    this.account = null;
    this.accessToken = null;
    this.accessExpiresAt = 0;
    this.refreshToken = null;
    this.restorePromise = null;
    await this.removeStoredSession();
    this.emit("account", null);
    for (const item of this.uploads.values()) {
      item.status = "waiting-auth";
      item.error = "Melde dich an, damit Clipfarm den Upload fortsetzen kann.";
      item.progress = 0;
    }
    await this.persistUploads();
  }

  async storeSession(payload) {
    if (!payload || typeof payload.accessToken !== "string" ||
        typeof payload.refreshToken !== "string" ||
        !payload.user || typeof payload.user.id !== "string" ||
        typeof payload.user.username !== "string") {
      throw new Error("Der Server hat keine gültige Sitzung zurückgegeben.");
    }
    await this.requireSecureStorage();
    this.accessToken = payload.accessToken;
    this.accessExpiresAt = Date.parse(payload.accessExpiresAt) || Date.now() + 10 * 60 * 1000;
    this.refreshToken = payload.refreshToken;
    this.account = this.publicAccount(payload.user);
    await this.persistSession();
    this.emit("account", this.publicAccount());
  }

  async rawRequest(route, options = {}) {
    const url = backendConfig.apiBase + route;
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.origin !== new URL(backendConfig.origin).origin) {
      throw new Error("Die Konto-API ist nicht auf dem festgelegten HTTPS-Server.");
    }
    const response = await fetch(url, {
      ...options,
      redirect: "error",
      signal: options.signal || AbortSignal.timeout(20_000)
    });
    if (response.status === 401 && /\bBasic\b/i.test(response.headers.get("www-authenticate") || "")) {
      throw new CommunityApiError(401, "Der API-Endpunkt ist noch durch HTTP-Basic-Auth gesperrt.");
    }
    let payload = {};
    const body = await response.text();
    if (body) {
      try { payload = JSON.parse(body); }
      catch { throw new Error("Der Clipfarm-Server hat eine ungültige Antwort gesendet."); }
    }
    if (!response.ok) {
      throw new CommunityApiError(response.status, this.cleanText(payload.error, 240) || "Der Clipfarm-Server konnte die Anfrage nicht abschließen.");
    }
    return payload;
  }

  async refreshSession() {
    if (this.refreshPromise) return this.refreshPromise;
    if (!this.refreshToken) throw new CommunityApiError(401, 'Melde dich erneut an.');
    const oldToken = this.refreshToken;
    this.refreshPromise = (async () => {
      try {
        const payload = await this.rawRequest('/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ refreshToken: oldToken })
        });
        await this.storeSession(payload);
        return this.accessToken;
      } catch (error) {
        if (error.status === 401) await this.clearSession();
        throw error;
      }
    })().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }
  async ensureAccessToken() {
    if (!this.accessToken || this.accessExpiresAt < Date.now() + 30_000) {
      await this.refreshSession();
    }
    return this.accessToken;
  }

  async authenticatedRequest(route, options = {}) {
    let token = await this.ensureAccessToken();
    const makeRequest = () => this.rawRequest(route, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: "Bearer " + token }
    });
    try {
      return await makeRequest();
    } catch (error) {
      if (error.status !== 401) throw error;
      token = await this.refreshSession();
      return makeRequest();
    }
  }

  async authenticate(mode, credentials) {
    const username = this.cleanText(credentials && credentials.username, 32);
    const password = credentials && typeof credentials.password === 'string' ? credentials.password : '';
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
      throw new Error('Der Username muss 3–32 Zeichen lang sein und darf Buchstaben, Zahlen, Punkt, Bindestrich und Unterstrich enthalten.');
    }
    if (password.length < 10 || Buffer.byteLength(password, 'utf8') > 256) {
      throw new Error('Das Passwort muss mindestens 10 Zeichen lang sein.');
    }
    await this.requireSecureStorage();
    const previous = { accessToken: this.accessToken, accessExpiresAt: this.accessExpiresAt, refreshToken: this.refreshToken, user: this.account };
    try {
      const payload = await this.rawRequest('/auth/' + (mode === 'register' ? 'register' : 'login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username, password })
      });
      await this.storeSession(payload);
      for (const item of this.uploads.values()) {
        if (item.status !== 'waiting-auth') continue;
        if (item.ownerUserId && item.ownerUserId !== this.account.id) {
          item.error = 'Dieser Clip ist für ein anderes Konto vorgemerkt.';
          continue;
        }
        item.status = 'queued';
        item.error = '';
        item.nextRetryAt = 0;
      }
      await this.persistUploads();
      this.processUploads();
      return this.publicAccount();
    } catch (error) {
      this.accessToken = previous.accessToken;
      this.accessExpiresAt = previous.accessExpiresAt;
      this.refreshToken = previous.refreshToken;
      this.account = previous.user;
      if (previous.user) await this.persistSession().catch(() => {});
      else await this.removeStoredSession();
      throw error;
    }
  }
  async restoreSession() {
    if (this.restorePromise) return this.restorePromise;
    this.restorePromise = (async () => {
      try {
        await this.requireSecureStorage();
        const encrypted = await fs.promises.readFile(this.sessionPath);
        const saved = JSON.parse(this.safeStorage.decryptString(encrypted));
        if (typeof saved.refreshToken !== "string" || !saved.user || typeof saved.user.username !== "string") throw new Error("invalid session");
        this.accessToken = typeof saved.accessToken === "string" ? saved.accessToken : "";
        this.accessExpiresAt = Date.parse(saved.accessExpiresAt) || 0;
        this.refreshToken = saved.refreshToken;
        this.account = this.publicAccount(saved.user);
        try {
          const result = await this.authenticatedRequest("/auth/session", { headers: { Accept: "application/json" } });
          this.account = this.publicAccount(result.user) || this.account;
          this.emit("account", this.publicAccount());
          this.processUploads();
          return { user: this.publicAccount(), offline: false };
        } catch (error) {
          if (error.status === 401) {
            await this.clearSession();
            return { user: null, offline: false };
          }
          this.emit("account", this.publicAccount());
          return { user: this.publicAccount(), offline: true };
        }
      } catch (error) {
        if (error.code !== "ENOENT") await this.clearSession();
        return { user: null, offline: false };
      }
    })();
    return this.restorePromise;
  }

  async getAccount() {
    if (this.account) return { user: this.publicAccount(), offline: false };
    return this.restoreSession();
  }

  async getBackendStatus() {
    const checkedAt = new Date().toISOString();
    try {
      const payload = await this.rawRequest(backendConfig.healthPath, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(7000)
      });
      const available = payload.ok === true && payload.service === "clipfarm-community-api";
      return {
        origin: backendConfig.origin,
        checkedAt,
        reachable: true,
        secure: true,
        status: 200,
        basicAuthRequired: false,
        available,
        message: available ? "Clipfarm-API ist über HTTPS erreichbar." : "Der Server antwortet, aber die Clipfarm-API wurde nicht bestätigt."
      };
    } catch (error) {
      const basicAuthRequired = error.status === 401;
      return {
        origin: backendConfig.origin,
        checkedAt,
        reachable: Boolean(error.status),
        secure: true,
        status: error.status || null,
        basicAuthRequired,
        available: false,
        message: basicAuthRequired
          ? "Die API-Route ist noch durch HTTP-Basic-Auth gesperrt."
          : error.status
            ? "Der Clipfarm-Server antwortet mit HTTP " + error.status + "."
            : "Der Clipfarm-Server ist derzeit nicht erreichbar."
      };
    }
  }

  async getFeed(cursor = null) {
    const query = new URLSearchParams({ sort: "uploadedAt", order: "desc" });
    if (cursor !== null) {
      if (typeof cursor !== "string" || cursor.length > 1024) throw new Error("Der Feed-Zeiger ist ungültig.");
      query.set("cursor", cursor);
    }
    const payload = await this.authenticatedRequest("/clips?" + query.toString(), { headers: { Accept: "application/json" } });
    if (!payload || !Array.isArray(payload.clips)) throw new Error("Der Clipfarm-Server hat einen ungültigen Feed zurückgegeben.");
    const origin = new URL(backendConfig.origin).origin;
    payload.clips = payload.clips.map((clip) => {
      const media = new URL(clip.mediaUrl);
      if (media.protocol !== "https:" || media.origin !== origin || !media.pathname.startsWith("/api/v1/clips/")) {
        throw new Error("Ein Clip verweist auf eine nicht vertrauenswürdige Medienadresse.");
      }
      return { ...clip, mediaUrl: media.href };
    });
    return payload;
  }

  async getMyClips(cursor = null) {
    const query = new URLSearchParams({ scope: "mine", sort: "uploadedAt", order: "desc" });
    if (cursor !== null) {
      if (typeof cursor !== "string" || cursor.length > 1024) throw new Error("Der Feed-Zeiger ist ungültig.");
      query.set("cursor", cursor);
    }
    const payload = await this.authenticatedRequest("/clips?" + query.toString(), { headers: { Accept: "application/json" } });
    if (!payload || !Array.isArray(payload.clips)) throw new Error("Der Clipfarm-Server hat eine ungültige Clipbibliothek zurückgegeben.");
    const origin = new URL(backendConfig.origin).origin;
    payload.clips = payload.clips.map((clip) => {
      const media = new URL(clip.mediaUrl);
      if (media.protocol !== "https:" || media.origin !== origin || !media.pathname.startsWith("/api/v1/clips/")) {
        throw new Error("Ein Clip verweist auf eine nicht vertrauenswürdige Medienadresse.");
      }
      return { ...clip, mediaUrl: media.href };
    });
    return payload;
  }

  async getProfile() {
    if (!this.account) throw new Error("Melde dich an, um dein Profil zu öffnen.");
    try {
      const payload = await this.authenticatedRequest("/profile", { headers: { Accept: "application/json" } });
      if (!payload.profile || payload.profile.id !== this.account.id) throw new Error("Der Server hat ein ungültiges Profil zurückgegeben.");
      this.profileCache = payload.profile;
      this.account = this.publicAccount(payload.profile);
      await fs.promises.writeFile(this.profileCachePath, JSON.stringify(this.profileCache), { mode: 0o600 });
      this.emit("account", this.publicAccount());
      return this.profileCache;
    } catch (error) {
      if (this.profileCache?.id === this.account.id) return this.profileCache;
      throw error;
    }
  }

  async updateProfile(profile) {
    const payload = await this.authenticatedRequest("/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(profile)
    });
    if (!payload.profile || payload.profile.id !== this.account?.id) throw new Error("Der Server hat das Profil nicht bestätigt.");
    this.profileCache = payload.profile;
    this.account = this.publicAccount(payload.profile);
    await fs.promises.writeFile(this.profileCachePath, JSON.stringify(this.profileCache), { mode: 0o600 });
    this.emit("account", this.publicAccount());
    return this.profileCache;
  }

  async changePassword(currentPassword, newPassword) {
    return this.authenticatedRequest("/profile/password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ currentPassword, newPassword })
    });
  }

  safeUpload(item) {
    return {
      id: item.id,
      title: item.title,
      game: item.game,
      durationSeconds: item.durationSeconds,
      sizeBytes: item.sizeBytes,
      status: item.status,
      progress: item.progress,
      attempts: item.attempts,
      error: item.error,
      retryable: item.retryable,
      createdAt: item.createdAt
    };
  }

  getUploads() {
    return [...this.uploads.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((item) => this.safeUpload(item));
  }

  emitUploads(type = "queue", changed = null, localFile = null) {
    this.emit("upload-update", {
      type,
      items: this.getUploads(),
      changed: changed ? this.safeUpload(changed) : null,
      localFile
    });
  }

  async persistUploads() {
    const entries = [...this.uploads.values()].map((item) => ({
      id: item.id,
      fileName: item.fileName,
      sourceFile: item.sourceFile,
      isNewCapture: item.isNewCapture,
      ownerUserId: item.ownerUserId || null,
      title: item.title,
      game: item.game,
      durationSeconds: item.durationSeconds,
      idempotencyKey: item.idempotencyKey,
      createdAt: item.createdAt,
      attempts: item.attempts
    }));
    const target = this.manifestPath();
    const temporary = target + ".tmp";
    await fs.promises.writeFile(temporary, JSON.stringify(entries), { mode: 0o600 });
    await fs.promises.rename(temporary, target);
  }

  async queueClip(clip, isNewCapture = true) {
    if (!clip || typeof clip.file !== "string") throw new Error("Der lokale Clip enthält keinen Dateipfad.");
    const sourceFile = path.resolve(clip.file);
    if (path.extname(sourceFile).toLowerCase() !== ".mp4") throw new Error("Nur MP4-Clips können hochgeladen werden.");
    const clipDirectory = path.resolve(await this.getClipDirectory());
    const realDirectory = await fs.promises.realpath(clipDirectory);
    const realStagingDirectory = await fs.promises.realpath(this.stagingDirectory);
    const sourceStat = await fs.promises.lstat(sourceFile);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error("Die Clip-Datei ist ungültig.");
    const realSourceFile = await fs.promises.realpath(sourceFile);
    const relative = path.relative(realDirectory, realSourceFile);
    const stageRelative = path.relative(realStagingDirectory, realSourceFile);
    const isStagedCapture = Boolean(stageRelative) && !stageRelative.startsWith(".." + path.sep) && !path.isAbsolute(stageRelative);
    if (!isStagedCapture && (!relative || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))) {
      throw new Error("Die Clip-Datei liegt außerhalb des konfigurierten Clip-Ordners.");
    }
    const existing = [...this.uploads.values()].find((item) => item.sourceFile === realSourceFile);
    if (existing) return this.safeUpload(existing);
    const stat = await fs.promises.stat(realSourceFile);
    if (stat.size < 12 || stat.size > 2 * 1024 * 1024 * 1024) throw new Error("Die Clip-Datei ist leer oder größer als 2 GB.");
    const stagedId = path.basename(realSourceFile, path.extname(realSourceFile));
    const id = isStagedCapture && /^[0-9a-f-]{36}$/i.test(stagedId) ? stagedId : crypto.randomUUID();
    const fileName = id + ".mp4";
    const filePath = isStagedCapture ? realSourceFile : path.join(this.stagingDirectory, fileName);
    if (!isStagedCapture) await fs.promises.copyFile(realSourceFile, filePath, fs.constants.COPYFILE_EXCL);
    const item = {
      id,
      fileName,
      filePath,
      sourceFile: realSourceFile,
      isNewCapture: isNewCapture === true,
      title: this.cleanText(clip.name || path.basename(sourceFile, ".mp4"), 100) || "Spielmoment",
      game: this.cleanText(clip.game, 80) || "Unbekanntes Spiel",
      durationSeconds: Math.max(1, Math.min(86400, Math.round(Number(clip.seconds) || 1))),
      sizeBytes: stat.size,
      idempotencyKey: crypto.randomUUID(),
      createdAt: Date.now(),
      attempts: 0,
      nextRetryAt: 0,
      progress: 0,
      status: this.account ? "queued" : "waiting-auth",
      error: this.account ? "" : "Melde dich an, damit Clipfarm den Upload starten kann.",
      retryable: true
    };
    this.uploads.set(id, item);
    await this.persistUploads();
    this.emitUploads("queued", item);
    this.processUploads();
    return this.safeUpload(item);
  }

  async retryUpload(id) {
    const item = this.uploads.get(String(id));
    if (!item) throw new Error("Dieser Upload ist nicht mehr in der Warteschlange.");
    item.nextRetryAt = 0;
    item.progress = 0;
    item.status = this.account ? "queued" : "waiting-auth";
    item.error = this.account ? "" : "Melde dich an, damit Clipfarm den Upload starten kann.";
    item.retryable = true;
    await this.persistUploads();
    this.emitUploads("updated", item);
    this.processUploads();
    return this.safeUpload(item);
  }

  scheduleRetry(item) {
    clearTimeout(this.retryTimer);
    const dueAt = Math.min(...[...this.uploads.values()]
      .filter((queued) => queued.status === "retrying" && queued.retryable)
      .map((queued) => queued.nextRetryAt));
    if (!Number.isFinite(dueAt)) return;
    this.retryTimer = setTimeout(() => {
      for (const queued of this.uploads.values()) {
        if (queued.status === "retrying" && queued.nextRetryAt <= Date.now()) queued.status = "queued";
      }
      this.persistUploads().then(() => this.processUploads()).catch(() => {});
    }, Math.max(250, dueAt - Date.now()));
    this.retryTimer.unref?.();
  }

  async processUploads() {
    if (this.uploadWorker) return this.uploadWorker;
    this.uploadWorker = (async () => {
      while (true) {
        const item = [...this.uploads.values()].find((candidate) =>
          candidate.status === "queued" && candidate.nextRetryAt <= Date.now());
        if (!item) break;
        if (!this.account) {
          item.status = "waiting-auth";
          item.error = "Melde dich an, damit Clipfarm den Upload starten kann.";
          await this.persistUploads();
          this.emitUploads("updated", item);
          break;
        }
        if (item.ownerUserId && item.ownerUserId !== this.account.id) {
          item.status = "waiting-auth";
          item.error = "Dieser Clip ist für ein anderes Konto vorgemerkt.";
          await this.persistUploads();
          this.emitUploads("updated", item);
          continue;
        }
        item.ownerUserId = this.account.id;
        item.status = "uploading";
        item.error = "";
        item.progress = 0;
        await this.persistUploads();
        this.emitUploads("updated", item);
        try {
          const result = await this.upload(item);
          if (!result || result.stored !== true || !result.clip || typeof result.clip.id !== "string") {
            throw new Error("Der Server hat den Upload nicht bestätigt.");
          }
          const localFile = item.sourceFile;
          let cleanupWarning = "";
          if (item.isNewCapture && localFile) {
            try {
              const clipDirectory = path.resolve(await this.getClipDirectory());
              const relative = path.relative(clipDirectory, path.resolve(localFile));
              if (relative && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) {
                await fs.promises.rm(localFile, { force: true });
              }
            } catch {
              cleanupWarning = "Der Upload ist bestätigt, aber die lokale Arbeitskopie konnte nicht entfernt werden.";
            }
          }
          await fs.promises.rm(item.filePath, { force: true }).catch(() => {});
          this.uploads.delete(item.id);
          await this.persistUploads();
          this.emitUploads("committed", null, cleanupWarning ? null : localFile);
          this.emit("upload-committed", {
            clipId: result.clip.id,
            title: item.title,
            cleanupWarning
          });
        } catch (error) {
          item.attempts += 1;
          item.progress = 0;
          item.error = this.cleanText(error.message, 240) || "Der Upload ist fehlgeschlagen.";
          const status = Number(error.status) || 0;
          if (status === 401) {
            item.status = "waiting-auth";
            item.error = "Die Sitzung ist abgelaufen. Melde dich erneut an, um den Upload fortzusetzen.";
            item.retryable = true;
          } else {
            item.retryable = !status || status === 408 || status === 429 || status >= 500;
            item.status = item.retryable ? "retrying" : "failed";
            if (item.retryable) {
              const delay = Math.min(30 * 60 * 1000, 10_000 * (2 ** Math.min(item.attempts - 1, 7)));
              item.nextRetryAt = Date.now() + delay;
            }
          }
          await this.persistUploads();
          this.emitUploads("updated", item);
          if (!item.retryable) continue;
          this.scheduleRetry(item);
          break;
        }
      }
    })().finally(() => { this.uploadWorker = null; });
    return this.uploadWorker;
  }

  async upload(item) {
    let token = await this.ensureAccessToken();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      item.status = "uploading";
      item.progress = 0;
      this.emitUploads("progress", item);
      const meter = new PassThrough();
      const source = fs.createReadStream(item.filePath);
      let sent = 0;
      let lastUpdate = 0;
      source.on("data", (chunk) => {
        sent += chunk.length;
        const progress = Math.min(99, Math.floor(sent / item.sizeBytes * 100));
        item.progress = progress;
        const now = Date.now();
        if (progress === 99 || now - lastUpdate > 300) {
          lastUpdate = now;
          this.emitUploads("progress", item);
        }
      });
      source.on("error", (error) => meter.destroy(error));
      source.pipe(meter);
      let response;
      try {
        response = await fetch(backendConfig.apiBase + "/clips", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "video/mp4",
            "Content-Length": String(item.sizeBytes),
            "Idempotency-Key": item.idempotencyKey,
            "X-Clip-Title-Base64": Buffer.from(item.title, "utf8").toString("base64url"),
            "X-Clip-Game-Base64": Buffer.from(item.game, "utf8").toString("base64url"),
            "X-Clip-Duration-Seconds": String(item.durationSeconds)
          },
          body: meter,
          duplex: "half",
          redirect: "error",
          signal: AbortSignal.timeout(12 * 60 * 60 * 1000)
        });
      } catch (error) {
        source.destroy();
        meter.destroy();
        throw error;
      }
      const body = await response.text();
      let payload = {};
      if (body) {
        try { payload = JSON.parse(body); }
        catch { throw new Error("Der Clipfarm-Server hat eine ungültige Upload-Antwort gesendet."); }
      }
      if (response.status === 401 && attempt === 0) {
        token = await this.refreshSession();
        continue;
      }
      if (!response.ok) {
        throw new CommunityApiError(response.status, this.cleanText(payload.error, 240) || "Der Upload ist mit HTTP " + response.status + " fehlgeschlagen.");
      }
      item.progress = 100;
      this.emitUploads("progress", item);
      return payload;
    }
    throw new CommunityApiError(401, "Melde dich erneut an.");
  }
}

module.exports = { CommunityService };
