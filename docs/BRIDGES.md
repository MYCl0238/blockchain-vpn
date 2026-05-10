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

Windows now has a real tunnel service, but not the full app-facing bridge daemon model used on Linux.

Implemented now:

- Windows tunnel client in `protocol/udp/cmd/tun-client`
- Windows SCM service supervisor in `protocol/udp/cmd/tun-service`
- PowerShell controller in `scripts/windows/blockchain-vpn-windows-client.ps1`

Missing still:

- Windows background app bridge for React Native integration
- a native adapter that hides Administrator/process details from React Native

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
