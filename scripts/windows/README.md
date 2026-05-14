# Windows Client

Windows full-tunnel client, SCM service supervisor, and the unprivileged
app-bridge daemon that exposes the JSON control surface defined in
`docs/CLIENT_CONTROL_API.md`.

## Components

- `blockchain-vpn-tun-client.exe` — full-tunnel UDP client (cross-built from
  `protocol/udp/cmd/tun-client`).
- `blockchain-vpn-tun-service.exe` — SCM service that supervises the client.
- `blockchain-vpn-app-bridge-service.exe` — SYSTEM Windows Service that drains
  the request spool under `%ProgramData%\BlockchainVpn\bridge` and dispatches
  each command through the PowerShell controller.
- `blockchain-vpn-app-bridge.exe` — unprivileged CLI that posts a request and
  waits for a JSON response; this is what the React Native/web UI calls.
- `blockchain-vpn-windows-client.ps1` — PowerShell controller; talks to the
  tunnel SCM service directly. Used both by an Administrator at the console
  and by `blockchain-vpn-app-bridge-service.exe` to translate spool commands
  into SCM operations.

The tunnel server is on UDP `:443` (see `protocol/udp/cmd/tun-server`).

## Build (from any host with Go)

```powershell
.\scripts\windows\build-windows.ps1
```

Builds all four `bin\blockchain-vpn-*.exe` artifacts. The legacy
`build-tunnel.ps1` still works for the two tunnel binaries only.

## Install (Administrator PowerShell, on the Windows target)

```powershell
.\scripts\windows\install-windows.ps1
```

This:

1. copies the four binaries into `C:\ProgramData\BlockchainVpn\bin\`;
2. seeds `blockchain-vpn-windows-client.env.ps1` if missing;
3. registers and starts the tunnel SCM service (`BlockchainVpnTunnel`);
4. registers and starts the bridge service (`BlockchainVpnAppBridge`).

Once installed, the unprivileged bridge CLI works without elevation:

```powershell
& "C:\ProgramData\BlockchainVpn\bin\blockchain-vpn-app-bridge.exe" status
& "C:\ProgramData\BlockchainVpn\bin\blockchain-vpn-app-bridge.exe" up
& "C:\ProgramData\BlockchainVpn\bin\blockchain-vpn-app-bridge.exe" health
& "C:\ProgramData\BlockchainVpn\bin\blockchain-vpn-app-bridge.exe" down
& "C:\ProgramData\BlockchainVpn\bin\blockchain-vpn-app-bridge.exe" logs 200
```

The response shape matches `docs/CLIENT_CONTROL_API.md` exactly so the UI
adapter can be platform-agnostic.

## Configure

Edit `C:\ProgramData\BlockchainVpn\blockchain-vpn-windows-client.env.ps1`:

- `BVPN_TUN_SERVER_HOST` — VPS public IP/DNS.
- `BVPN_TUN_SERVER_PORT` — usually `443`.
- `BVPN_TUN_AUTO_LEASE = "true"` — required for multi-device; have each
  Windows machine ask the control plane for its own tunnel IP.
- `BVPN_TUN_API_URL` — control plane base (e.g.
  `https://<host>/vpn-api`).
- `BVPN_TUN_CLIENT_ID` (optional) — pin this device to a web-UI
  `device_token` (e.g. `DEV-1234`).

## Uninstall

```powershell
& "C:\ProgramData\BlockchainVpn\scripts\blockchain-vpn-windows-client.ps1" uninstall-service -Json
& "C:\ProgramData\BlockchainVpn\bin\blockchain-vpn-app-bridge-service.exe" uninstall
```

## Files in this directory

- `blockchain-vpn-windows-client.ps1` — PowerShell controller.
- `blockchain-vpn-windows-client.env.ps1.example` — config template.
- `build-windows.ps1` — cross-compile all binaries.
- `build-tunnel.ps1` — legacy two-binary build.
- `install-windows.ps1` — one-shot install.

## Spool layout

The bridge service owns `%ProgramData%\BlockchainVpn\bridge`:

- `requests\<uuid>.json` — written by the unprivileged client.
- `responses\<uuid>.json` — written by the service.
- `status.json` — periodic snapshot of `status` so callers can poll without
  paying a controller round-trip.

ACLs are set to allow `BUILTIN\Users` to drop requests and read responses.
