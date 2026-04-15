# UDP protocol (Go)

Build:

```bash
cd protocol/udp
go mod tidy
go build -o ../../bin/blockchain-vpnd ./cmd/server
go build -o ../../bin/blockchain-vpnd-client ./cmd/client
```

Run local client test:

```bash
set -a; source ~/.config/blockchain-vpn/proto.env; set +a
PROTO_SERVER_HOST=127.0.0.1 PROTO_SERVER_PORT=$PROTO_PORT ../../bin/blockchain-vpnd-client
```
