# blockchain-vpn

Custom VPN project with:

- Node.js control plane on `backend/control-plane/`
- custom UDP protocol daemon on `protocol/udp/cmd/server`
- cross-platform protocol worker on `protocol/udp/cmd/worker`
- custom full-tunnel server/client on `protocol/udp/cmd/tun-server` and `protocol/udp/cmd/tun-client`
- Linux app bridge and React Native-facing control contract under `scripts/target-client/` and `docs/`

## Current project state

Implemented now:

- control-plane API on port `8787`
- custom UDP daemon on port `7000`
- Linux full tunnel to `blockchain-vpn-tun-server` on port `7001`
- Linux app bridge: unprivileged `blockchain-vpn-app-bridge` + root bridge service
- Windows full-tunnel client implementation and PowerShell test controller
- React Native package scaffold and shared command/result contract

Not implemented yet:

- integration of the encrypted `vpnd` session layer into the full TUN tunnel path
- Android `VpnService` implementation
- Windows service/native app bridge matching the Linux bridge model
- actually testing in windows...
- blockchain identity layer

## Repository structure

- `backend/control-plane/` control-plane daemon
- `protocol/udp/` Go protocol and tunnel binaries
- `deploy/systemd/server/` Linux server units
- `deploy/systemd/client/` Linux client and bridge units
- `scripts/server/` server deployment templates
- `scripts/target-client/` Linux client control, bridge, and worker helpers
- `scripts/windows/` Windows tunnel controller and config examples
- `mobile/` React Native bridge scaffold
- `docs/` bridge and integration docs

## Main binaries

- `bin/blockchain-vpnd`
- `bin/blockchain-vpn-target-worker`
- `bin/blockchain-vpn-tun-server`
- `bin/blockchain-vpn-tun-client`
- `bin/blockchain-vpn-tun-client.exe`

## Main docs

- `docs/README.md`
- `docs/CLIENT_CONTROL_API.md`
- `docs/BRIDGES.md`
- `docs/REACT_NATIVE_INTEGRATION.md`
- `docs/VPN_Interim_Report.docx`
