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

## 4) systemd service ile tek komut tünel aç/kapat (Linux)

Bu repo içinde:
- Script: `scripts/target-client/blockchain-vpn-client-tunnel`
- Service unit: `deploy/systemd/client/blockchain-vpn-target-client.service`

Kurulum örneği:

```bash
sudo install -m 0755 scripts/target-client/blockchain-vpn-client-tunnel /usr/local/bin/blockchain-vpn-client-tunnel
sudo install -m 0644 deploy/systemd/client/blockchain-vpn-target-client.service /etc/systemd/system/blockchain-vpn-target-client.service
sudo systemctl daemon-reload
sudo systemctl enable --now blockchain-vpn-target-client.service
```

Servis varsayılan olarak WireGuard bekler (`wg-quick`). OpenVPN için `/etc/default/blockchain-vpn-target-client` içinde örn:

```bash
BVPN_TUN_BACKEND=openvpn
BVPN_TUN_PROFILE=myprofile
```
