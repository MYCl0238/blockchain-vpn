import {
  BlockchainVpnTunnel,
  configure,
  type TunnelControlResult,
} from '../lib/tunnel';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import AppButton from '../lib/ui/AppButton';

// On Linux/Tauri ("web") we drive a local control-plane daemon that
// spawns tun-client on this host. On Android/iOS the native bridge talks
// to the remote cloud control-plane over /vpn-api.
const IS_TAURI = Platform.OS === 'web';
const DEFAULT_CONFIG = {
  serverHost: '84.21.171.106',
  serverPort: 443,
  controlBaseUrl: IS_TAURI ? 'http://127.0.0.1:8787' : 'https://84.21.171.106/vpn-api',
  controlToken: IS_TAURI ? '' : 'ac4292c3af9cc9295daa4ff61e0dc4e082963e49ea10dd2b',
  mtu: 1380,
  routeDefault: true,
};

export default function DashboardScreen() {
  const router = useRouter();

  const [status, setStatus] = useState<TunnelControlResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await BlockchainVpnTunnel.status();
      setStatus(next);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await configure(DEFAULT_CONFIG);
      } catch (e: any) {
        setError(`configure failed: ${e?.message ?? e}`);
      }
      refreshStatus();
    })();
  }, [refreshStatus]);

  const connected = status?.state.tunnel === 'up';
  const isReady = !!status;

  useEffect(() => {
    if (!connected) {
      setSeconds(0);
      return;
    }
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [connected]);

  async function toggleVPN() {
    if (busy) return;

    setBusy(true);
    setError(null);
    try {
      const next = connected
        ? await BlockchainVpnTunnel.down()
        : await BlockchainVpnTunnel.up();
      setStatus(next);
      if (!next.ok) setError(`${next.code}: ${next.message}`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
      refreshStatus();
    }
  }

  function formatDuration(s: number) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m ${sec}s`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }

  return (
    <LinearGradient colors={['#020617', '#0f172a']} style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>VPN Dashboard</Text>
        <Text style={styles.subtitle}>Private secure mobile connection</Text>

        <View style={styles.statusRow}>
          <View style={[styles.dot, connected ? styles.online : styles.offline]} />
          <Text style={styles.statusText}>
            {connected ? 'Connected' : isReady ? 'Disconnected' : 'Loading...'}
          </Text>
        </View>

        <View style={styles.box}>
          <Text style={styles.label}>SERVER</Text>
          <Text style={styles.value}>{status?.state.server ?? '—'}</Text>
        </View>

        <View style={styles.box}>
          <Text style={styles.label}>TUNNEL IP</Text>
          <Text style={styles.value}>
            {(status?.state as any)?.tun_cidr || 'Not connected'}
          </Text>
        </View>

        <View style={styles.row}>
          <View style={styles.smallBox}>
            <Text style={styles.label}>CLIENT ID</Text>
            <Text style={styles.value} numberOfLines={1}>
              {(status?.state as any)?.client_id || '—'}
            </Text>
          </View>

          <View style={styles.smallBox}>
            <Text style={styles.label}>UPTIME</Text>
            <Text style={styles.value}>{formatDuration(seconds)}</Text>
          </View>
        </View>

        <AppButton
          title={connected ? 'Disconnect VPN' : 'Connect VPN'}
          type={connected ? 'danger' : 'success'}
          loading={busy}
          disabled={!isReady}
          onPress={toggleVPN}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <AppButton
          title="Secure Messages"
          type="muted"
          onPress={() => router.push('/messages')}
        />

        <AppButton title="Profile" type="primary" onPress={() => router.push('/profile')} />
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 16 },
  card: {
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderRadius: 22,
    padding: 16,
  },
  title: {
    color: 'white',
    fontSize: 22,
    fontWeight: '800',
    textAlign: 'center',
  },
  subtitle: {
    color: '#94a3b8',
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 14,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  online: { backgroundColor: '#22c55e' },
  offline: { backgroundColor: '#ef4444' },
  statusText: { color: 'white', fontWeight: '700', fontSize: 13 },
  box: {
    backgroundColor: '#1e293b',
    padding: 12,
    borderRadius: 12,
    marginBottom: 8,
  },
  row: { flexDirection: 'row', gap: 8 },
  smallBox: {
    flex: 1,
    backgroundColor: '#1e293b',
    padding: 12,
    borderRadius: 12,
    marginBottom: 8,
  },
  label: { color: '#94a3b8', fontSize: 10, letterSpacing: 0.6, fontWeight: '700' },
  value: { color: 'white', fontSize: 14, fontWeight: '700', marginTop: 4 },
  error: {
    color: '#f87171',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 8,
  },
});
