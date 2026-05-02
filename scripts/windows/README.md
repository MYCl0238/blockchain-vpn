# Windows Client

This directory contains the Windows full-tunnel test tooling.

## Current state

Implemented now:

- custom VPN tunnel client to `blockchain-vpn-tun-server` on UDP `7001`
- PowerShell controller for `up`, `down`, `status`, `health`, and `logs`

Not implemented yet:

- Windows service install flow
- Windows app bridge equivalent to the Linux bridge daemon

The current controller must run as Administrator.

## Files

- `blockchain-vpn-windows-client.ps1`
- `blockchain-vpn-windows-client.env.ps1.example`
- `build-tunnel.ps1`

## Build

```powershell
.\scripts\windows\build-tunnel.ps1
```

Or:

```powershell
$env:GOOS = "windows"
$env:GOARCH = "amd64"
go build -o .\bin\blockchain-vpn-tun-client.exe .\protocol\udp\cmd\tun-client
```

## Configure

Copy:

```powershell
C:\ProgramData\BlockchainVpn\blockchain-vpn-windows-client.env.ps1
```

Set:

- `BVPN_TUN_SERVER_HOST`
- `BVPN_TUN_SERVER_PORT`
- `BVPN_TUN_CIDR`
- `BVPN_TUN_GATEWAY`

## Test

Run PowerShell as Administrator:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\blockchain-vpn-windows-client.ps1 status -Json
powershell -ExecutionPolicy Bypass -File .\scripts\windows\blockchain-vpn-windows-client.ps1 up -Json
powershell -ExecutionPolicy Bypass -File .\scripts\windows\blockchain-vpn-windows-client.ps1 health -Json
powershell -ExecutionPolicy Bypass -File .\scripts\windows\blockchain-vpn-windows-client.ps1 down -Json
```

If `BVPN_TUN_ROUTE_DEFAULT=true`, successful `health` should show the VPN server public IP.

## Notes

- this path targets the custom TUN tunnel on `7001`
- it does not use the encrypted protocol worker on `7000`
- it was cross-compiled in this repo session but not runtime-tested on a Windows host here
