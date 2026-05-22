import { Platform } from 'react-native';

import type { TunnelConfig, TunnelControlResult } from './types';

export type { TunnelConfig, TunnelControlResult, TunnelControlState } from './types';

// Noise types are web-only (Tauri desktop), but we re-export them here so
// callers can import in a platform-agnostic way; native builds will get
// stubs that throw / return defaults.
export type NoiseStatus = {
  bound: boolean;
  walletAddress: string | null;
  clientPublicKey: string | null;
  serverPublicKey: string | null;
  tunnelHost: string | null;
  tunnelPort: number | null;
  boundAt: string | null;
};

export type NoiseBindInput = {
  signature: string;
  walletAddress?: string;
  serverPublicKey: string;
  tunnelHost: string;
  tunnelPort: number;
};

type Driver = {
  configure: (overrides: TunnelConfig) => Promise<TunnelControlResult>;
  up: () => Promise<TunnelControlResult>;
  down: () => Promise<TunnelControlResult>;
  status: () => Promise<TunnelControlResult>;
  getNoiseStatus?: () => Promise<NoiseStatus>;
  bindNoise?: (input: NoiseBindInput) => Promise<NoiseStatus>;
  unbindNoise?: () => Promise<NoiseStatus>;
};

function loadDriver(): Driver {
  if (Platform.OS === 'web') {
    return require('./web') as Driver;
  }
  const native = require('@blockchain-vpn/mobile-bridge');
  return {
    configure: native.configure,
    up: native.BlockchainVpnTunnel.up,
    down: native.BlockchainVpnTunnel.down,
    status: native.BlockchainVpnTunnel.status,
    // The native Expo Module exposes the same Noise endpoints as the
    // desktop daemon's HTTP API, so the dashboard's pair screen works
    // unchanged on Android. Hex<->bytes conversion happens in the
    // Kotlin module; React only sees the JSON shape.
    getNoiseStatus: native.BlockchainVpnTunnel.getNoiseStatus,
    bindNoise: native.BlockchainVpnTunnel.bindNoise,
    unbindNoise: native.BlockchainVpnTunnel.unbindNoise,
  };
}

const driver = loadDriver();

export const configure = driver.configure;
export const BlockchainVpnTunnel = {
  up: driver.up,
  down: driver.down,
  status: driver.status,
  getNoiseStatus: driver.getNoiseStatus
    ? driver.getNoiseStatus
    : async (): Promise<NoiseStatus> => ({
        bound: false, walletAddress: null, clientPublicKey: null,
        serverPublicKey: null, tunnelHost: null, tunnelPort: null, boundAt: null,
      }),
  bindNoise: driver.bindNoise
    ? driver.bindNoise
    : async (): Promise<NoiseStatus> => {
        throw new Error('Noise pairing only supported on desktop Tauri build');
      },
  unbindNoise: driver.unbindNoise
    ? driver.unbindNoise
    : async (): Promise<NoiseStatus> => ({
        bound: false, walletAddress: null, clientPublicKey: null,
        serverPublicKey: null, tunnelHost: null, tunnelPort: null, boundAt: null,
      }),
};
