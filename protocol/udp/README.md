# UDP Protocol

This module contains two separate paths:

- encrypted protocol/session path for `blockchain-vpnd` on UDP `7000`
- custom full-tunnel path for `tun-server` and `tun-client` on UDP `7001`

They are not integrated into a single encrypted tunnel path yet.

## Build

```bash
cd protocol/udp
go mod tidy
go build -o ../../bin/blockchain-vpnd ./cmd/server
go build -o ../../bin/blockchain-vpnd-client ./cmd/client
go build -o ../../bin/blockchain-vpn-target-worker ./cmd/worker
go build -o ../../bin/blockchain-vpn-tun-server ./cmd/tun-server
go build -o ../../bin/blockchain-vpn-tun-client ./cmd/tun-client
GOOS=windows GOARCH=amd64 go build -o ../../bin/blockchain-vpn-tun-client.exe ./cmd/tun-client
```

## Protocol worker path

One-shot client test:

```bash
set -a; source ~/.config/blockchain-vpn/proto.env; set +a
PROTO_SERVER_HOST=127.0.0.1 PROTO_SERVER_PORT=$PROTO_PORT ../../bin/blockchain-vpnd-client
```

Persistent worker:

```bash
set -a; source scripts/target-client/.env; set +a
../../bin/blockchain-vpn-target-worker
```

## Full tunnel path

Linux server:

```bash
sudo ../../bin/blockchain-vpn-tun-server \
  --tun bvpntun0 \
  --tun-cidr 10.99.0.1/24 \
  --listen :7001 \
  --wan-if eth0 \
  --enable-nat=true
```

Linux client:

```bash
sudo ../../bin/blockchain-vpn-tun-client \
  --tun bvpntun1 \
  --tun-cidr 10.99.0.2/24 \
  --server SERVER_IP:7001 \
  --route-default=true
```

Windows client:

```powershell
.\bin\blockchain-vpn-tun-client.exe --tun bvpntun1 --tun-cidr 10.99.0.2/24 --tun-gateway 10.99.0.1 --server SERVER_IP:7001 --route-default=true
```
