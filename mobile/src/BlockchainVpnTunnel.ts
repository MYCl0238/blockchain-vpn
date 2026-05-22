import { callTunnel } from './nativeModule';
import type {
  NoiseBindInput,
  NoiseStatus,
  TunnelControlModule,
} from './types';

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
  getNoiseStatus: (): Promise<NoiseStatus> => callTunnel('getNoiseStatus'),
  bindNoise: (input: NoiseBindInput): Promise<NoiseStatus> =>
    callTunnel('bindNoise', input),
  unbindNoise: (): Promise<NoiseStatus> => callTunnel('unbindNoise'),
};
