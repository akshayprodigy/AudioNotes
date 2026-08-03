import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, PermissionsAndroid, Platform, Animated, NativeEventEmitter, NativeModules,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { useRecordingStore } from '../state/recordingStore';
import { PipelineController } from '../pipeline/PipelineController';
import MicVisualizer from '../components/MicVisualizer';
import Icon from '../components/Icon';
import { useTheme, spacing, radius, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Record'>;

async function ensurePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const wanted = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
  if (PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS) {
    wanted.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  }
  const res = await PermissionsAndroid.requestMultiple(wanted);
  return res[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] === 'granted';
}

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export default function RecordScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const { isRecording, start, stop } = useRecordingStore();
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const level = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const emitter = new NativeEventEmitter(NativeModules.AudioPipeline);
    const sub = emitter.addListener('onCaptureLevel', (e: { level: number }) => {
      Animated.timing(level, { toValue: e.level ?? 0, duration: 70, useNativeDriver: true }).start();
    });
    return () => sub.remove();
  }, [level]);

  useEffect(() => {
    if (!isRecording) {
      Animated.timing(level, { toValue: 0, duration: 200, useNativeDriver: true }).start();
      setElapsed(0);
      return;
    }
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - t0), 500);
    return () => clearInterval(id);
  }, [isRecording, level]);

  const onToggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (isRecording) {
        const meetingId = await stop();
        if (meetingId) {
          PipelineController.process(meetingId, { model: 'base', useLLM: true }).catch(() => {});
          navigation.replace('Meeting', { meetingId });
        }
      } else if (await ensurePermissions()) {
        await start(null);
      }
    } finally {
      setBusy(false);
    }
  };

  if (!consented) {
    return (
      <View style={s.root}>
        <View style={s.card}>
          <View style={s.shieldWrap}>
            <Icon name="shield" size={28} color={colors.primary} />
          </View>
          <Text style={s.h}>Before you record</Text>
          <Text style={s.p}>
            Everything stays on this device — no audio or text is ever sent anywhere. Please make sure
            everyone present consents to being recorded.
          </Text>
          <Pressable style={s.primary} onPress={() => setConsented(true)}>
            <Text style={s.primaryText}>I understand</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <Text style={s.timer}>{fmt(elapsed)}</Text>
      <Text style={s.hint}>{isRecording ? 'Recording — tap the mic to stop' : 'Tap the mic to start'}</Text>
      <MicVisualizer level={level} active={isRecording} colors={colors} onPress={onToggle} />
      {isRecording && (
        <View style={s.livePill}>
          <View style={s.liveDot} />
          <Text style={s.liveText}>LIVE · on-device</Text>
        </View>
      )}
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, backgroundColor: c.bg },
    card: { backgroundColor: c.surface, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.md, borderWidth: 1, borderColor: c.border },
    shieldWrap: { width: 52, height: 52, borderRadius: 26, backgroundColor: c.primarySoft, alignItems: 'center', justifyContent: 'center' },
    h: { color: c.text, fontSize: 20, fontWeight: '800' },
    p: { color: c.textDim, fontSize: 14, lineHeight: 21 },
    primary: { backgroundColor: c.primary, borderRadius: radius.md, padding: spacing.md, alignItems: 'center' },
    primaryText: { color: c.onPrimary, fontWeight: '800' },
    timer: { color: c.text, fontSize: 44, fontWeight: '200', letterSpacing: 2, fontVariant: ['tabular-nums'] },
    hint: { color: c.textDim, fontSize: 14, marginBottom: spacing.xl, marginTop: spacing.xs },
    livePill: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xl, backgroundColor: c.dangerSoft, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.pill },
    liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.danger },
    liveText: { color: c.danger, fontWeight: '700', fontSize: 12, letterSpacing: 0.5 },
  });
}
