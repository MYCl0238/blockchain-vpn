import { LinearGradient } from 'expo-linear-gradient';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
} from 'react-native';

type AppButtonType = 'primary' | 'success' | 'danger' | 'muted';

type AppButtonProps = {
  title: string;
  onPress?: () => void;
  loading?: boolean;
  disabled?: boolean;
  type?: AppButtonType;
};

const COLORS: Record<AppButtonType, [string, string]> = {
  primary: ['#7c3aed', '#2563eb'],
  success: ['#22c55e', '#15803d'],
  danger: ['#ef4444', '#991b1b'],
  muted: ['#475569', '#1e293b'],
};

export default function AppButton({
  title,
  onPress,
  loading = false,
  disabled = false,
  type = 'primary',
}: AppButtonProps) {
  const isInactive = loading || disabled;
  const colors = COLORS[isInactive ? 'muted' : type];

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      disabled={isInactive}>
      <LinearGradient
        colors={colors}
        style={[styles.button, isInactive && styles.disabled]}>
        <Text style={[styles.text, loading && styles.textHidden]}>{title}</Text>
        {loading ? (
          <ActivityIndicator color="white" style={styles.spinner} />
        ) : null}
      </LinearGradient>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    paddingVertical: 16,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
  disabled: {
    opacity: 0.6,
  },
  text: {
    color: 'white',
    fontSize: 16,
    fontWeight: '800',
  },
  textHidden: {
    opacity: 0,
  },
  spinner: {
    position: 'absolute',
  },
});
