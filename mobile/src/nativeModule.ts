import { NativeModules, Platform } from 'react-native';
import type { TunnelControlModule, TunnelControlResult, TunnelControlState } from './types';

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

const nativeModule = NativeModules[MODULE_NAME] as TunnelControlModule | undefined;

function requireModule(command: string): TunnelControlModule {
  if (!nativeModule) {
    throw unavailableResult(
      command,
      `Native module ${MODULE_NAME} is not registered on ${Platform.OS}.`
    );
  }
  return nativeModule;
}

export async function callTunnel(command: keyof TunnelControlModule, ...args: unknown[]) {
  const module = requireModule(String(command));
  const fn = module[command];
  if (typeof fn !== 'function') {
    throw unavailableResult(String(command), `Native method ${String(command)} is not available.`);
  }
  return fn.apply(module, args as never);
}
