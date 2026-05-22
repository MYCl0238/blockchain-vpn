// lib/tunnel/web.ts is only loaded on web (Tauri) builds, so we always go
// through plugin-http. The Tauri webview's own fetch stalls on HTTP to
// loopback (libsoup3 quirk on some webkit2gtk versions); plugin-http
// proxies through Rust reqwest instead, which has no such issue.
import { fetch as fetch } from '@tauri-apps/plugin-http';

import type {
  TunnelConfig,
  TunnelControlResult,
  TunnelControlState,
} from './types';

const DEFAULT_BASE = 'http://127.0.0.1:8787';

// Noise binding sourced from the user's wallet via the webui's
// /auth/desktop-pairing page. Once /v1/noise/bind has been called, the
// daemon owns the Noise key + tun-client spawn — the Tauri app just
// hits /v1/connect and /v1/disconnect.
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

let baseUrl = DEFAULT_BASE;
let token: string | null = null;
let lastConfig: TunnelConfig | null = null;

function authHeaders(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${baseUrl}${path}`;
  console.log('[tunnel] request', init?.method || 'GET', url);
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...authHeaders(),
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
  } catch (err: any) {
    console.error('[tunnel] fetch threw', url, err?.message || err);
    throw new Error(`fetch ${url} threw: ${err?.message || err}`);
  }
  console.log('[tunnel] response', res.status, url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${path} -> ${res.status} ${body || res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function emptyState(server: string): TunnelControlState {
  return {
    service: 'inactive',
    enabled: 'disabled',
    backend: 'linux',
    tunnel: 'down',
    default_route: 'off',
    tun_name: '',
    server,
    pid: null,
    default_route_line: '',
    server_route_line: '',
    public_ip: null,
  };
}

function mapStatusToResult(
  command: string,
  raw: any,
  ok: boolean,
  message: string,
): TunnelControlResult {
  const connected = !!raw && raw.connected === true;
  const server = `${lastConfig?.serverHost ?? ''}${
    lastConfig?.serverPort ? `:${lastConfig.serverPort}` : ''
  }`;
  const state: TunnelControlState = {
    ...emptyState(server),
    service: connected ? 'active' : 'inactive',
    enabled: connected ? 'enabled' : 'disabled',
    tunnel: connected ? 'up' : 'down',
    default_route: connected && lastConfig?.routeDefault ? 'on' : 'off',
    tun_name: raw?.tunName ?? raw?.tun_name ?? '',
    pid: raw?.pid != null ? String(raw.pid) : null,
    public_ip: raw?.publicIp ?? raw?.public_ip ?? null,
  };
  return { ok, command, code: connected ? 'started' : 'stopped', message, state };
}

export async function configure(overrides: TunnelConfig): Promise<TunnelControlResult> {
  lastConfig = { ...lastConfig, ...overrides };
  if (overrides.controlBaseUrl) baseUrl = overrides.controlBaseUrl;
  if (overrides.controlToken !== undefined) token = overrides.controlToken || null;
  return status();
}

export async function up(): Promise<TunnelControlResult> {
  // Daemon owns Noise key + tun-client args; no profile management here.
  await request('/v1/connect', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const raw = await request<any>('/v1/status');
  return mapStatusToResult('up', raw, true, 'connect requested');
}

export async function getNoiseStatus(): Promise<NoiseStatus> {
  return request<NoiseStatus>('/v1/noise/status');
}

export async function bindNoise(input: NoiseBindInput): Promise<NoiseStatus> {
  return request<NoiseStatus>('/v1/noise/bind', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function down(): Promise<TunnelControlResult> {
  await request('/v1/disconnect', { method: 'POST' });
  const raw = await request<any>('/v1/status');
  return mapStatusToResult('down', raw, true, 'disconnect requested');
}

export async function status(): Promise<TunnelControlResult> {
  try {
    const raw = await request<any>('/v1/status');
    return mapStatusToResult('status', raw, true, 'ok');
  } catch (e: any) {
    return mapStatusToResult('status', null, false, e?.message ?? String(e));
  }
}

export const BlockchainVpnTunnel = { up, down, status, getNoiseStatus, bindNoise };
