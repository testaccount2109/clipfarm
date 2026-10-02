"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");
const { DatabaseSync } = require("node:sqlite");

const scrypt = promisify(crypto.scrypt);
const API_PREFIX = "/api/v1";
const HOST = process.env.CLIPFARM_API_HOST || "127.0.0.1";
const PORT = Number(process.env.CLIPFARM_API_PORT || 4188);
const PUBLIC_ORIGIN = String(process.env.CLIPFARM_PUBLIC_ORIGIN || "https://benni-projects.de").replace(/\/+$/, "");
const DATA_DIRECTORY = process.env.CLIPFARM_DATA_DIR || "/var/lib/clipfarm-api";
const MEDIA_DIRECTORY = path.join(DATA_DIRECTORY, "media");
const DATABASE_PATH = path.join(DATA_DIRECTORY, "clipfarm.sqlite");
const MAX_CLIP_BYTES = 2 * 1024 * 1024 * 1024;
const ACCESS_LIFETIME_SECONDS = 15 * 60;
const REFRESH_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const TOKEN_SECRET = Buffer.from(String(process.env.CLIPFARM_TOKEN_SECRET || ""), "hex");

if (TOKEN_SECRET.length < 32) throw new Error("CLIPFARM_TOKEN_SECRET must contain at least 32 random bytes.");
if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(PUBLIC_ORIGIN)) throw new Error("CLIPFARM_PUBLIC_ORIGIN must be an HTTPS origin.");
fs.mkdirSync(MEDIA_DIRECTORY, { recursive: true, mode: 0o700 });

const database = new DatabaseSync(DATABASE_PATH);
database.exec(
  "PRAGMA journal_mode = WAL;" +
  "PRAGMA foreign_keys = ON;" +
  "PRAGMA busy_timeout = 5000;" +
  "CREATE TABLE IF NOT EXISTS users (" +
  "id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, " +
  "password_salt BLOB NOT NULL, password_hash BLOB NOT NULL, created_at TEXT NOT NULL);" +
  "CREATE TABLE IF NOT EXISTS refresh_tokens (" +
  "token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL, " +
  "user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, revoked_at INTEGER);" +
  "CREATE INDEX IF NOT EXISTS refresh_tokens_session_idx ON refresh_tokens(session_id);" +
  "CREATE TABLE IF NOT EXISTS clips (" +
  "id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, game TEXT NOT NULL, " +
  "duration_seconds INTEGER NOT NULL, uploaded_at TEXT NOT NULL, size_bytes INTEGER NOT NULL, " +
  "media_file TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL, UNIQUE(user_id, idempotency_key));" +
  "CREATE INDEX IF NOT EXISTS clips_feed_idx ON clips(uploaded_at DESC, id DESC);"
);

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(response, status, value, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...extraHeaders
  });
  response.end(JSON.stringify(value));
}

function empty(response, status = 204) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  response.end();
}

async function readJson(request, maxBytes = 16 * 1024) {
  if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers["content-type"] || ""))) {
    throw new ApiError(415, "JSON wird erwartet.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new ApiError(413, "Die Anfrage ist zu groß.");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value;
  } catch {
    throw new ApiError(400, "Die Anfrage enthält ungültige JSON-Daten.");
  }
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maxLength);
}

function validateCredentials(body) {
  const username = cleanText(body.username, 32);
  const password = typeof body.password === "string" ? body.password : "";
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    throw new ApiError(400, "Der Username muss 3–32 Zeichen lang sein und darf Buchstaben, Zahlen, Punkt, Bindestrich und Unterstrich enthalten.");
  }
  if (password.length < 10 || Buffer.byteLength(password, "utf8") > 256) {
    throw new ApiError(400, "Das Passwort muss mindestens 10 Zeichen lang sein.");
  }
  return { username, password };
}

async function hashPassword(password, salt) {
  return scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function checkRateLimit(request, action, maximum, windowMs) {
  const key = String(request.headers["x-real-ip"] || request.socket.remoteAddress || "unknown").slice(0, 80) + ":" + action;
  const now = Date.now();
  const recent = (rateLimits.get(key) || []).filter((time) => now - time < windowMs);
  if (recent.length >= maximum) throw new ApiError(429, "Zu viele Versuche. Warte kurz und versuche es erneut.");
  recent.push(now);
  rateLimits.set(key, recent);
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function makeAccessToken(user, sessionId) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: "clipfarm-community-api",
    sub: user.id,
    sid: sessionId,
    iat: now,
    exp: now + ACCESS_LIFETIME_SECONDS
  }));
  const body = header + "." + payload;
  const signature = crypto.createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  return { token: body + "." + signature, expiresAt: new Date((now + ACCESS_LIFETIME_SECONDS) * 1000).toISOString() };
}

function verifyAccessToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new ApiError(401, "Melde dich erneut an.");
  const unsigned = parts[0] + "." + parts[1];
  const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(unsigned).digest();
  let actual;
  try { actual = Buffer.from(parts[2], "base64url"); } catch { throw new ApiError(401, "Melde dich erneut an."); }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new ApiError(401, "Melde dich erneut an.");
  }
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (claims.iss !== "clipfarm-community-api" || !claims.sub || !claims.sid || claims.exp <= Math.floor(Date.now() / 1000)) {
      throw new Error("expired");
    }
    return claims;
  } catch {
    throw new ApiError(401, "Deine Sitzung ist abgelaufen. Melde dich erneut an.");
  }
}

function authenticate(request) {
  const match = /^Bearer ([A-Za-z0-9._-]{20,4096})$/i.exec(String(request.headers.authorization || ""));
  if (!match) throw new ApiError(401, "Melde dich an, um fortzufahren.");
  const claims = verifyAccessToken(match[1]);
  const user = database.prepare("SELECT id, username FROM users WHERE id = ?").get(claims.sub);
  if (!user) throw new ApiError(401, "Melde dich erneut an.");
  return { user, sessionId: claims.sid };
}

function refreshHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function createSession(user) {
  const sessionId = crypto.randomUUID();
  const refreshToken = crypto.randomBytes(48).toString("base64url");
  const expiresAt = Math.floor(Date.now() / 1000) + REFRESH_LIFETIME_SECONDS;
  database.prepare("INSERT INTO refresh_tokens (token_hash, session_id, user_id, expires_at) VALUES (?, ?, ?, ?)")
    .run(refreshHash(refreshToken), sessionId, user.id, expiresAt);
  const access = makeAccessToken(user, sessionId);
  return {
    accessToken: access.token,
    accessExpiresAt: access.expiresAt,
    refreshToken,
    user: { id: user.id, username: user.username }
  };
}

function rotateSession(refreshToken) {
  if (typeof refreshToken !== "string" || refreshToken.length < 40 || refreshToken.length > 160) {
    throw new ApiError(401, "Melde dich erneut an.");
  }
  const oldHash = refreshHash(refreshToken);
  const now = Math.floor(Date.now() / 1000);
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database.prepare(
      "SELECT rt.session_id AS sessionId, rt.user_id AS userId, u.username AS username " +
      "FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id " +
      "WHERE rt.token_hash = ? AND rt.revoked_at IS NULL AND rt.expires_at > ?"
    ).get(oldHash, now);
    if (!row) {
      database.exec("ROLLBACK");
      throw new ApiError(401, "Deine Sitzung ist abgelaufen. Melde dich erneut an.");
    }
    database.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").run(now, oldHash);
    const nextToken = crypto.randomBytes(48).toString("base64url");
    database.prepare("INSERT INTO refresh_tokens (token_hash, session_id, user_id, expires_at) VALUES (?, ?, ?, ?)")
      .run(refreshHash(nextToken), row.sessionId, row.userId, now + REFRESH_LIFETIME_SECONDS);
    database.exec("COMMIT");
    const access = makeAccessToken({ id: row.userId, username: row.username }, row.sessionId);
    return {
      accessToken: access.token,
      accessExpiresAt: access.expiresAt,
      refreshToken: nextToken,
      user: { id: row.userId, username: row.username }
    };
  } catch (error) {
    if (!(error instanceof ApiError)) {
      try { database.exec("ROLLBACK"); } catch { /* transaction already ended */ }
    }
    throw error;
  }
}

function publicClip(row) {
  return {
    id: row.id,
    title: row.title,
    creator: row.username,
    game: row.game,
    uploadedAt: row.uploaded_at,
    durationSeconds: row.duration_seconds,
    sizeBytes: row.size_bytes,
    thumbnailUrl: null,
    mediaUrl: PUBLIC_ORIGIN + API_PREFIX + "/clips/" + row.id + "/media"
  };
}

const clipSelect =
  "SELECT c.id, c.title, c.game, c.duration_seconds, c.uploaded_at, c.size_bytes, c.media_file, u.username " +
  "FROM clips c JOIN users u ON u.id = c.user_id";

function parseCursor(value) {
  if (!value) return null;
  if (String(value).length > 512) throw new ApiError(400, "Der Feed-Zeiger ist ungültig.");
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (!parsed || typeof parsed.uploadedAt !== "string" || !Number.isFinite(Date.parse(parsed.uploadedAt)) ||
        !/^[0-9a-f-]{36}$/i.test(parsed.id || "")) throw new Error("invalid cursor");
    return parsed;
  } catch {
    throw new ApiError(400, "Der Feed-Zeiger ist ungültig.");
  }
}

function decodeHeader(value, maxLength) {
  if (!value) return "";
  if (typeof value !== "string" || value.length > maxLength * 4) throw new ApiError(400, "Clip-Metadaten sind ungültig.");
  let decoded;
  try { decoded = Buffer.from(value, "base64url").toString("utf8"); } catch { throw new ApiError(400, "Clip-Metadaten sind ungültig."); }
  return cleanText(decoded, maxLength);
}

function existingClip(userId, idempotencyKey) {
  return database.prepare(clipSelect + " WHERE c.user_id = ? AND c.idempotency_key = ?").get(userId, idempotencyKey);
}

async function uploadClip(request, response, user) {
  if (!/^video\/mp4(?:\s*;|$)/i.test(String(request.headers["content-type"] || ""))) {
    request.resume();
    throw new ApiError(415, "Der Upload muss eine MP4-Datei enthalten.");
  }
  const idempotencyKey = String(request.headers["idempotency-key"] || "");
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) {
    request.resume();
    throw new ApiError(400, "Der Upload-Schlüssel fehlt oder ist ungültig.");
  }
  const duplicate = existingClip(user.id, idempotencyKey);
  if (duplicate) {
    json(response, 200, { clip: publicClip(duplicate), stored: true, duplicate: true });
    request.resume();
    return;
  }
  const rawLength = request.headers["content-length"];
  const expectedLength = rawLength === undefined ? null : Number(rawLength);
  if (expectedLength !== null && (!Number.isSafeInteger(expectedLength) || expectedLength <= 0 || expectedLength > MAX_CLIP_BYTES)) {
    request.resume();
    throw new ApiError(expectedLength > MAX_CLIP_BYTES ? 413 : 400, "Die Clipgröße ist ungültig oder überschreitet 2 GB.");
  }
  const title = decodeHeader(request.headers["x-clip-title-base64"], 100) || "Spielmoment";
  const game = decodeHeader(request.headers["x-clip-game-base64"], 80) || "Unbekanntes Spiel";
  const durationSeconds = Number(request.headers["x-clip-duration-seconds"]);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 86400) {
    request.resume();
    throw new ApiError(400, "Die Clipdauer ist ungültig.");
  }

  const clipId = crypto.randomUUID();
  const mediaFile = clipId + ".mp4";
  const partialPath = path.join(MEDIA_DIRECTORY, clipId + ".part");
  const finalPath = path.join(MEDIA_DIRECTORY, mediaFile);
  let bytesReceived = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      bytesReceived += chunk.length;
      if (bytesReceived > MAX_CLIP_BYTES) callback(new ApiError(413, "Der Clip überschreitet die maximale Größe von 2 GB."));
      else callback(null, chunk);
    }
  });

  try {
    await pipeline(request, limiter, fs.createWriteStream(partialPath, { flags: "wx", mode: 0o600 }));
    if (bytesReceived < 12 || (expectedLength !== null && bytesReceived !== expectedLength)) {
      throw new ApiError(400, "Der Upload wurde nicht vollständig übertragen.");
    }
    const handle = await fs.promises.open(partialPath, "r");
    const signature = Buffer.alloc(12);
    await handle.read(signature, 0, signature.length, 0);
    await handle.close();
    if (signature.toString("ascii", 4, 8) !== "ftyp") throw new ApiError(415, "Die Datei enthält kein gültiges MP4-Video.");

    await fs.promises.rename(partialPath, finalPath);
    const clip = {
      id: clipId,
      userId: user.id,
      title,
      game,
      durationSeconds,
      uploadedAt: new Date().toISOString(),
      sizeBytes: bytesReceived,
      mediaFile,
      idempotencyKey
    };
    database.prepare(
      "INSERT INTO clips (id, user_id, title, game, duration_seconds, uploaded_at, size_bytes, media_file, idempotency_key) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(clip.id, clip.userId, clip.title, clip.game, clip.durationSeconds, clip.uploadedAt, clip.sizeBytes, clip.mediaFile, clip.idempotencyKey);
    const saved = database.prepare(clipSelect + " WHERE c.id = ?").get(clipId);
    json(response, 201, { clip: publicClip(saved), stored: true, duplicate: false });
  } catch (error) {
    await fs.promises.rm(partialPath, { force: true }).catch(() => {});
    const duplicateAfterRace = existingClip(user.id, idempotencyKey);
    if (duplicateAfterRace) {
      await fs.promises.rm(finalPath, { force: true }).catch(() => {});
      if (!response.headersSent) json(response, 200, { clip: publicClip(duplicateAfterRace), stored: true, duplicate: true });
      return;
    }
    await fs.promises.rm(finalPath, { force: true }).catch(() => {});
    throw error;
  }
}

function streamMedia(request, response, row) {
  const fileName = path.basename(row.media_file);
  if (fileName !== row.media_file) throw new ApiError(404, "Clip nicht gefunden.");
  const filename = path.join(MEDIA_DIRECTORY, fileName);
  let stat;
  try { stat = fs.statSync(filename); } catch { throw new ApiError(404, "Clip nicht gefunden."); }
  const commonHeaders = {
    "Content-Type": "video/mp4",
    "Content-Length": stat.size,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Disposition": "inline; filename=\"clip.mp4\""
  };
  const range = String(request.headers.range || "");
  if (!range) {
    response.writeHead(200, commonHeaders);
    if (request.method === "HEAD") response.end();
    else fs.createReadStream(filename).pipe(response);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    response.writeHead(416, { "Content-Range": "bytes */" + stat.size, "Accept-Ranges": "bytes" });
    response.end();
    return;
  }
  const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= stat.size) {
    response.writeHead(416, { "Content-Range": "bytes */" + stat.size, "Accept-Ranges": "bytes" });
    response.end();
    return;
  }
  response.writeHead(206, {
    ...commonHeaders,
    "Content-Length": end - start + 1,
    "Content-Range": "bytes " + start + "-" + end + "/" + stat.size
  });
  if (request.method === "HEAD") response.end();
  else fs.createReadStream(filename, { start, end }).pipe(response);
}

const rateLimits = new Map();
const rateLimitSweep = setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [key, times] of rateLimits) {
    const recent = times.filter((time) => time > cutoff);
    if (recent.length) rateLimits.set(key, recent);
    else rateLimits.delete(key);
  }
}, 15 * 60 * 1000);
rateLimitSweep.unref();

async function route(request, response, url) {
  const pathname = url.pathname;
  if (pathname === API_PREFIX + "/health" && request.method === "GET") {
    json(response, 200, { ok: true, service: "clipfarm-community-api", version: "1.0.0" });
    return;
  }
  if (pathname === API_PREFIX + "/openapi.json" && request.method === "GET") {
    const document = await fs.promises.readFile(path.join(__dirname, "openapi.json"));
    response.writeHead(200, {
      "Content-Type": "application/vnd.oai.openapi+json;version=3.1; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(document);
    return;
  }
  if (pathname === API_PREFIX + "/auth/register" && request.method === "POST") {
    checkRateLimit(request, "register", 12, 60 * 60 * 1000);
    const credentials = validateCredentials(await readJson(request));
    const salt = crypto.randomBytes(16);
    const passwordHash = await hashPassword(credentials.password, salt);
    const user = { id: crypto.randomUUID(), username: credentials.username };
    try {
      database.prepare("INSERT INTO users (id, username, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(user.id, user.username, salt, passwordHash, new Date().toISOString());
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) throw new ApiError(409, "Dieser Username ist bereits vergeben.");
      throw error;
    }
    json(response, 201, createSession(user));
    return;
  }
  if (pathname === API_PREFIX + "/auth/login" && request.method === "POST") {
    checkRateLimit(request, "login", 12, 15 * 60 * 1000);
    const credentials = validateCredentials(await readJson(request));
    const row = database.prepare("SELECT id, username, password_salt, password_hash FROM users WHERE username = ? COLLATE NOCASE").get(credentials.username);
    const salt = row ? Buffer.from(row.password_salt) : Buffer.alloc(16, 0x6c);
    const passwordHash = await hashPassword(credentials.password, salt);
    const storedHash = row ? Buffer.from(row.password_hash) : Buffer.alloc(64, 0x91);
    if (!row || storedHash.length !== passwordHash.length || !crypto.timingSafeEqual(storedHash, passwordHash)) {
      throw new ApiError(401, "Username oder Passwort stimmt nicht.");
    }
    json(response, 200, createSession({ id: row.id, username: row.username }));
    return;
  }
  if (pathname === API_PREFIX + "/auth/refresh" && request.method === "POST") {
    const body = await readJson(request);
    json(response, 200, rotateSession(body.refreshToken));
    return;
  }
  if (pathname === API_PREFIX + "/auth/session" && request.method === "GET") {
    const { user } = authenticate(request);
    json(response, 200, { authenticated: true, user });
    return;
  }
  if (pathname === API_PREFIX + "/auth/logout" && request.method === "POST") {
    const { user, sessionId } = authenticate(request);
    database.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND session_id = ? AND revoked_at IS NULL")
      .run(Math.floor(Date.now() / 1000), user.id, sessionId);
    empty(response);
    return;
  }
  if (pathname === API_PREFIX + "/clips" && request.method === "GET") {
    const { user } = authenticate(request);
    const cursor = parseCursor(url.searchParams.get("cursor"));
    const limit = 30;
    const rows = cursor
      ? database.prepare(clipSelect + " WHERE (c.uploaded_at < ? OR (c.uploaded_at = ? AND c.id < ?)) ORDER BY c.uploaded_at DESC, c.id DESC LIMIT ?")
        .all(cursor.uploadedAt, cursor.uploadedAt, cursor.id, limit + 1)
      : database.prepare(clipSelect + " ORDER BY c.uploaded_at DESC, c.id DESC LIMIT ?").all(limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    json(response, 200, {
      clips: page.map(publicClip),
      nextCursor: hasMore && last ? base64url(JSON.stringify({ uploadedAt: last.uploaded_at, id: last.id })) : null,
      sort: "uploadedAt:desc",
      viewer: { id: user.id, username: user.username }
    });
    return;
  }
  if (pathname === API_PREFIX + "/clips" && request.method === "POST") {
    const { user } = authenticate(request);
    await uploadClip(request, response, user);
    return;
  }
  const mediaMatch = new RegExp("^" + API_PREFIX + "/clips/([0-9a-f-]{36})/media$", "i").exec(pathname);
  if (mediaMatch && (request.method === "GET" || request.method === "HEAD")) {
    const row = database.prepare(clipSelect + " WHERE c.id = ?").get(mediaMatch[1]);
    if (!row) throw new ApiError(404, "Clip nicht gefunden.");
    streamMedia(request, response, row);
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    request.resume();
    throw new ApiError(405, "Diese Aktion ist nicht verfügbar.");
  }
  throw new ApiError(404, "API-Endpunkt nicht gefunden.");
}

const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
  response.on("finish", () => {
    console.log(new Date().toISOString(), request.method, new URL(request.url, "http://localhost").pathname, response.statusCode);
  });
  let url;
  try { url = new URL(request.url, "http://localhost"); }
  catch {
    json(response, 400, { error: "Die Anfrageadresse ist ungültig." });
    request.resume();
    return;
  }
  route(request, response, url).catch((error) => {
    if (response.headersSent || response.destroyed) {
      if (!response.destroyed) response.destroy(error);
      return;
    }
    const status = error instanceof ApiError ? error.status : 500;
    const message = error instanceof ApiError ? error.message : "Der Server konnte die Anfrage nicht abschließen.";
    const headers = status === 401 ? { "WWW-Authenticate": 'Bearer realm="clipfarm"' } : {};
    json(response, status, { error: message }, headers);
  });
});

server.headersTimeout = 30_000;
server.requestTimeout = 0;
server.keepAliveTimeout = 65_000;
server.listen(PORT, HOST, () => console.log("clipfarm community API listening on " + HOST + ":" + PORT));

function shutdown() {
  clearInterval(rateLimitSweep);
  server.close(() => {
    database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
