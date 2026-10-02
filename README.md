# clipfarm

clipfarm is a Windows gaming-clip app built on Electron, HTML, CSS, and JavaScript. The desktop window contains the community feed, local clip library, and capture settings. The capture host, AMD AMF pipeline, tray, and global hotkeys continue to run independently of the visible UI.

## Run on Windows

Install the JavaScript dependencies once, then start the app:

```powershell
npm install
npm run desktop
```

The app starts the replay buffer, registers global hotkeys, and places clipfarm in the system tray. Closing the window hides it so the buffer keeps running. Use **Beenden** in the tray menu to stop capture and exit.

Create a Windows installer with:

```powershell
npm run build:win
```

The NSIS installer is written to `release/clipfarm-Setup-1.0.2.exe`. Settings and logs are stored in the user's clipfarm application-data folder. Existing `engine-config.json` settings and a clip folder that still exists are carried over on first launch.

The standalone `release/Clipfarm-Updater.exe` checks the latest public GitHub release, verifies the app update archive against its SHA-256 file, and replaces the installed application files directly. It does not download or start the setup installer. Your account session, settings, upload queue, and clips stay in their existing user-data and clip folders. Close Clipfarm before opening the updater. To publish a future Windows release, update the version in `package.json`, commit the change, and push a matching version tag such as `v1.0.3`; GitHub Actions builds and uploads the installer, the app update archive, the updater, and the installer and app-archive checksums.

For local UI development, `npm start` serves the UI at `http://127.0.0.1:4174`. Global shortcuts and the tray belong to the Electron app. The remote backend origin is centralized in `backend-config.js` and is HTTPS-only.

## Versionsverlauf

The project folder is a local Git repository. Each completed, related change is saved as its own commit. Use `git log --oneline` to browse versions and `git show <commit>` to inspect one. To safely undo a change while preserving the history, run `git revert <commit>`; avoid resetting or amending commits. Personal clips, logs, generated builds, dependencies, and local credentials are excluded by `.gitignore`.

## Features already in the capture host

- Instant Replay at 15, 30, 60, or 120 seconds, saved with F8 by default
- F9 replay toggle and F10 microphone toggle; all three can be changed in Settings
- Windows Graphics Capture with display capture or a detected game window
- Whole-primary-monitor replay is the default and records any app on that monitor; game detection remains active for session details, and game/window capture can still be selected in Settings
- Automatic game-process detection for the supported game list; Minecraft Java is identified from its game window title rather than any unrelated `javaw.exe`
- AMD AMF HEVC/AVC hardware encoding, with resolution, FPS, bitrate, and quality controls
- A local clip library with search, playback, rename, delete, and Explorer actions
- Windows WASAPI capture of the full default PC output (game, Discord, and other app audio) without a virtual cable or extra audio driver
- Windows default microphone capture, with a microphone selector and live mute/volume control
- Optional separate system-audio and microphone tracks in each clip
- Clip-created and clip-failed sound effects from the local `erfolgreich.mp3` and `failed.mp3` files
- Local game-process detection, engine recovery logs, and CPU, RAM, and GPU readings
- Per-user settings and log storage

The clip outcome overlay is a normal Windows desktop window. Choose windowed mode or borderless fullscreen in the game to see it; exclusive fullscreen prevents Windows desktop overlays from appearing above the game. Use **Overlay testen** in Settings to show a local preview without saving or uploading a clip.

The Electron desktop app binds its HTTP host to an ephemeral loopback port and loads only the local UI. Its main process uses context isolation, sandboxing, and disabled renderer Node access. The tray owns global hotkeys, so F8/F9/F10 still work when the window is hidden.

## Requirements and limits

Capture requires a Windows FFmpeg build that includes `gfxcapture`, `hevc_amf` or `h264_amf`, and the matching FFprobe, plus a working AMD AMF driver. clipfarm can find FFmpeg in PATH, a project `tools/ffmpeg.exe`, or a WinGet FFmpeg package. The installer includes clipfarm's small WASAPI bridge; it does not need a virtual cable or an extra driver. The installer does not bundle FFmpeg.

The replay ring stays on disk as short segments instead of retaining the video in RAM. FFmpeg input queues and the audio filter graph are kept deliberately small. RAM/CPU metrics include the Electron main host, FFmpeg, and the WASAPI helper, but not Chromium's UI renderer. GPU metrics may show `n/a` when Windows does not expose a GPU Engine counter for the capture process. Game detection uses process names and recognizes Minecraft Java only when its window title identifies Minecraft; a game must be running for a live detection check.

The social feed and local capture are separate: only server-provided clips belong in the community feed. The WPF work under `desktop/Spool.App` is legacy source and is not part of the Electron build.

## Community backend

The product API uses the HTTPS origin centralized in `backend-config.js` and checks `GET /api/v1/health`. The existing website root `https://benni-projects.de/` may continue to request HTTP-Basic-Auth; Clipfarm does not send account credentials to that page. Nginx publishes only `/api/v1/` to the separate API service and disables Basic Auth on that route. HTTP redirects to HTTPS, and the existing certificate covers `benni-projects.de` and `www.benni-projects.de`.

`backend/server.js` provides account registration and sign-in, encrypted-at-rest password hashes, rotating refresh sessions, a newest-first community feed, MP4 uploads, and byte-range video playback. The feed contains only server records. Likes, comments, view counts, and thumbnails are not claimed by this version. MP4 media links use random IDs and are public for playback.

The Electron main process sends credentials and session tokens over HTTPS. Passwords are held only for the sign-in request. Session tokens are encrypted with Windows `safeStorage`; the renderer receives neither passwords nor tokens. A pending upload is copied into the per-user temporary queue, retried with the same idempotency key, and retained across restarts. Clipfarm removes that temporary copy and the new capture file only after the server confirms a committed clip ID. Existing local clips and settings are left intact.

### API and deployment

The service contract is `backend/openapi.json`, served at `GET /api/v1/openapi.json`. Available operations are:

- `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `GET /api/v1/auth/session`, `POST /api/v1/auth/refresh`, and `POST /api/v1/auth/logout`.
- `GET /api/v1/clips?sort=uploadedAt&order=desc&cursor=…` for real community clips.
- `POST /api/v1/clips` for an authenticated MP4 upload, with a required `Idempotency-Key`.
- `GET` or `HEAD /api/v1/clips/{id}/media` for byte-range playback.

The production deployment uses Node.js 22 or newer with `node:sqlite`, a loopback-only systemd service on port 4188, a private SQLite/media directory under `/var/lib/clipfarm-api`, and a root-readable environment file containing a generated token secret. Nginx must set `auth_basic off`, `client_max_body_size 2g`, and `proxy_request_buffering off` only in its `/api/v1/` location. The rest of the protected website routes stay unchanged. See `backend/README.md` and `backend/clipfarm-api.service` for the service requirements.
