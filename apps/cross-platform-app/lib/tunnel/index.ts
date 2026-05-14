import { Platform } from 'react-native';

import type { TunnelConfig, TunnelControlResult } from './types';

export type { TunnelConfig, TunnelControlResult, TunnelControlState } from './types';

type Driver = {
  configure: (overrides: TunnelConfig) => Promise<TunnelControlResult>;
  up: () => Promise<TunnelControlResult>;
  down: () => Promise<TunnelControlResult>;
  status: () => Promise<TunnelControlResult>;
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
  };
}

const driver = loadDriver();

export const configure = driver.configure;
export const BlockchainVpnTunnel = {
  up: driver.up,
  down: driver.down,
  status: driver.status,
};
