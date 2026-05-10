# Target Client

This directory contains Linux target-device helpers and the shared protocol worker launcher.

## Components

- `connect.sh`
  Optional control-plane smoke test helper.

- `run-worker.sh`
  Cross-platform protocol worker launcher for the UDP keepalive/session path on port `7000`.

- `blockchain-vpn-client-tunnel`
  Root wrapper that starts or stops the Linux tunnel backend.

- `blockchain-vpn-tunnelctl`
  Low-level Linux control script with JSON output.

- `blockchain-vpn-app-bridge`
  Unprivileged Linux app-facing command.

- `blockchain-vpn-app-bridge-runner`
  Root runner used by the bridge daemon.

- `blockchain-vpn-app-bridge-service.py`
  Root bridge daemon handling JSON request/response files.

## Linux full tunnel

Each device must use a unique tunnel IP in `10.99.0.0/24`. The Linux examples
use `10.99.0.2/24`; do not reuse that same client IP on Windows or another
device.

Main Linux service files:

- `deploy/systemd/client/blockchain-vpn-target-client.service`
- `deploy/systemd/client/blockchain-vpn-app-bridge.service`
- `scripts/target-client/blockchain-vpn-target-client.env.example`
- `scripts/target-client/blockchain-vpn-app-bridge.env.example`

Install example:

```bash
sudo install -m 0755 scripts/target-client/blockchain-vpn-client-tunnel /usr/local/bin/blockchain-vpn-client-tunnel
sudo install -m 0755 scripts/target-client/blockchain-vpn-tunnelctl /usr/local/bin/blockchain-vpn-tunnelctl
sudo install -m 0755 scripts/target-client/blockchain-vpn-app-bridge /usr/local/bin/blockchain-vpn-app-bridge
sudo install -m 0755 scripts/target-client/blockchain-vpn-app-bridge-runner /usr/local/bin/blockchain-vpn-app-bridge-runner
sudo install -m 0755 scripts/target-client/blockchain-vpn-app-bridge-service.py /usr/local/bin/blockchain-vpn-app-bridge-service.py
sudo install -m 0644 deploy/systemd/client/blockchain-vpn-target-client.service /etc/systemd/system/blockchain-vpn-target-client.service
sudo install -m 0644 deploy/systemd/client/blockchain-vpn-app-bridge.service /etc/systemd/system/blockchain-vpn-app-bridge.service
sudo install -m 0644 scripts/target-client/blockchain-vpn-target-client.env.example /etc/default/blockchain-vpn-target-client
sudo install -m 0644 scripts/target-client/blockchain-vpn-app-bridge.env.example /etc/default/blockchain-vpn-app-bridge
sudo systemctl daemon-reload
sudo systemctl enable --now blockchain-vpn-target-client.service
sudo systemctl enable --now blockchain-vpn-app-bridge.service
```

## Linux control examples

Root control:

```bash
sudo blockchain-vpn-tunnelctl --json status
sudo blockchain-vpn-tunnelctl --json health
sudo blockchain-vpn-tunnelctl --json up
sudo blockchain-vpn-tunnelctl --json down
```

App-facing bridge:

```bash
blockchain-vpn-app-bridge status
blockchain-vpn-app-bridge health
blockchain-vpn-app-bridge up
blockchain-vpn-app-bridge down
```

## Worker mode

The protocol worker is still useful for:

- session/keepalive testing against `blockchain-vpnd` on `7000`
- future mobile-side non-root integration work

Run it with:

```bash
cp .env.example .env
source .env
./run-worker.sh
```
