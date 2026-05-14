import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

export const API_BASE_URL = 'https://84.21.171.106';

// Route fetches through plugin-http when running inside Tauri so the webview
// network stack (webkit2gtk + libsoup3) doesn't silently fail. React Native
// (Android/iOS) keeps its native fetch. We import statically and dispatch
// at runtime so Metro actually bundles the plugin instead of tree-shaking it.
const httpFetch: typeof globalThis.fetch =
  Platform.OS === 'web' ? (tauriFetch as any) : globalThis.fetch;

export type StoredUser = {
  id: string;
  recovery_email: string | null;
};

const USER_STORAGE_KEY = 'vpn.user';

export async function loadStoredUser(): Promise<StoredUser | null> {
  const raw = await AsyncStorage.getItem(USER_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredUser;
  } catch {
    return null;
  }
}

export async function saveStoredUser(user: StoredUser): Promise<void> {
  await AsyncStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
}

export async function clearStoredUser(): Promise<void> {
  await AsyncStorage.removeItem(USER_STORAGE_KEY);
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await httpFetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Bad response (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || payload?.ok === false) {
    throw new Error(payload?.error || `HTTP ${res.status}`);
  }
  return payload as T;
}

type AuthResponse = {
  ok: true;
  user: StoredUser;
  deviceToken?: string;
};

export async function apiRegister(email: string | null): Promise<StoredUser> {
  const data = await postJson<AuthResponse>('/api/auth/register', {
    email: email || undefined,
  });
  await saveStoredUser(data.user);
  return data.user;
}

export async function apiLogin(id: string): Promise<StoredUser> {
  const data = await postJson<AuthResponse>('/api/auth/login', {
    id: id.replace(/-/g, '').toUpperCase(),
  });
  await saveStoredUser(data.user);
  return data.user;
}

export function formatKey(id: string): string {
  const clean = id.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  return clean.match(/.{1,4}/g)?.join('-') ?? clean;
}
