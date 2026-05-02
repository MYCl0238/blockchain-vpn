import { callTunnel } from './nativeModule';
import type { TunnelControlModule } from './types';

export const BlockchainVpnTunnel: TunnelControlModule = {
  up: () => callTunnel('up'),
  down: () => callTunnel('down'),
  toggle: () => callTunnel('toggle'),
  restart: () => callTunnel('restart'),
  status: () => callTunnel('status'),
  health: () => callTunnel('health'),
  publicIp: () => callTunnel('publicIp'),
  isEnabled: () => callTunnel('isEnabled'),
  logs: (count?: number) => callTunnel('logs', count ?? 100),
};
