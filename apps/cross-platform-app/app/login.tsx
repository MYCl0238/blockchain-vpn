import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Image,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { apiLogin } from '../lib/api';
import AppButton from '../lib/ui/AppButton';

export default function LoginScreen() {
  const router = useRouter();
  // The 16-char ID login is retired. Linux/Tauri desktop and mobile both
  // use wallet-based MetaMask auth via the local daemon's Noise pairing
  // (or the cloud control-plane on Android). Anyone landing here on a
  // current build is bounced to the dashboard, which renders the new
  // pairing flow when not yet set up.
  useEffect(() => {
    if (Platform.OS === 'web') {
      router.replace('/dashboard');
    }
  }, [router]);

  const [parts, setParts] = useState(['', '', '', '']);
  const [busy, setBusy] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const refs = [
    useRef<TextInput>(null),
    useRef<TextInput>(null),
    useRef<TextInput>(null),
    useRef<TextInput>(null),
  ];

  function handleChange(text: string, index: number) {
    const next = [...parts];
    next[index] = text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    setParts(next);
    if (next[index].length === 4 && index < 3) {
      refs[index + 1].current?.focus();
    }
  }

  async function submit() {
    const full = parts.join('');
    if (full.length !== 16) {
      Alert.alert('Missing key', 'Please enter all 16 characters of your access key.');
      return;
    }
    setBusy(true);
    try {
      await apiLogin(full);
      // Don't reset busy — this screen is about to unmount. Setting
      // state on an unmounting Fabric tree triggers
      // "child already has a parent" view-tree errors.
      router.replace('/dashboard');
    } catch (e: any) {
      setBusy(false);
      Alert.alert('Login error', e?.message ?? String(e));
    }
  }

  return (
    <LinearGradient colors={['#020617', '#0f172a']} style={styles.container}>
      <View style={styles.glow1} />
      <View style={styles.glow2} />

      <View style={styles.card}>
        <Image
          source={require('../assets/images/mark.png')}
          style={styles.mark}
          resizeMode="contain"
        />
        <Text style={styles.title}>Secure Login</Text>
        <Text style={styles.subtitle}>
          Enter the 16-character access key you generated on the web site or in the app.
        </Text>

        <View style={styles.row}>
          {parts.map((value, index) => (
            <TextInput
              key={index}
              ref={refs[index]}
              style={[styles.input, focusedIndex === index && styles.inputFocused]}
              maxLength={4}
              autoCapitalize="characters"
              autoCorrect={false}
              keyboardType="visible-password"
              selectionColor="#7c3aed"
              placeholderTextColor="rgba(255,255,255,0.25)"
              placeholder="••••"
              value={value}
              onChangeText={(text) => handleChange(text, index)}
              onFocus={() => setFocusedIndex(index)}
              onBlur={() => setFocusedIndex((prev) => (prev === index ? null : prev))}
            />
          ))}
        </View>

        <AppButton
          title="Connect"
          type="primary"
          onPress={submit}
          loading={busy}
        />
        <AppButton
          title="Back"
          type="muted"
          onPress={() => router.back()}
        />
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 20 },
  glow1: {
    position: 'absolute',
    width: 300,
    height: 300,
    backgroundColor: 'purple',
    borderRadius: 150,
    opacity: 0.2,
    top: 100,
    left: -100,
  },
  glow2: {
    position: 'absolute',
    width: 250,
    height: 250,
    backgroundColor: 'blue',
    borderRadius: 125,
    opacity: 0.2,
    bottom: 100,
    right: -100,
  },
  card: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 22,
    padding: 20,
  },
  mark: {
    width: 64,
    height: 64,
    alignSelf: 'center',
    marginBottom: 6,
  },
  title: {
    color: 'white',
    fontSize: 18,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 6,
  },
  subtitle: {
    color: '#94a3b8',
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 16,
    lineHeight: 17,
  },
  row: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 16,
    justifyContent: 'space-between',
  },
  input: {
    flex: 1,
    minWidth: 0,
    height: 52,
    backgroundColor: '#1e293b',
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.08)',
    color: 'white',
    fontSize: 16,
    letterSpacing: 1,
    textAlign: 'center',
    fontWeight: '700',
    paddingHorizontal: 4,
  },
  inputFocused: {
    borderColor: '#7c3aed',
    backgroundColor: '#27314a',
  },
});
