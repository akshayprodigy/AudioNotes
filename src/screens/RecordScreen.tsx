import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, PermissionsAndroid, Platform, Animated, NativeEventEmitter, NativeModules, AppState,
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
  const { isRecording, silenced, startedAt, start, stop, sync } = useRecordingStore();
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const level = useRef(new Animated.Value(0)).current;
  // The same signal as a plain number. Animated.Value has no synchronous public getter, and the
  // waveform needs to sample "the level right now" on its own clock to build its history buffer.
  const levelRef = useRef(0);

  useEffect(() => {
    const emitter = new NativeEventEmitter(NativeModules.AudioPipeline);
    const sub = emitter.addListener('onCaptureLevel', (e: { level: number }) => {
      const v = e.level ?? 0;
      levelRef.current = v;
      Animated.timing(level, { toValue: v, duration: 70, useNativeDriver: true }).start();
    });
    return () => sub.remove();
  }, [level]);

  // Native owns capture state, so re-read it on mount and every time the app comes back to the
  // foreground. A meeting may have been started from the floating bubble, or kept running while
  // the JS context was torn down; without this the screen would show an idle mic mid-meeting.
  useEffect(() => {
    sync();
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') sync();
    });
    return () => sub.remove();
  }, [sync]);

  useEffect(() => {
    if (!isRecording) {
      Animated.timing(level, { toValue: 0, duration: 200, useNativeDriver: true }).start();
      setElapsed(0);
      return;
    }
    // Anchored to startedAt (set from native's elapsed on sync) rather than a local t0, so the
    // timer stays truthful across backgrounding instead of restarting from zero.
    const anchor = startedAt ?? Date.now();
    setElapsed(Date.now() - anchor);
    const id = setInterval(() => setElapsed(Date.now() - anchor), 500);
    return () => clearInterval(id);
  }, [isRecording, startedAt, level]);

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
      <Text style={s.hint}>{isRecording ? 'Recording — tap to stop' : 'Tap the mic to start'}</Text>
      <MicVisualizer
        level={level}
        levelRef={levelRef}
        active={isRecording}
        colors={colors}
        onPress={onToggle}
      />
      {isRecording && (
        // The mic being silenced (a call, or another app taking it) is otherwise invisible: the
        // timer keeps counting and the file keeps growing, but only silence is captured. Say so.
        <View style={[s.livePill, silenced && s.warnPill]}>
          <View style={[s.liveDot, silenced && s.warnDot]} />
          <Text style={[s.liveText, silenced && s.warnText]}>
            {silenced ? 'MIC UNAVAILABLE · not capturing' : 'LIVE · on-device'}
          </Text>
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
    warnPill: { backgroundColor: c.warningSoft },
    warnDot: { backgroundColor: c.warning },
    warnText: { color: c.warning },
  });
}
