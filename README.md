# blockchain-vpn

End-to-end VPN stack: custom UDP tunnel, a control-plane to manage it,
and clients for Linux, Android, Windows, and the browser.

## What's in here

```
backend/control-plane/   Node.js control-plane (UDP tunnel + lease orchestration)
protocol/udp/            Go protocol: tun-server, tun-client, app-bridge, worker
deploy/systemd/          Linux systemd units (server + client + bridge)
scripts/server/          Server install templates
scripts/target-client/   Linux client install + helpers
scripts/windows/         Windows tunnel controller + service configs
mobile/                  Native Expo Module (Android VpnService bridge)
apps/cross-platform-app/ Expo app — Android + Linux desktop (via Tauri)
webui/                   Express user-management + dashboard (formerly vpn_project)
browser-extensions/      Browser extension that pairs with the webui
frontend/                Legacy frontend bits (kept for reference)
docs/                    Architecture + integration docs + per-OS install guides
```

## Clients, at a glance

| Client                | Status      | How it tunnels                                                                           |
| --------------------- | ----------- | ---------------------------------------------------------------------------------------- |
| Linux desktop (Tauri) | working     | Local control-plane daemon (`:8787`) spawns `blockchain-vpn-tun-client` with CAP_NET_ADMIN |
| Android (Expo)        | working     | Native Expo Module wrapping `android.net.VpnService`, talks to cloud control-plane        |
| Windows               | partial     | SCM service + unprivileged CLI; tunnel comes up, TCP from inside VM is deferred           |
| Browser extension     | working     | Pairs with the webui to push squid proxy credentials                                      |

See [docs/INSTALL_LINUX.md](docs/INSTALL_LINUX.md),
[docs/INSTALL_WINDOWS.md](docs/INSTALL_WINDOWS.md), and
[docs/INSTALL_ANDROID.md](docs/INSTALL_ANDROID.md) for end-user installs.
Built artifacts are published on the
[GitHub Releases page](https://github.com/MYCl0238/blockchain-vpn/releases).

## Production VPS layout

What runs on the server (Ubuntu 24.04):

- **nginx** — fronts the webui and reverse-proxies `/vpn-api/` to the control-plane
- **`blockchain-vpn-tun-server`** — UDP `:443`, the actual tunnel terminator
- **control-plane** — `:8787` (loopback), spawns/manages tun-server peers and leases
- **webui** (`vpn-project.service`) — Express on `:3000`, behind nginx
- **postgres** — user store for the webui

Last verified 2026-05-13.

## Backend pieces

- control-plane API on port `8787` (and nginx-proxied at `/vpn-api/` on the public VPS)
- custom UDP daemon on port `7000` (legacy worker channel)
- Full tunnel to `blockchain-vpn-tun-server` on UDP `:443`
- Per-device tunnel-lease allocation hooked into the webui (device_token → control-plane clientId)
- Multi-peer custom tunnel routing on the server side for distinct client tunnel IPs

## Binaries

`bin/` is a **build output directory and is gitignored** — it's never
committed. End users should grab prebuilt artifacts from the
[Releases page](https://github.com/MYCl0238/blockchain-vpn/releases);
developers build locally with `bash scripts/build.sh`.

Resulting binaries (Linux + Windows cross-compiled):

| Binary                                 | Platform | Used by                       |
| -------------------------------------- | -------- | ----------------------------- |
| `blockchain-vpnd`                      | Linux    | server (legacy worker)        |
| `blockchain-vpn-target-worker`         | Linux    | server / target nodes         |
| `blockchain-vpn-tun-server`            | Linux    | VPS tunnel terminator         |
| `blockchain-vpn-tun-client` / `.exe`   | both     | client tunnel endpoint        |
| `blockchain-vpn-tun-service.exe`       | Windows  | legacy SCM tunnel supervisor  |
| `blockchain-vpn-app-bridge` / `.exe`   | both     | legacy file-spool bridge CLI  |
| `blockchain-vpn-app-bridge-service.exe`| Windows  | legacy app-bridge SCM service |

To build per-binary, see `protocol/udp/cmd/`.

## Docs

- [docs/INSTALL_LINUX.md](docs/INSTALL_LINUX.md) — Linux desktop install
- [docs/INSTALL_WINDOWS.md](docs/INSTALL_WINDOWS.md) — Windows desktop install
- [docs/INSTALL_ANDROID.md](docs/INSTALL_ANDROID.md) — Android install
- [docs/CLIENT_CONTROL_API.md](docs/CLIENT_CONTROL_API.md) — control-plane HTTP API
- [docs/BRIDGES.md](docs/BRIDGES.md) — app-bridge protocol (Linux + Windows)
- [docs/REACT_NATIVE_INTEGRATION.md](docs/REACT_NATIVE_INTEGRATION.md) — Expo Module integration

## Not done

- Encrypted `vpnd` session layer integrated into the full TUN path
- Windows TCP-from-VM connectivity (tunnel up, packets flow, TCP handshake stalls)
- Blockchain identity layer
