# blockchain-vpn

## Repository Structure

- `backend/control-plane/` → server-side API + control-plane daemon
- `protocol/udp/` → UDP + AEAD protocol implementation
- `frontend/` → web dashboard (to be implemented)
- `mobile/` → mobile client (to be implemented)
- `deploy/systemd/server/` → server service units
- `deploy/systemd/client/` → target client service units
- `scripts/server/` → server-side helper scripts
- `scripts/target-client/` → target client scripts (worker + tunnel)
- `docs/` → interim report (`VPN_Interim_Report.docx`)
- `data/` → runtime state (profiles, protocol sessions, events)

## Running Services

### Server (user/systemd)

- `deploy/systemd/server/blockchain-vpn-api.service` (port 8787)
- `deploy/systemd/server/blockchain-vpnd.service` (UDP 7000)

### Target client (root/systemd)

- `deploy/systemd/client/blockchain-vpn-target-client.service`
- Requires `/usr/local/bin/blockchain-vpn-client-tunnel`

## New Backend APIs for protocol monitoring

Authenticated endpoints (Bearer token):

- `POST /v1/proto/keepalive`
- `POST /v1/proto/events`
- `GET /v1/proto/sessions`
- `GET /v1/proto/sessions/:id`
- `GET /v1/proto/events?limit=100`
- `GET /v1/proto/metrics`

## Target client worker (mobile + PC)

- Added `protocol/udp/cmd/worker` as persistent cross-platform client worker (no TUN/root requirement).
- Launcher: `scripts/target-client/run-worker.sh`
- Build output: `bin/blockchain-vpn-target-worker`

## Full tunnel workers (Linux)

- Server worker: `protocol/udp/cmd/tun-server` -> `bin/blockchain-vpn-tun-server`
- Client worker: `protocol/udp/cmd/tun-client` -> `bin/blockchain-vpn-tun-client`
- Requirement: root + `/dev/net/tun` + iptables/nftables (NAT on server side)
