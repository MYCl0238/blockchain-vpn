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
