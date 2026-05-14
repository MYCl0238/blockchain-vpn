import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import {
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

const PLACEHOLDER_MESSAGES = [
  { id: '1', text: 'Secure channel initialized.', sender: 'system' },
  { id: '2', text: 'Partner identity verified successfully.', sender: 'system' },
  {
    id: '3',
    text: 'Mesajlaşma özelliği yakında etkinleştirilecek.',
    sender: 'system',
  },
];

export default function MessagesScreen() {
  const router = useRouter();

  return (
    <LinearGradient
      colors={['#05070d', '#0f172a', '#111827']}
      style={styles.container}>
      <Text style={styles.title}>Secure Messages</Text>
      <Text style={styles.subtitle}>
        Private communication between remote partners
      </Text>

      <View style={styles.banner}>
        <Text style={styles.bannerText}>Beta — gönderme şu an devre dışı</Text>
      </View>

      <FlatList
        data={PLACEHOLDER_MESSAGES}
        keyExtractor={(item) => item.id}
        style={styles.list}
        renderItem={({ item }) => (
          <View
            style={[
              styles.messageBox,
              item.sender === 'me' ? styles.myMessage : styles.systemMessage,
            ]}>
            <Text style={styles.messageText}>{item.text}</Text>
          </View>
        )}
      />

      <View style={styles.inputRow}>
        <TextInput
          editable={false}
          placeholder="Mesaj gönderme henüz aktif değil"
          placeholderTextColor="#64748b"
          style={[styles.input, styles.inputDisabled]}
        />

        <View style={[styles.sendButton, styles.sendDisabled]}>
          <Text style={styles.sendText}>Send</Text>
        </View>
      </View>

      <TouchableOpacity
        style={styles.backButton}
        onPress={() => router.push('/dashboard')}>
        <Text style={styles.backText}>Back to Dashboard</Text>
      </TouchableOpacity>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 22, paddingTop: 70 },
  title: {
    color: 'white',
    fontSize: 30,
    fontWeight: '900',
    textAlign: 'center',
  },
  subtitle: {
    color: '#94a3b8',
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 12,
  },
  banner: {
    backgroundColor: 'rgba(234,179,8,0.12)',
    borderColor: 'rgba(234,179,8,0.45)',
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    marginBottom: 12,
  },
  bannerText: { color: '#eab308', textAlign: 'center', fontWeight: '700' },
  list: { flex: 1, marginTop: 10 },
  messageBox: {
    padding: 14,
    borderRadius: 18,
    marginBottom: 12,
    maxWidth: '85%',
  },
  myMessage: { backgroundColor: '#7c3aed', alignSelf: 'flex-end' },
  systemMessage: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignSelf: 'flex-start',
  },
  messageText: { color: 'white', fontWeight: '600' },
  inputRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  input: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.08)',
    color: 'white',
    padding: 15,
    borderRadius: 18,
  },
  inputDisabled: { opacity: 0.5 },
  sendButton: {
    backgroundColor: '#2563eb',
    paddingVertical: 15,
    paddingHorizontal: 18,
    borderRadius: 18,
  },
  sendDisabled: { opacity: 0.4 },
  sendText: { color: 'white', fontWeight: '900' },
  backButton: {
    marginTop: 14,
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
  },
  backText: { color: 'white', fontWeight: '800' },
});
