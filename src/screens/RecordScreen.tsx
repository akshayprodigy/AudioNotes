import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  NativeEventEmitter,
  NativeModules,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { useRecordingStore } from '../state/recordingStore';
import { PipelineController } from '../pipeline/PipelineController';
import { db } from '../db/queries';
import MicVisualizer from '../components/MicVisualizer';
import Mascot from '../components/Mascot';
import Icon from '../components/Icon';
import { Button, Card, FadeIn, LiveDot, Txt } from '../components/ui';
import { radius, spacing, type, useTheme, type Colors } from '../theme';

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
  // null = still loading the stored answer. Rendering the gate before we know would flash it at
  // someone who already acknowledged it.
  const [consented, setConsented] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const levelRef = useRef(0);

  // Consent is acknowledged ONCE, not on every visit to this screen. Re-presenting the same
  // notice before every recording trains people to dismiss it without reading, which defeats
  // the point of showing it; the standing reminder below the button carries it from then on.
  useEffect(() => {
    db.getSetting('consentAck')
      .then(v => setConsented(v === '1'))
      .catch(() => setConsented(false));
  }, []);

  const acceptConsent = () => {
    setConsented(true);
    db.setSetting('consentAck', '1').catch(() => {});
  };

  useEffect(() => {
    const emitter = new NativeEventEmitter(NativeModules.AudioPipeline);
    const sub = emitter.addListener('onCaptureLevel', (e: { level: number }) => {
      levelRef.current = e.level ?? 0;
    });
    return () => sub.remove();
  }, []);

  // Native owns capture state, so re-read it on mount and every time the app comes back to the
  // foreground. A meeting may have been started from the floating bubble, or kept running while
  // the JS context was torn down; without this the screen would show an idle mic mid-meeting.
  useEffect(() => {
    sync();
    const sub = AppState.addEventListener('change', st => {
      if (st === 'active') sync();
    });
    return () => sub.remove();
  }, [sync]);

  useEffect(() => {
    if (!isRecording) {
      setElapsed(0);
      return;
    }
    // Anchored to startedAt (set from native's elapsed on sync) rather than a local t0, so the
    // timer stays truthful across backgrounding instead of restarting from zero.
    const anchor = startedAt ?? Date.now();
    setElapsed(Date.now() - anchor);
    const id = setInterval(() => setElapsed(Date.now() - anchor), 500);
    return () => clearInterval(id);
  }, [isRecording, startedAt]);

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

  if (consented === null) return <View style={s.root} />;

  if (!consented) {
    return (
      <View style={[s.root, s.center]}>
        <FadeIn>
          <Mascot mood="idle" size={132} style={s.mascotCenter} />
        </FadeIn>
        <FadeIn index={1} style={s.consentWrap}>
          <Card>
            <View style={s.shieldWrap}>
              <Icon name="shield" size={26} color={colors.primary} />
            </View>
            <Txt variant="title" style={s.gap}>
              Before you record
            </Txt>
            <Txt variant="body" color={colors.inkSoft} style={s.gapSm}>
              Everything stays on this device — no audio or text is ever sent anywhere. Please make
              sure everyone present consents to being recorded.
            </Txt>
            <View style={s.consentBtn}>
              <Button label="I understand" onPress={acceptConsent} full />
            </View>
          </Card>
        </FadeIn>
      </View>
    );
  }

  return (
    <View style={[s.root, s.center]}>
      <FadeIn>
        <Mascot mood={isRecording ? 'listening' : 'idle'} size={116} />
      </FadeIn>

      <Txt variant="display" style={s.timer}>
        {fmt(elapsed)}
      </Txt>
      <Txt variant="bodyStrong" color={colors.inkSoft} style={s.hint}>
        {isRecording ? 'Listening — tap to finish' : 'Tap to start recording'}
      </Txt>

      <MicVisualizer levelRef={levelRef} active={isRecording} onPress={onToggle} />

      {isRecording ? (
        // The mic being silenced (a call, or another app taking it) is otherwise invisible: the
        // timer keeps counting and the file keeps growing, but only silence is captured. Say so.
        <View style={[s.pill, silenced ? s.warnPill : s.livePill]}>
          <LiveDot color={silenced ? colors.warning : colors.danger} />
          <Txt variant="label" color={silenced ? colors.warning : colors.danger}>
            {silenced ? 'Mic unavailable · not capturing' : 'Recording · on-device'}
          </Txt>
        </View>
      ) : (
        <View style={s.privacy}>
          <Icon name="shield" size={14} color={colors.inkFaint} />
          <Txt variant="caption" color={colors.inkFaint}>
            Stays on this device. Make sure everyone consents.
          </Txt>
        </View>
      )}
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas, padding: spacing.xl },
    center: { alignItems: 'center', justifyContent: 'center' },
    mascotCenter: { alignSelf: 'center' },
    consentWrap: { width: '100%', marginTop: spacing.lg },
    shieldWrap: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: c.primarySoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    gap: { marginTop: spacing.md },
    gapSm: { marginTop: spacing.xs },
    consentBtn: { marginTop: spacing.lg },
    timer: {
      marginTop: spacing.lg,
      // Overrides the `display` variant Txt already applied — the timer is the largest thing on
      // the screen and wants more presence than the shared scale gives it.
      fontSize: 46,
      lineHeight: 54,
      // Tabular figures stop the timer jittering as digit widths change every second.
      fontVariant: ['tabular-nums'],
    },
    hint: { marginTop: spacing.xs, marginBottom: spacing.md },
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
    },
    livePill: { backgroundColor: c.dangerSoft },
    warnPill: { backgroundColor: c.warningSoft },
    privacy: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.xl },
  });
}
