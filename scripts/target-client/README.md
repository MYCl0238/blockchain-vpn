# Target Device

Bu klasör, target cihazda bağlantı için gereken minimum dosyaları içerir.

## 1) Control-plane test (opsiyonel)

```bash
cp .env.example .env
source .env
./connect.sh health
./connect.sh status
./connect.sh connect
./connect.sh disconnect
```

## 2) Target client worker (mobil + PC)

Worker, **root/TUN gerektirmeden** UDP protokol keepalive trafiği üretir.
Bu haliyle Android (Termux), Linux, macOS ve Windows (WSL/Git Bash) üzerinde çalışır.

```bash
cp .env.example .env
source .env
./run-worker.sh
```

## Build (target cihazda)

```bash
cd ../../protocol/udp
go build -o ../../bin/blockchain-vpn-target-worker ./cmd/worker
```

## Not
- `connect.sh` sunucudaki profile process yönetimi içindir (control-plane).
- `run-worker.sh` target cihazdan protokol oturumu açar ve sürekli keepalive gönderir.
- Full VPN data-plane (tüm internet trafiğini tünelden geçirmek) için ayrıca TUN + route katmanı eklenmelidir.
