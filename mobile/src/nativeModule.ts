import { Platform, requireOptionalNativeModule } from 'expo-modules-core';

import type {
  TunnelControlModule,
  TunnelControlResult,
  TunnelControlState,
} from './types';

const MODULE_NAME = 'BlockchainVpnTunnel';

const emptyState = (): TunnelControlState => ({
  service: 'inactive',
  enabled: 'disabled',
  backend: Platform.OS,
  tunnel: 'down',
  default_route: 'off',
  tun_name: '',
  server: '',
  pid: null,
  default_route_line: '',
  server_route_line: '',
  public_ip: null,
});

const unavailableResult = (command: string, message: string): TunnelControlResult => ({
  ok: false,
  command,
  code: 'bridge_unavailable',
  message,
  state: emptyState(),
});

type NativeMethodMap = Partial<
  Record<keyof TunnelControlModule | 'configure', (...args: any[]) => any>
>;

// The Android side ships an Expo Module under expo.modules.blockchainvpntunnel.
// iOS / web get an undefined module and fall through to unavailableResult.
const native = requireOptionalNativeModule<NativeMethodMap>(MODULE_NAME);

function ensure(command: string): NativeMethodMap {
  if (!native) {
    throw unavailableResult(
      command,
      `Native module ${MODULE_NAME} is not registered on ${Platform.OS}.`,
    );
  }
  return native;
}

export async function callTunnel(
  command: keyof TunnelControlModule,
  ...args: unknown[]
): Promise<any> {
  const module = ensure(String(command));
  const fn = module[command];
  if (typeof fn !== 'function') {
    throw unavailableResult(
      String(command),
      `Native method ${String(command)} is not available.`,
    );
  }
  return fn.apply(module, args as never);
}

export interface BlockchainVpnTunnelOverrides {
  serverHost?: string;
  serverPort?: number;
  controlBaseUrl?: string;
  controlToken?: string;
  clientId?: string;
  mtu?: number;
  routeDefault?: boolean;
}

export async function configure(
  overrides: BlockchainVpnTunnelOverrides,
): Promise<TunnelControlResult> {
  const module = ensure('configure');
  if (typeof module.configure !== 'function') {
    throw unavailableResult('configure', 'configure() is not exposed on this platform.');
  }
  return module.configure(overrides);
}
