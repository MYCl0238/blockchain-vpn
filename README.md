# blockchain-vpn

## Repository Structure

- `backend/control-plane/` → API, metrics endpoints
- `protocol/udp/` → UDP + AEAD protocol
- `frontend/` → web dashboard (to be implemented)
- `mobile/` → mobile client (to be implemented)
- `deploy/systemd/` → service units
- `scripts/` → CLI helpers + target client scripts
- `docs/` → architecture and integration notes
- `data/` → runtime state (profiles, protocol sessions, events)

## Running Services (user systemd)

- `blockchain-vpn-api.service` (port 8787)
- `blockchain-vpnd.service` (UDP 7000)

## New Backend APIs for protocol monitoring

Authenticated endpoints (Bearer token):

- `POST /v1/proto/keepalive`
- `POST /v1/proto/events`
- `GET /v1/proto/sessions`
- `GET /v1/proto/sessions/:id`
- `GET /v1/proto/events?limit=100`
- `GET /v1/proto/metrics`

## Profile process note

- Control-plane `connect` now starts a **real process** for profile `demo` (Go protocol daemon), not sleep.
- Profile template can be re-applied with `scripts/set-demo-profile.sh`.
- Full VPN data-plane için Linux'ta TUN katmanı eklendi (`cmd/tun-server`, `cmd/tun-client`).


## Target client worker (mobile + PC)

- Added `protocol/udp/cmd/worker` as persistent cross-platform client worker (no TUN/root requirement).
- Launcher: `scripts/target-client/run-worker.sh`
- Build output: `bin/blockchain-vpn-target-worker`


## Full tunnel workers (Linux)

- Server worker: `protocol/udp/cmd/tun-server` -> `bin/blockchain-vpn-tun-server`
- Client worker: `protocol/udp/cmd/tun-client` -> `bin/blockchain-vpn-tun-client`
- Gereksinim: root + `/dev/net/tun` + iptables (server tarafında NAT için)
