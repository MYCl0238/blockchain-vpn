import {
  BlockchainVpnTunnel,
  configure,
  type NoiseStatus,
  type TunnelControlResult,
} from '../lib/tunnel';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Platform, StyleSheet, Text, TextInput, View } from 'react-native';

import AppButton from '../lib/ui/AppButton';

// On Linux/Tauri ("web") we drive a local control-plane daemon that
// spawns tun-client on this host. On Android/iOS the native bridge talks
// to the remote cloud control-plane over /vpn-api.
const IS_TAURI = Platform.OS === 'web';
const WEBUI_BASE = 'https://84.21.171.106';
const PAIRING_URL = `${WEBUI_BASE}/auth/desktop-pairing`;
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
  const [noise, setNoise] = useState<NoiseStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);

  const [signatureInput, setSignatureInput] = useState('');
  const [publicIp, setPublicIp] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await BlockchainVpnTunnel.status();
      setStatus(next);
      // Noise pairing state lives both on the desktop daemon AND on the
      // Android native module — both expose getNoiseStatus, so just call
      // it everywhere and let the platform stub do the right thing.
      try { setNoise(await BlockchainVpnTunnel.getNoiseStatus()); } catch {}
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

  // When the user navigates back from the Profile screen (e.g. after
  // tapping Unpair Device), the Dashboard re-mounts in focus state but
  // its `noise` value is still whatever it was before navigating. Force
  // a refresh on every focus so the pair screen reappears immediately
  // when the binding is gone.
  useFocusEffect(
    useCallback(() => {
      refreshStatus();
    }, [refreshStatus])
  );

  const connected = status?.state.tunnel === 'up';
  const isReady = !!status;
  // Both Tauri (loopback daemon) and Android (native module) expose a
  // pairing surface, so any platform that returns a NoiseStatus drives
  // the pair screen the same way.
  const needsPairing = noise !== null && !noise.bound;

  useEffect(() => {
    if (!connected) {
      setSeconds(0);
      setPublicIp(null);
      return;
    }
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [connected]);

  // Whenever we transition to connected, ask a public reflector for our
  // outbound IP. The tunnel is IPv4-only — if we hit a dual-stack host
  // the OS may prefer IPv6 and return the user's real address, which
  // makes the displayed "Public IP through tunnel" useless. We try a
  // small list of IPv4-only endpoints in order; first dotted-quad reply
  // wins. We poll for up to ~30s in case the tunnel is still settling.
  // Plugin-http is required on Tauri (libsoup3 quirks on webkit2gtk).
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    // Tauri's webview needs plugin-http to bypass libsoup3; React Native
    // (Android) just uses the platform fetch, which goes through the
    // VPN's TUN device exactly like every other socket the app opens.
    const fetcher: typeof globalThis.fetch =
      IS_TAURI ? (tauriFetch as any) : globalThis.fetch;
    const endpoints = [
      'https://ifconfig.me/ip',
      'https://api4.ipify.org',
      'https://ipv4.icanhazip.com',
      'https://v4.ident.me',
    ];
    (async () => {
      for (let attempt = 0; attempt < 30 && !cancelled; attempt++) {
        for (const url of endpoints) {
          if (cancelled) return;
          try {
            const r = await fetcher(url, { method: 'GET' });
            if (r.ok) {
              const t = (await r.text()).trim();
              if (!cancelled && /^\d{1,3}(\.\d{1,3}){3}$/.test(t)) {
                setPublicIp(t);
                return;
              }
            }
          } catch {
            // tunnel may still be settling — try the next endpoint
          }
        }
        await new Promise((res) => setTimeout(res, 1000));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connected]);

  async function toggleVPN() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const wasConnected = connected;
    try {
      const next = wasConnected
        ? await BlockchainVpnTunnel.down()
        : await BlockchainVpnTunnel.up();
      setStatus(next);
      if (!next.ok) setError(`${next.code}: ${next.message}`);

      // The daemon returns immediately after SIGTERM-ing the tun-client
      // (or spawning it on connect); the child's actual exit / handshake
      // completion lands a beat later. Poll /v1/status until the tunnel
      // state matches what the user just asked for, so the button label
      // and connection indicator track reality without manual refresh.
      const targetUp = !wasConnected;
      for (let i = 0; i < 20; i++) {
        await new Promise((res) => setTimeout(res, 250));
        try {
          const polled = await BlockchainVpnTunnel.status();
          setStatus(polled);
          if ((polled.state.tunnel === 'up') === targetUp) break;
        } catch {
          // network blip during the transition — try again
        }
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
      refreshStatus();
    }
  }

  const [linkCopied, setLinkCopied] = useState(false);

  async function openPairingPage() {
    try {
      await Linking.openURL(PAIRING_URL);
    } catch (e: any) {
      setError(e?.message ?? 'could not open browser');
    }
  }

  async function copyPairingLink() {
    // Hyprland/Wayland sessions without xdg-utils sometimes silently fail
    // Linking.openURL — give the user a clipboard fallback. navigator
    // .clipboard is available in the Tauri webview; if that's missing
    // too (older webkit2gtk) the URL is shown in plain text below the
    // buttons so it can be selected and copied by hand.
    try {
      const clip: any = (globalThis as any).navigator?.clipboard;
      if (clip?.writeText) {
        await clip.writeText(PAIRING_URL);
        setLinkCopied(true);
        setTimeout(() => setLinkCopied(false), 2500);
      } else {
        setError('Clipboard not available — copy the URL below by hand.');
      }
    } catch (e: any) {
      setError(e?.message ?? 'clipboard write failed');
    }
  }

  async function submitPairing() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const parsed = parsePairingInput(signatureInput);
      const result = await BlockchainVpnTunnel.bindNoise(parsed);
      setNoise(result);
      setSignatureInput('');
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
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

  if (needsPairing) {
    return (
      <LinearGradient colors={['#020617', '#0f172a']} style={styles.container}>
        <View style={styles.card}>
          <Text style={styles.title}>Pair this device</Text>
          <Text style={styles.subtitle}>
            Sign in on the web UI with your wallet, then paste the Noise
            signature below to enable encrypted tunnel on this device.
          </Text>

          <AppButton
            title="Open pairing page in browser"
            type="wallet"
            onPress={openPairingPage}
          />

          <AppButton
            title={linkCopied ? 'Copied — paste in browser' : 'Copy pairing link'}
            type="muted"
            onPress={copyPairingLink}
          />

          <Text style={styles.label}>PAIRING URL</Text>
          <Text selectable style={styles.urlText}>
            {PAIRING_URL}
          </Text>

          <Text style={styles.label}>SIGNATURE (0x...)</Text>
          <TextInput
            style={styles.input}
            value={signatureInput}
            onChangeText={setSignatureInput}
            placeholder="paste your wallet's Noise identity signature"
            placeholderTextColor="#64748b"
            multiline
            numberOfLines={4}
            autoCorrect={false}
            autoCapitalize="none"
          />

          <AppButton
            title="Pair device"
            type="success"
            loading={busy}
            disabled={!signatureInput.trim()}
            onPress={submitPairing}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>
      </LinearGradient>
    );
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
          <Text style={styles.value}>
            {noise?.tunnelHost && noise?.tunnelPort
              ? `${noise.tunnelHost}:${noise.tunnelPort}`
              : status?.state.server ?? '—'}
          </Text>
        </View>

        {connected ? (
          <View style={styles.box}>
            <Text style={styles.label}>PUBLIC IP (THROUGH TUNNEL)</Text>
            <Text style={styles.value}>
              {publicIp ? publicIp : 'Detecting…'}
            </Text>
          </View>
        ) : null}

        {noise?.bound ? (
          <View style={styles.box}>
            <Text style={styles.label}>NOISE IDENTITY</Text>
            <Text style={styles.value} numberOfLines={1}>
              {shortHex(noise.clientPublicKey)}
            </Text>
          </View>
        ) : null}

        <View style={styles.row}>
          <View style={styles.smallBox}>
            <Text style={styles.label}>WALLET</Text>
            <Text style={styles.value} numberOfLines={1}>
              {shortAddr(noise?.walletAddress) || '—'}
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

        <AppButton title="Profile" type="primary" onPress={() => router.push('/profile')} />
      </View>
    </LinearGradient>
  );
}

// Parses either a raw "0x..." signature OR a JSON blob with all four
// pairing fields (signature/serverPublicKey/tunnelHost/tunnelPort) — lets
// users either paste just the signature (we'll fetch the server pubkey
// later) or a complete pairing block from a downloaded JSON.
function parsePairingInput(s: string) {
  const trimmed = s.trim();
  if (trimmed.startsWith('{')) {
    const obj = JSON.parse(trimmed);
    if (!obj.signature) throw new Error('JSON must include signature');
    if (!obj.serverPublicKey) throw new Error('JSON must include serverPublicKey');
    if (!obj.tunnelHost) throw new Error('JSON must include tunnelHost');
    if (!obj.tunnelPort) throw new Error('JSON must include tunnelPort');
    return obj;
  }
  // Raw signature: assume our defaults for server/tunnel; user must have
  // already bound their wallet server-side via the pairing page.
  return {
    signature: trimmed,
    serverPublicKey: '6592db7fa9210032d456cb6364d029affbb4a22f920f7d65358013737f83905d',
    tunnelHost: '84.21.171.106',
    tunnelPort: 443,
  };
}

function shortHex(h: string | null | undefined): string {
  if (!h) return '—';
  return h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}
function shortAddr(a: string | null | undefined): string {
  if (!a) return '—';
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
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
  label: { color: '#94a3b8', fontSize: 10, letterSpacing: 0.6, fontWeight: '700', marginTop: 6 },
  value: { color: 'white', fontSize: 14, fontWeight: '700', marginTop: 4 },
  input: {
    backgroundColor: '#0f172a',
    color: 'white',
    fontFamily: Platform.select({ web: 'ui-monospace, monospace', default: undefined }),
    fontSize: 12,
    borderRadius: 12,
    padding: 12,
    marginTop: 4,
    marginBottom: 8,
    minHeight: 100,
    textAlignVertical: 'top',
  },
  urlText: {
    color: '#cbd5e1',
    fontFamily: Platform.select({ web: 'ui-monospace, monospace', default: undefined }),
    fontSize: 11,
    backgroundColor: '#0f172a',
    borderRadius: 10,
    padding: 10,
    marginTop: 4,
    marginBottom: 8,
  },
  error: {
    color: '#f87171',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 8,
  },
});
