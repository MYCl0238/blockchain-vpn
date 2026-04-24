# UDP protocol (Go)

Build:

```bash
cd protocol/udp
go mod tidy
go build -o ../../bin/blockchain-vpnd ./cmd/server
go build -o ../../bin/blockchain-vpnd-client ./cmd/client
go build -o ../../bin/blockchain-vpn-target-worker ./cmd/worker
go build -o ../../bin/blockchain-vpn-tun-server ./cmd/tun-server
go build -o ../../bin/blockchain-vpn-tun-client ./cmd/tun-client
```

Run one-shot local client test:

```bash
set -a; source ~/.config/blockchain-vpn/proto.env; set +a
PROTO_SERVER_HOST=127.0.0.1 PROTO_SERVER_PORT=$PROTO_PORT ../../bin/blockchain-vpnd-client
```

Run persistent target worker (mobile + PC friendly):

```bash
set -a; source scripts/target-client/.env; set +a
../../bin/blockchain-vpn-target-worker
```

## Full tunnel mode (Linux root required)

Server:

```bash
sudo ../../bin/blockchain-vpn-tun-server \
  --tun bvpntun0 \
  --tun-cidr 10.99.0.1/24 \
  --listen :7001 \
  --wan-if eth0 \
  --enable-nat=true
```

Client:

```bash
sudo ../../bin/blockchain-vpn-tun-client \
  --tun bvpntun1 \
  --tun-cidr 10.99.0.2/24 \
  --server SERVER_IP:7001 \
  --route-default=true
```
