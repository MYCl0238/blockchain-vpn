# mobile

React Native bridge scaffold for the VPN client.

## Current state

Implemented now:

- typed JS/TS method surface in `src/`
- Android native module registration scaffold in `android/`
- shared method names aligned with `docs/CLIENT_CONTROL_API.md`

Not implemented yet:

- Linux native module binding to `blockchain-vpn-app-bridge`
- Windows native bridge wrapper
- Android `VpnService` implementation

## Intended JS usage

```ts
import { BlockchainVpnTunnel } from '@blockchain-vpn/mobile-bridge';

await BlockchainVpnTunnel.status();
await BlockchainVpnTunnel.up();
await BlockchainVpnTunnel.down();
```

## Platform backend mapping

- Linux: `blockchain-vpn-app-bridge`
- Windows: local tunnel controller / future bridge service
- Android: `VpnService`
