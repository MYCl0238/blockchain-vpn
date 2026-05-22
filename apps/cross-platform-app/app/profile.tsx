import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { BlockchainVpnTunnel, type NoiseStatus } from '../lib/tunnel';
// Wire-format note: native unbind goes through the Expo Module's
// unbindNoise() (defined in mobile/src/BlockchainVpnTunnel.ts); Tauri
// hits the loopback daemon directly via fetch().
import AppButton from '../lib/ui/AppButton';

const IS_TAURI = Platform.OS === 'web';

export default function ProfileScreen() {
  const router = useRouter();
  const [noise, setNoise] = useState<NoiseStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          const ns = await BlockchainVpnTunnel.getNoiseStatus();
          if (!cancelled) setNoise(ns);
        } catch (e: any) {
          if (!cancelled) setError(e?.message ?? String(e));
        }
      })();
      return () => {
        cancelled = true;
      };
    }, []),
  );

  async function unpair() {
    if (busy) return;
    setBusy(true);
    setError(null);

    // Tear the tunnel down first if it's up — otherwise the underlying
    // VpnService keeps running with the (now-stale) Noise keys.
    try {
      const st = await BlockchainVpnTunnel.status();
      if (st?.state?.tunnel === 'up') {
        await BlockchainVpnTunnel.down();
      }
    } catch {
      // best-effort
    }

    try {
      if (IS_TAURI) {
        const res = await fetch('http://127.0.0.1:8787/v1/noise/unbind', { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } else {
        // Cross-platform wrapper guarantees unbindNoise exists; native path
        // calls into the Kotlin Expo Module which deletes the on-disk key
        // and clears in-memory state.
        await BlockchainVpnTunnel.unbindNoise();
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setBusy(false);
      return;
    }

    // Navigation race fix: on Android (Fabric renderer) calling
    // router.replace() while we're still inside a busy=true state update
    // produces
    //   "addViewAt: failed to insert view ... already has a parent"
    // because the screen re-renders mid-unmount. We unblock all state
    // updates first (setBusy false on the *next* tick), then push the
    // navigation onto the frame after that, so the Profile tree has
    // settled before expo-router tears it down. router.back() also costs
    // less view-tree churn than .replace() since Dashboard is already in
    // the navigation stack.
    setBusy(false);
    setTimeout(() => {
      if (router.canGoBack()) {
        router.back();
      } else {
        router.replace('/dashboard');
      }
    }, 0);
  }

  const bound = !!noise?.bound;
  const avatarLetter = (noise?.walletAddress?.[2] || 'W').toUpperCase();

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{avatarLetter}</Text>
        </View>

        <Text style={styles.title}>Profile Details</Text>
        <Text style={styles.subtitle}>Wallet-bound Noise IK identity</Text>

        <View style={styles.infoBox}>
          <Text style={styles.label}>WALLET ADDRESS</Text>
          <Text style={styles.value} numberOfLines={1}>
            {bound ? noise!.walletAddress : 'Not paired'}
          </Text>
        </View>

        <View style={styles.infoBox}>
          <Text style={styles.label}>NOISE PUBLIC KEY</Text>
          <Text style={[styles.value, styles.mono]} numberOfLines={2}>
            {bound ? noise!.clientPublicKey : '—'}
          </Text>
        </View>

        <View style={styles.infoBox}>
          <Text style={styles.label}>SERVER NOISE KEY</Text>
          <Text style={[styles.value, styles.mono]} numberOfLines={2}>
            {bound ? noise!.serverPublicKey : '—'}
          </Text>
        </View>

        <View style={styles.infoBox}>
          <Text style={styles.label}>TUNNEL ENDPOINT</Text>
          <Text style={styles.value}>
            {bound ? `${noise!.tunnelHost}:${noise!.tunnelPort}` : '—'}
          </Text>
        </View>

        {bound && noise?.boundAt ? (
          <View style={styles.infoBox}>
            <Text style={styles.label}>PAIRED AT</Text>
            <Text style={styles.value}>{new Date(noise.boundAt).toLocaleString()}</Text>
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <AppButton
          title="Back to Dashboard"
          type="success"
          onPress={() => router.push('/dashboard')}
        />

        {bound ? (
          <AppButton
            title="Unpair Device"
            type="danger"
            loading={busy}
            onPress={unpair}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    justifyContent: 'center',
    padding: 16,
  },
  card: {
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderRadius: 24,
    padding: 18,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#7c3aed',
    alignSelf: 'center',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  avatarText: { color: 'white', fontSize: 26, fontWeight: '900' },
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
    marginTop: 4,
    marginBottom: 16,
  },
  infoBox: {
    backgroundColor: '#1e293b',
    padding: 12,
    borderRadius: 14,
    marginBottom: 8,
  },
  label: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  value: { color: 'white', fontSize: 13, fontWeight: '700' },
  mono: { fontFamily: Platform.select({ web: 'ui-monospace, monospace', default: undefined }), fontSize: 11 },
  error: {
    color: '#f87171',
    fontSize: 12,
    textAlign: 'center',
    marginVertical: 8,
  },
});
