# Client Control API

This is the app-facing VPN control contract.

React Native code should target this contract instead of calling OS-specific commands directly.

## Commands

Supported command surface:

- `up`
- `down`
- `toggle`
- `restart`
- `status`
- `health`
- `public-ip`
- `is-enabled`
- `logs`

Linux currently exposes this through:

```bash
blockchain-vpn-app-bridge <command>
```

Windows exposes the same shape through:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\blockchain-vpn-windows-client.ps1 <command> -Json
```

## Result shape

All adapters should return JSON like:

```json
{
  "ok": true,
  "command": "status",
  "code": "status",
  "message": "tunnel status collected",
  "state": {
    "service": "active",
    "enabled": "disabled",
    "backend": "custom",
    "tunnel": "up",
    "default_route": "on",
    "tun_name": "bvpntun1",
    "server": "84.21.171.106:7001",
    "pid": "12345",
    "default_route_line": "default dev bvpntun1 scope link",
    "server_route_line": "84.21.171.106 via 192.168.1.1 dev wlan0",
    "public_ip": "84.21.171.106"
  }
}
```

Rules:

- `ok` is command success
- `code` is machine-readable and should stay stable
- `message` is human-readable
- `state.public_ip` may be `null`
- `pid` may be `null`
- callers should treat state-changing operations as serialized

## Linux mapping

Linux uses:

- `blockchain-vpn-app-bridge` as the unprivileged entrypoint
- `blockchain-vpn-app-bridge-service.py` as the root bridge daemon
- `blockchain-vpn-app-bridge-runner` as the privileged command runner
- `blockchain-vpn-tunnelctl` as the low-level controller
- `blockchain-vpn-target-client.service` for the long-lived tunnel lifecycle

## Windows mapping

Windows uses:

- `blockchain-vpn-windows-client.ps1` as the CLI controller
- `blockchain-vpn-tun-service.exe` as the Windows SCM service
- `blockchain-vpn-tun-client.exe` as the full-tunnel client

Current limitations:

- requires Administrator privileges for install/start/stop
- not yet exposed through a dedicated app bridge daemon

## Android mapping

Android will implement the same contract through:

- `VpnService`
- a React Native native module or TurboModule

The API contract should stay the same even though the internals differ.
