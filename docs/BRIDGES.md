# Bridges

This document explains the platform bridge layer between app code and VPN internals.

## Purpose

App code should call a narrow control surface and receive JSON back.

App code should not:

- call `sudo`
- call `systemctl`
- manipulate routes directly
- parse OS-specific logs as its main API

## Linux bridge

Linux is the most complete bridge implementation in the repo.

Components:

- `blockchain-vpn-app-bridge`
- `blockchain-vpn-app-bridge-service.py`
- `blockchain-vpn-app-bridge-runner`
- `blockchain-vpn-tunnelctl`
- `blockchain-vpn-target-client.service`

Flow:

1. App or native helper calls `blockchain-vpn-app-bridge <command>`.
2. The client writes a JSON request into `/var/lib/blockchain-vpn/bridge/requests`.
3. The root service detects the request.
4. The service runs `blockchain-vpn-app-bridge-runner`.
5. The runner calls `blockchain-vpn-tunnelctl --json <command>`.
6. The service writes the JSON response into `/var/lib/blockchain-vpn/bridge/responses`.
7. The client reads and returns that JSON.

This lets the app trigger VPN actions without being root.

## Windows bridge

Windows now mirrors the Linux file-spool model.

Components:

- `protocol/udp/cmd/tun-client` — full-tunnel UDP client.
- `protocol/udp/cmd/tun-service` — SCM service that supervises tun-client.
- `protocol/udp/cmd/app-bridge` — unprivileged CLI; what the UI/native module calls.
- `protocol/udp/cmd/app-bridge-service` — SYSTEM Windows Service that drains the spool and dispatches commands through the PowerShell controller.
- `scripts/windows/blockchain-vpn-windows-client.ps1` — PowerShell controller; called by the bridge service to translate JSON commands into SCM operations.

Flow:

1. App or native helper calls `blockchain-vpn-app-bridge.exe <command>`.
2. The client writes a JSON request into `%ProgramData%\BlockchainVpn\bridge\requests`.
3. The SYSTEM bridge service detects the request.
4. The bridge service runs `powershell.exe ... blockchain-vpn-windows-client.ps1 <command> -Json`.
5. The PowerShell controller talks to the tunnel SCM service.
6. The bridge service writes the JSON response into `%ProgramData%\BlockchainVpn\bridge\responses`.
7. The client reads and returns that JSON.

Like the Linux side, this lets unprivileged UI code trigger Administrator-only VPN actions without prompting the user for elevation per command. ACLs on the spool grant `BUILTIN\Users` modify rights so any logged-in user can post requests.

## Android bridge

Android should not copy the Linux root service design.

Planned implementation:

- `VpnService`
- a React Native native module
- the same JSON result contract

## Bridge goal

The business logic in the React Native app should stay platform-agnostic.

Only the platform adapter should know whether the backend is:

- Linux file-based bridge
- Windows helper/service
- Android `VpnService`
