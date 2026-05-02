# Server Scripts

This directory contains server-side deployment helpers for the custom tunnel server.

## Main files

- `deploy/systemd/server/blockchain-vpn-api.service`
- `deploy/systemd/server/blockchain-vpnd.service`
- `deploy/systemd/server/blockchain-vpn-tun-server.service`
- `scripts/server/blockchain-vpn-tun-server.env.example`

## Tunnel server install example

```bash
cd protocol/udp
go build -o ../../bin/blockchain-vpn-tun-server ./cmd/tun-server

sudo install -m 0755 ../../bin/blockchain-vpn-tun-server /usr/local/bin/blockchain-vpn-tun-server
sudo install -m 0644 ../../deploy/systemd/server/blockchain-vpn-tun-server.service /etc/systemd/system/blockchain-vpn-tun-server.service
sudo install -m 0644 ../../scripts/server/blockchain-vpn-tun-server.env.example /etc/default/blockchain-vpn-tun-server
sudo systemctl daemon-reload
sudo systemctl enable --now blockchain-vpn-tun-server.service
```
