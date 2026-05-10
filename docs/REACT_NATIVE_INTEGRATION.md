# React Native Integration

This document defines what the React Native app should call.

## Rule

React Native should call a platform adapter with a stable method surface.

It should not directly call Linux root scripts, Windows process logic, or Android `VpnService` internals.

## JS API

The intended JS/TS surface is:

```ts
import { BlockchainVpnTunnel } from '@blockchain-vpn/mobile-bridge';

await BlockchainVpnTunnel.status();
await BlockchainVpnTunnel.health();
await BlockchainVpnTunnel.up();
await BlockchainVpnTunnel.down();
await BlockchainVpnTunnel.toggle();
await BlockchainVpnTunnel.restart();
await BlockchainVpnTunnel.publicIp();
await BlockchainVpnTunnel.isEnabled();
await BlockchainVpnTunnel.logs(100);
```

## Platform adapters

### Linux

Linux should invoke:

```bash
blockchain-vpn-app-bridge <command>
```

This is the current app-ready control path for Linux.

### Windows

Windows should invoke the local controller and return the same JSON contract.

Current implementation:

- `scripts/windows/blockchain-vpn-windows-client.ps1`
- `bin/blockchain-vpn-tun-client.exe`
- `bin/blockchain-vpn-tun-service.exe`

Current limitation:

- this is a service-backed CLI controller, not yet a dedicated app bridge daemon

### Android

Android should implement the same API through:

- `VpnService`
- a React Native native module

## Expected JSON

Each method should resolve to the shared shape in `CLIENT_CONTROL_API.md`.

The app should primarily inspect:

- `ok`
- `code`
- `message`
- `state`

## Current readiness

Ready now:

- Linux bridge contract
- Windows tunnel client plus test controller
- React Native package scaffold and method surface

Still pending:

- Linux native module implementation
- Windows app bridge wrapper
- Android `VpnService` implementation
