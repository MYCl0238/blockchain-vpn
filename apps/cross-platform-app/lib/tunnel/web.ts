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
const DEFAULT_PROFILE_ID = 'mobile-default';
const DEFAULT_PROFILE_NAME = 'mobile-default';
const DEFAULT_PROFILE_COMMAND = 'blockchain-vpn-tun-client';

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

function buildTunClientArgs(): string[] {
  const host = lastConfig?.serverHost || '127.0.0.1';
  const port = lastConfig?.serverPort || 443;
  const mtu = lastConfig?.mtu || 1380;
  const args = ['-server', `${host}:${port}`, '-mtu', String(mtu)];
  if (lastConfig?.routeDefault !== false) args.push('-route-default');
  return args;
}

async function ensureProfile(): Promise<string> {
  // Always replace the profile so args track the current DEFAULT_CONFIG.
  // /v1/profiles is the source of truth for the spawn command; recreating
  // it on each connect is cheap and lets us forward routeDefault/mtu/etc.
  try {
    await request(`/v1/profiles/${DEFAULT_PROFILE_ID}`, { method: 'DELETE' });
  } catch (_) {
    // no-op: profile may not exist yet
  }
  await request('/v1/profiles', {
    method: 'POST',
    body: JSON.stringify({
      id: DEFAULT_PROFILE_ID,
      name: DEFAULT_PROFILE_NAME,
      command: DEFAULT_PROFILE_COMMAND,
      args: buildTunClientArgs(),
    }),
  });
  return DEFAULT_PROFILE_ID;
}

export async function configure(overrides: TunnelConfig): Promise<TunnelControlResult> {
  lastConfig = { ...lastConfig, ...overrides };
  if (overrides.controlBaseUrl) baseUrl = overrides.controlBaseUrl;
  if (overrides.controlToken !== undefined) token = overrides.controlToken || null;
  return status();
}

export async function up(): Promise<TunnelControlResult> {
  const profileId = await ensureProfile();
  await request('/v1/connect', {
    method: 'POST',
    body: JSON.stringify({ profileId }),
  });
  const raw = await request<any>('/v1/status');
  return mapStatusToResult('up', raw, true, 'connect requested');
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

export const BlockchainVpnTunnel = { up, down, status };
