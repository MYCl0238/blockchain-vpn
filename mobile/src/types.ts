export type TunnelCommand =
  | 'up'
  | 'down'
  | 'toggle'
  | 'restart'
  | 'status'
  | 'health'
  | 'public-ip'
  | 'is-enabled'
  | 'logs';

export type TunnelServiceState = 'active' | 'inactive';
export type TunnelEnabledState = 'enabled' | 'disabled';
export type TunnelState = 'up' | 'down';
export type TunnelRouteState = 'on' | 'off';

export type TunnelControlCode =
  | 'started'
  | 'stopped'
  | 'restarted'
  | 'toggled'
  | 'status'
  | 'healthy'
  | 'unhealthy'
  | 'public_ip'
  | 'enabled'
  | 'not_enabled'
  | 'busy'
  | 'not_supported'
  | 'permission_required'
  | 'bridge_unavailable'
  | 'unknown_error';

export interface TunnelControlState {
  service: TunnelServiceState;
  enabled: TunnelEnabledState;
  backend: string;
  tunnel: TunnelState;
  default_route: TunnelRouteState;
  tun_name: string;
  server: string;
  pid: string | null;
  default_route_line: string;
  server_route_line: string;
  public_ip: string | null;
}

export interface TunnelControlResult {
  ok: boolean;
  command: TunnelCommand | string;
  code: TunnelControlCode | string;
  message: string;
  state: TunnelControlState;
}

export interface NoiseStatus {
  bound: boolean;
  walletAddress: string | null;
  clientPublicKey: string | null;
  serverPublicKey: string | null;
  tunnelHost: string | null;
  tunnelPort: number | null;
  boundAt: string | null;
}

export interface NoiseBindInput {
  signature: string;
  walletAddress?: string;
  serverPublicKey: string;
  tunnelHost: string;
  tunnelPort: number;
}

export interface TunnelControlModule {
  up(): Promise<TunnelControlResult>;
  down(): Promise<TunnelControlResult>;
  toggle(): Promise<TunnelControlResult>;
  restart(): Promise<TunnelControlResult>;
  status(): Promise<TunnelControlResult>;
  health(): Promise<TunnelControlResult>;
  publicIp(): Promise<TunnelControlResult>;
  isEnabled(): Promise<TunnelControlResult>;
  logs(count?: number): Promise<string>;
  getNoiseStatus(): Promise<NoiseStatus>;
  bindNoise(input: NoiseBindInput): Promise<NoiseStatus>;
  unbindNoise(): Promise<NoiseStatus>;
}
