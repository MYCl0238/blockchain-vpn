# vpn_project

Express/EJS app for:

- user registration and login
- device slot management
- VPS-hosted VPN monitoring/demo UI
- Linux local VPN control when the app runs on the target machine

## Important architecture note

There are two valid app modes:

- `local-bridge`
  The app runs on the Linux target device and can call the local `blockchain-vpn-app-bridge` to actually connect or disconnect that device.

- `remote-monitor`
  The app runs on the VPS and monitors the existing `blockchain-vpn` control-plane API. In this mode it cannot tunnel the visitor browser session or the visitor machine.

A normal VPS-hosted web app cannot create a real browser-only VPN session for the client machine with the current custom tunnel architecture. That would require either:

- a local agent on the client machine
- or a browser-extension/proxy design

A normal web page also cannot force the user browser to route all internet traffic through the VPN. For browser-only tunneling, the next implementation step must be a browser extension or an explicit proxy configuration that the browser uses.

## Current routes

Protected routes:

- `GET /api/vpn/config`
- `GET /api/vpn/status`
- `GET /api/vpn/health`
- `POST /api/vpn/connect`
- `POST /api/vpn/disconnect`

## Environment

Copy `.env.example` to `.env`.

### Local Linux control mode

Use:

- `BVPN_UI_MODE=local-bridge`
- `BVPN_APP_BRIDGE_ENABLED=true`
- `BVPN_APP_BRIDGE_BIN=/usr/local/bin/blockchain-vpn-app-bridge`

### VPS monitoring mode

Use:

- `BVPN_UI_MODE=remote-monitor`
- `BVPN_CONTROL_BASE_URL=http://127.0.0.1:8787`
- `BVPN_CONTROL_TOKEN=...`

In remote monitor mode, connect/disconnect is intentionally disabled in the UI.

## Database

Apply schema:

```bash
psql -d vpn_project -f db/schema.sql
```

Required tables:

- `users`
- `devices`

## Sessions

Sessions are stored in PostgreSQL through `connect-pg-simple`.

Relevant env vars:

- `SESSION_COOKIE_NAME`
- `SESSION_TABLE`
- `SESSION_MAX_AGE_MS`
- `SESSION_SECURE_COOKIE`
- `TRUST_PROXY`

## Public access

On the current VPS layout, this app is exposed directly on its own TCP port instead of replacing the existing Nginx default site.

## Start

```bash
npm install
npm start
```
