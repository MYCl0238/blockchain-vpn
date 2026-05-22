import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Platform, StyleSheet, Text, View } from 'react-native';

import { loadStoredUser } from '../lib/api';
import AppButton from '../lib/ui/AppButton';

export default function WelcomeScreen() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    (async () => {
      // On Tauri desktop, the wallet flow happens in the system browser
      // (no MetaMask in webkit2gtk). Skip the welcome/login dance and
      // route straight to the dashboard, which renders a Pair-this-device
      // screen when the local daemon has no Noise binding yet.
      if (Platform.OS === 'web') {
        router.replace('/dashboard');
        return;
      }

      const user = await loadStoredUser();
      if (user) {
        router.replace('/dashboard');
      } else {
        setChecking(false);
      }
    })();
  }, [router]);

  if (checking) {
    return (
      <LinearGradient
        colors={['#05070d', '#0f172a', '#111827']}
        style={styles.loadingContainer}>
        <ActivityIndicator color="#fff" />
      </LinearGradient>
    );
  }

  return (
    <LinearGradient
      colors={['#05070d', '#0f172a', '#111827']}
      style={styles.container}>
      <View pointerEvents="none" style={styles.glowOne} />
      <View pointerEvents="none" style={styles.glowTwo} />

      <View style={styles.card}>
        <Image
          source={require('../assets/images/mark.png')}
          style={styles.mark}
          resizeMode="contain"
        />
        <Text style={styles.title}>Blockchain VPN</Text>

        <Text style={styles.subtitle}>
          Mobile application for secure communication between remote business
          partners.
        </Text>

        <AppButton title="Secure Login" onPress={() => router.push('/login')} />
        <AppButton
          title="Create Account"
          onPress={() => router.push('/register')}
        />
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  glowOne: {
    position: 'absolute',
    width: 360,
    height: 360,
    borderRadius: 180,
    backgroundColor: 'rgba(124,58,237,0.22)',
    top: 80,
    left: -140,
  },
  glowTwo: {
    position: 'absolute',
    width: 330,
    height: 330,
    borderRadius: 165,
    backgroundColor: 'rgba(37,99,235,0.22)',
    bottom: 80,
    right: -120,
  },
  card: {
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderRadius: 28,
    padding: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  mark: {
    width: 84,
    height: 84,
    alignSelf: 'center',
    marginBottom: 10,
  },
  title: {
    color: 'white',
    fontSize: 22,
    fontWeight: '800',
    textAlign: 'center',
    letterSpacing: -0.3,
  },
  subtitle: {
    color: '#cbd5e1',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 18,
  },
});
