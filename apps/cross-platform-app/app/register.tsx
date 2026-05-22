import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Alert,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { apiRegister, formatKey } from '../lib/api';
import AppButton from '../lib/ui/AppButton';

export default function RegisterScreen() {
  const router = useRouter();
  // Desktop now uses MetaMask + Noise pairing on the webui (see /auth/
  // desktop-pairing). The email-based register is mobile-only legacy
  // surface; on Tauri we route the user to the dashboard's pair screen.
  useEffect(() => {
    if (Platform.OS === 'web') {
      router.replace('/dashboard');
    }
  }, [router]);

  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  async function register() {
    setBusy(true);
    try {
      const user = await apiRegister(email.trim() || null);
      Alert.alert(
        'Account created',
        `This is your access key. Please copy it somewhere safe:\n\n${formatKey(user.id)}`,
        [{ text: 'OK', onPress: () => router.replace('/dashboard') }],
      );
    } catch (e: any) {
      Alert.alert('Registration error', e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <LinearGradient
      colors={['#05070d', '#0f172a', '#111827']}
      style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>Create Account</Text>
        <Text style={styles.subtitle}>
          Email is optional; it is only used to help recover your account
          if you lose your access key.
        </Text>

        <TextInput
          placeholder="Email (optional)"
          placeholderTextColor="#94a3b8"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />

        <AppButton title="Register" type="primary" onPress={register} loading={busy} />
        <AppButton
          title="Back to Login"
          type="muted"
          onPress={() => router.replace('/login')}
        />
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24 },
  card: {
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderRadius: 30,
    padding: 26,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  title: {
    color: 'white',
    fontSize: 32,
    fontWeight: '900',
    textAlign: 'center',
  },
  subtitle: {
    color: '#cbd5e1',
    textAlign: 'center',
    marginTop: 10,
    marginBottom: 24,
    lineHeight: 22,
  },
  input: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    color: 'white',
    padding: 16,
    borderRadius: 18,
    marginBottom: 12,
    fontSize: 16,
  },
});
