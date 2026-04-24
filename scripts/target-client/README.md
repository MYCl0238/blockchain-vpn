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

## 3) Full VPN tunnel test (Linux root)

Tam tünel için target cihazda TUN client çalıştır:

```bash
cd ../../protocol/udp
go build -o ../../bin/blockchain-vpn-tun-client ./cmd/tun-client
sudo ../../bin/blockchain-vpn-tun-client \
  --tun bvpntun1 \
  --tun-cidr 10.99.0.2/24 \
  --server <SERVER_IP>:7001 \
  --route-default=true
```

> Not: mobilde root/VPN API olmadan tam sistem tüneli mümkün değildir; mobil için mevcut worker protokol oturumu/keepalive doğrular.
