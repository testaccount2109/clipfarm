# Clipfarm community backend

This Node.js service backs the Electron account, profile, upload, and community-feed flows.
It uses Node's built-in SQLite driver and crypto APIs; it has no runtime npm
dependencies. The production service listens only on 127.0.0.1:4188 and is
published through the existing HTTPS Nginx virtual host at
https://benni-projects.de/api/v1/.

## API

The public contract is openapi.json, also served at GET /api/v1/openapi.json.
GET /api/v1/health is the unauthenticated service check. Registration and login
take a username and password over HTTPS. Passwords are stored as per-user salted
scrypt hashes. Short-lived access tokens and rotating refresh tokens are kept
in Electron's OS-backed safeStorage; the renderer never receives either token.

Authenticated profile routes read and update display names, bios, avatars, and
clip-sharing privacy settings. Existing deployments that do not yet expose
`/profile` remain compatible with clip uploads; profile editing requires this
updated backend.

Uploads stream to a temporary server file and become visible only after the
server verifies the MP4 header and commits the clip record. A repeated
Idempotency-Key returns the already committed clip. The desktop client retains
its staged file until that response includes the committed clip ID. Media uses
signed playback URLs and HTTP byte ranges; feed visibility follows profile
sharing settings. No likes,
comments, view counts, or thumbnail URLs are claimed by this first API version.
The feed uses a designed frame placeholder until a real thumbnail service exists.

## Production host

The systemd unit expects:

- /opt/clipfarm-api/node, a trusted Node.js 22 or newer executable with node:sqlite
- /etc/clipfarm-api.env, readable only by root and the service group
- /var/lib/clipfarm-api owned by clipfarm-api
- /opt/clipfarm-api/node, server.js, and openapi.json
- Nginx proxying /api/v1/ to http://127.0.0.1:4188 with auth_basic off
- A valid TLS certificate for benni-projects.de; port 80 redirects to HTTPS

Required environment values are CLIPFARM_TOKEN_SECRET (64 hex characters),
CLIPFARM_PUBLIC_ORIGIN=https://benni-projects.de,
CLIPFARM_API_HOST=127.0.0.1, CLIPFARM_API_PORT=4188, and
CLIPFARM_DATA_DIR=/var/lib/clipfarm-api. Keep the secret out of the repository
and shell history. Database and media files are retained across service updates.

The upload limit is 2 GB. Nginx must disable request buffering on this API route
so large MP4s stream to the service rather than being held by Nginx first.

Keep the runtime in the service directory so ProtectHome=true can stay enabled
even when the host's interactive Node installation lives under a home directory.
