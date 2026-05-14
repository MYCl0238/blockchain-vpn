# Install — Windows

Two pieces:

1. **Backend services** — `tun-client.exe` (creates the wintun device,
   talks UDP to the VPS) and the **local control-plane daemon** on
   `http://127.0.0.1:8787` (HTTP API the desktop UI uses). Installed
   via `install-windows.ps1`, registered as a Scheduled Task running
   as SYSTEM at boot.
2. **Desktop UI** — the same Tauri app that ships for Linux, built
   for Windows. Same screens as Linux: login, dashboard with
   Connect/Disconnect, profile.

> **Status**: The install script, daemon, and tun-client all run.
> Tunnel UDP flows in both directions and ICMP echo replies are
> visible on the wire. End-to-end TCP through the tunnel is still
> being debugged on Windows (a routing/source-IP-selection quirk).
> See "Known issues" below.

## What you need

- Windows 10/11 x64
- An elevated **Administrator PowerShell** for installation
- ~200 MB free disk space
- Internet access for the installer's Node.js dependency (auto-installed via `winget`)

## 1. Install the backend (one command)

Grab the latest `blockchain-vpn-windows.zip` from the
[Releases page](https://github.com/MYCl0238/blockchain-vpn/releases/latest),
unzip it somewhere (e.g. `C:\bvpn-stage\`), and from an elevated
PowerShell:

```powershell
cd C:\bvpn-stage
.\scripts\windows\install-windows.ps1
```

What it does:

1. Stops any old services holding the binaries.
2. Copies `tun-client.exe`, `wintun.dll`, and helpers into
   `C:\ProgramData\BlockchainVpn\bin\`.
3. Copies the Node.js control-plane daemon into
   `C:\ProgramData\BlockchainVpn\control-plane\`.
4. Installs Node.js (via `winget`) if it isn't already on PATH.
5. Registers a Scheduled Task `BlockchainVpnControlPlane` that runs
   `node daemon.js` as **SYSTEM** at boot. Starts it immediately.
6. Smoke-checks `http://127.0.0.1:8787/v1/status` and prints OK.

Add `-LegacyBridge` to also install the older file-spool bridge
(`blockchain-vpn-app-bridge.exe` CLI + SCM tun-service). Off by
default — the new Tauri UI uses the HTTP daemon.

After install, verify by hand:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/v1/status
# → connected:false, profileId:null, ...

Get-ScheduledTask BlockchainVpnControlPlane | ft TaskName,State
# → TaskName: BlockchainVpnControlPlane   State: Running
```

## 2. Install the desktop app

The Tauri Windows build produces a `.msi` (or `.exe` installer). It
must be built on Windows (Tauri's Windows toolchain doesn't
cross-compile cleanly from Linux).

### Option A — Sideload the prebuilt installer

Download `blockchain-vpn-setup.msi` from the latest
[GitHub release](https://github.com/MYCl0238/blockchain-vpn/releases/latest)
and double-click to install. The app appears in Start Menu as
**Blockchain VPN**.

### Option B — Build from source

On Windows 10/11:

```powershell
# 1. Toolchains (~5 GB)
winget install Microsoft.VisualStudio.2022.BuildTools --silent --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools"
winget install Rustlang.Rustup --silent
winget install OpenJS.NodeJS --silent
rustup default stable-x86_64-pc-windows-msvc

# 2. From the repo root:
cd apps\cross-platform-app
npm install
npx tauri build --bundles msi nsis

# Output: src-tauri\target\release\bundle\msi\Blockchain VPN_0.1.0_x64_en-US.msi
```

## 3. Launch it

`Start Menu → Blockchain VPN`. Same login screen as Linux — sign in
with your 16-char account key, then hit **Connect VPN**. The UI
talks to `http://127.0.0.1:8787` (the local daemon installed in
step 1), which spawns `tun-client.exe` and brings up `bvpntun1`.

## Quick sanity check

```powershell
# bvpntun1 should appear with 10.99.0.x address
Get-NetIPAddress -InterfaceAlias bvpntun1 | ft IPAddress,InterfaceAlias

# daemon log
Get-Content C:\ProgramData\BlockchainVpn\logs\control-plane.log -Tail 30

# tun-client log
Get-Content C:\ProgramData\BlockchainVpn\logs\tun-client.log -Tail 30
```

## Known issues

- **TCP from the host doesn't fully complete through the tunnel.**
  The tunnel comes up, packets flow bidirectionally over UDP, and
  the inner ICMP echo replies are observable on the wire. But
  Windows' source-address selection sometimes picks the LAN IP
  (`192.168.x.y`) when sending via `bvpntun1`, which the tun-client
  then filters as out-of-tunnel-CIDR. Net effect: pings/curls time
  out unless you force `ping -S 10.99.0.x`. Fix in progress; track
  in the repo. The Linux build does not have this issue.

- **`Get-NetIPInterface` reports `InterfaceMetric` as blank** until
  you set it explicitly. The tun-client now does this on bring-up
  (`InterfaceMetric=1`), but if you ran the legacy installer in the
  past, restart the tun-client service to apply.

## Uninstall

```powershell
# Stop services / tasks
Stop-ScheduledTask BlockchainVpnControlPlane
Unregister-ScheduledTask BlockchainVpnControlPlane -Confirm:$false
Stop-Service BlockchainVpnTunnel    -ErrorAction SilentlyContinue
Stop-Service BlockchainVpnAppBridge -ErrorAction SilentlyContinue
sc.exe delete BlockchainVpnTunnel    | Out-Null
sc.exe delete BlockchainVpnAppBridge | Out-Null

# Files
Remove-Item -Recurse -Force C:\ProgramData\BlockchainVpn

# Desktop app: Settings -> Apps -> Blockchain VPN -> Uninstall
```
