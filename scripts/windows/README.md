# Windows Client

This directory contains the Windows full-tunnel client and service tooling.

## Current state

Implemented now:

- custom VPN tunnel client to `blockchain-vpn-tun-server` on UDP `7001`
- Windows service supervisor for `blockchain-vpn-tun-client.exe`
- PowerShell controller for install/start/stop/status/health/logs

Not implemented yet:

- Windows app bridge equivalent to the Linux bridge daemon

The current controller must run as Administrator for install/start/stop actions.

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
go build -o .\bin\blockchain-vpn-tun-service.exe .\protocol\udp\cmd\tun-service
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
- optional `BVPN_TUN_SERVICE_BIN`

Each Windows client must use a unique tunnel IP. The default example uses
`10.99.0.3/24` so it does not collide with the Linux example client on
`10.99.0.2/24`.

## Install

Run PowerShell as Administrator:

```powershell
New-Item -ItemType Directory -Force -Path C:\ProgramData\BlockchainVpn\bin
Copy-Item .\bin\blockchain-vpn-tun-client.exe C:\ProgramData\BlockchainVpn\bin\
Copy-Item .\bin\blockchain-vpn-tun-service.exe C:\ProgramData\BlockchainVpn\bin\
Copy-Item .\scripts\windows\blockchain-vpn-windows-client.env.ps1.example C:\ProgramData\BlockchainVpn\blockchain-vpn-windows-client.env.ps1

powershell -ExecutionPolicy Bypass -File .\scripts\windows\blockchain-vpn-windows-client.ps1 install-service -Json
```

## Test

Run PowerShell as Administrator:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\blockchain-vpn-windows-client.ps1 status -Json
powershell -ExecutionPolicy Bypass -File .\scripts\windows\blockchain-vpn-windows-client.ps1 up -Json
powershell -ExecutionPolicy Bypass -File .\scripts\windows\blockchain-vpn-windows-client.ps1 health -Json
powershell -ExecutionPolicy Bypass -File .\scripts\windows\blockchain-vpn-windows-client.ps1 down -Json
powershell -ExecutionPolicy Bypass -File .\scripts\windows\blockchain-vpn-windows-client.ps1 logs -Json
```

If `BVPN_TUN_ROUTE_DEFAULT=true`, successful `health` should show the VPN server public IP.

Useful one-time commands:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\blockchain-vpn-windows-client.ps1 install-service -Json
powershell -ExecutionPolicy Bypass -File .\scripts\windows\blockchain-vpn-windows-client.ps1 is-enabled -Json
powershell -ExecutionPolicy Bypass -File .\scripts\windows\blockchain-vpn-windows-client.ps1 uninstall-service -Json
```

## Notes

- this path targets the custom TUN tunnel on `7001`
- it does not use the encrypted protocol worker on `7000`
- the service is built around `blockchain-vpn-tun-service.exe`, which supervises `blockchain-vpn-tun-client.exe`
- it is cross-built in this repo session; runtime verification still needs an actual Windows host or VM
