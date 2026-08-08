import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { radius, s, useTheme } from '../theme';
import { Txt } from './ui';
import { useRecordingStore } from '../state/recordingStore';
import type { RootStackParamList } from '../navigation/RootNavigator';

/** Just the slice of the navigation prop this bar needs — enough to accept the real screen prop. */
type Nav = Pick<NativeStackNavigationProp<RootStackParamList>, 'navigate'>;

function fmt(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

/** A slim bar shown on non-Record screens while a recording runs: tap to return, ■ to stop. */
export default function RecordingBar({ navigation }: { navigation: Nav }) {
  const { colors } = useTheme();
  const { isRecording, paused, startedAt, elapsedMs, stop } = useRecordingStore();
  const [elapsed, setElapsed] = useState(elapsedMs);

  // Live timer (nothing ticks the store's elapsedMs), derived the same way the Record screen does:
  // anchor to native's start time, and freeze on native's elapsed while paused. Declared before the
  // early return so the hook order stays stable whether or not a recording is running.
  useEffect(() => {
    if (!isRecording) {
      setElapsed(0);
      return;
    }
    if (paused) {
      setElapsed(elapsedMs);
      return;
    }
    const anchor = startedAt ?? Date.now();
    setElapsed(Date.now() - anchor);
    const id = setInterval(() => setElapsed(Date.now() - anchor), 500);
    return () => clearInterval(id);
  }, [isRecording, paused, startedAt, elapsedMs]);

  if (!isRecording) return null;

  const label = paused ? `Paused ${fmt(elapsed)}` : `Recording ${fmt(elapsed)}`;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, tap to open the recorder`}
      onPress={() => navigation.navigate('Record')}
      style={[styles.bar, { backgroundColor: colors.card, borderColor: colors.line }]}>
      <View style={[styles.dot, { backgroundColor: paused ? colors.inkFaint : colors.danger }]} />
      <Txt variant="bodyStrong" style={styles.flex} numberOfLines={1}>
        {label}
      </Txt>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Stop recording"
        hitSlop={12}
        onPress={() => {
          stop();
        }}
        style={[styles.stop, { backgroundColor: colors.danger }]}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: s(10),
    paddingHorizontal: s(16),
    paddingVertical: s(12),
    borderRadius: radius.lg,
    borderWidth: 1,
    marginHorizontal: s(16),
  },
  flex: { flex: 1 },
  dot: { width: s(10), height: s(10), borderRadius: s(5) },
  stop: { width: s(22), height: s(22), borderRadius: s(5) },
});
