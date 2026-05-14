# Install — Linux desktop

The Linux desktop client is a Tauri AppImage that drives a small
**local control-plane daemon** on `127.0.0.1:8787`. The daemon spawns a
Go binary (`blockchain-vpn-tun-client`) which creates the TUN
interface and tunnels packets to the VPS over UDP `:443`.

The TUN-client needs `CAP_NET_ADMIN` to create the interface and
install routes, so the install puts file capabilities on the binary
instead of running the whole UI as root.

## What you need

- Any modern x86_64 Linux distro with systemd (Ubuntu 22.04+, Fedora 39+, Arch, etc.)
- `node` ≥ 18 (for the local control-plane)
- `libfuse2` (most distros — the AppImage runtime needs it)
- `setcap` from `libcap2-bin` (Debian/Ubuntu) or `libcap` (Fedora/Arch)

## 1. Install the AppImage

Download the latest `blockchain-vpn.AppImage` from the
[Releases page](https://github.com/MYCl0238/blockchain-vpn/releases/latest):

```bash
mkdir -p ~/Applications
curl -L -o ~/Applications/blockchain-vpn.AppImage \
  https://github.com/MYCl0238/blockchain-vpn/releases/latest/download/blockchain-vpn.AppImage
chmod +x ~/Applications/blockchain-vpn.AppImage
```

## 2. Install the local control-plane daemon

```bash
sudo mkdir -p /opt/blockchain-vpn/control-plane
sudo cp -r backend/control-plane/* /opt/blockchain-vpn/control-plane/
sudo cp deploy/systemd/client/blockchain-vpn-control-plane.service \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now blockchain-vpn-control-plane
```

Sanity check:

```bash
curl -s http://127.0.0.1:8787/v1/status
# → {"connected":false,"profileId":null,"pid":null,...}
```

## 3. Install the tun-client binary

Build it from source (Go ≥ 1.21):

```bash
cd protocol/udp/cmd/tun-client
go build -o blockchain-vpn-tun-client .
sudo install -m 0755 blockchain-vpn-tun-client /usr/local/bin/
sudo setcap cap_net_admin,cap_net_raw+ep /usr/local/bin/blockchain-vpn-tun-client
```

The `setcap` line is what lets the unprivileged daemon spawn the
TUN binary without sudo. If you skip it, `up()` will fail with
"Operation not permitted" when the binary tries to `ip addr replace`.

> If the daemon needs to install a default route (which is the
> normal case for full-tunnel mode), the **service unit ships as
> `User=root`** so spawned `ip` calls inherit the privileges. This
> sidesteps the well-known capability-inheritance hole in
> `exec`'d processes.

## 4. Launch the app

```bash
~/Applications/blockchain-vpn.AppImage
```

You'll see a Login screen. Either:

- **Register** — generates a new account key (the 16-char ID), stored
  on the server, copied to your clipboard. **Write it down**: it's the
  only way to log back in.
- **Login** — paste your account key.

Hit **Connect VPN**. The dashboard should flip to "Connected" within a
couple seconds. Verify:

```bash
curl https://ipinfo.io/ip
# should now show the VPS public IP (e.g. 84.21.171.106)
```

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Button shows "Loading" then goes back to "Disconnect" with no error | The control-plane URL was misconfigured | Check `dashboard.tsx`'s `controlBaseUrl` resolves to `http://127.0.0.1:8787` on Linux |
| `connect refused` to `127.0.0.1:8787` | Daemon not running | `sudo systemctl status blockchain-vpn-control-plane` |
| `ip addr replace ... Operation not permitted` | Missing capabilities on tun-client | Re-run the `setcap` step above |
| No public-IP change after connect | Route not installed or tun-server unreachable | Check `ip route show table all`; verify VPS is up |
| `libfuse.so.2: cannot open` | Missing AppImage runtime dep | `sudo apt install libfuse2` (or distro equivalent) |

## Uninstall

```bash
sudo systemctl disable --now blockchain-vpn-control-plane
sudo rm /etc/systemd/system/blockchain-vpn-control-plane.service
sudo rm -rf /opt/blockchain-vpn /var/lib/blockchain-vpn
sudo rm /usr/local/bin/blockchain-vpn-tun-client
rm ~/Applications/blockchain-vpn.AppImage
sudo systemctl daemon-reload
```
