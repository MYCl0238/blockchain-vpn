# Target Device

Bu klasör, target cihazda sadece bağlantı için gereken minimum dosyaları içerir.

## Kurulum

```bash
cp .env.example .env
# .env içini düzenle
source .env
./connect.sh health
./connect.sh status
./connect.sh connect
./connect.sh status
./connect.sh disconnect
```

## Not
- Bu örnek, sunucudaki profile command'i başlatır/durdurur.
- Gerçek VPN engine bağlandığında aynı akışla kullanılabilir.
