import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  clearStoredUser,
  formatKey,
  loadStoredUser,
  type StoredUser,
} from '../lib/api';
import AppButton from '../lib/ui/AppButton';

export default function ProfileScreen() {
  const router = useRouter();
  const [user, setUser] = useState<StoredUser | null>(null);

  useFocusEffect(
    useCallback(() => {
      (async () => {
        const saved = await loadStoredUser();
        setUser(saved);
      })();
    }, []),
  );

  async function logout() {
    await clearStoredUser();
    router.replace('/');
  }

  const avatarLetter = (user?.recovery_email?.[0] || user?.id?.[0] || 'U').toUpperCase();

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{avatarLetter}</Text>
        </View>

        <Text style={styles.title}>Profile Details</Text>
        <Text style={styles.subtitle}>Secure mobile identity</Text>

        <View style={styles.infoBox}>
          <Text style={styles.label}>RECOVERY EMAIL</Text>
          <Text style={styles.value}>{user?.recovery_email || 'Belirtilmedi'}</Text>
        </View>

        <View style={styles.infoBox}>
          <Text style={styles.label}>PRIVATE KEY</Text>
          <Text style={styles.value}>{user ? formatKey(user.id) : 'No key'}</Text>
        </View>

        <AppButton
          title="Go to Dashboard"
          type="success"
          onPress={() => router.push('/dashboard')}
        />

        <AppButton
          title="Secure Messages"
          type="muted"
          onPress={() => router.push('/messages')}
        />

        <AppButton title="Logout" type="danger" onPress={logout} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#eef2f7',
    justifyContent: 'center',
    padding: 16,
  },
  card: {
    backgroundColor: 'white',
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
    color: '#111827',
    fontSize: 22,
    fontWeight: '800',
    textAlign: 'center',
  },
  subtitle: {
    color: '#64748b',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 16,
  },
  infoBox: {
    backgroundColor: '#f8fafc',
    padding: 12,
    borderRadius: 14,
    marginBottom: 10,
  },
  label: {
    color: '#64748b',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  value: { color: '#111827', fontSize: 13, fontWeight: '700' },
});
