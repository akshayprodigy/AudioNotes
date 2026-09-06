import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  NativeEventEmitter,
  NativeModules,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { useRecordingStore } from '../state/recordingStore';
import { PipelineController } from '../pipeline/PipelineController';
import { db } from '../db/queries';
import MicVisualizer from '../components/MicVisualizer';
import LiveWaveform from '../components/LiveWaveform';
import Mascot from '../components/Mascot';
import Icon, { type IconName } from '../components/Icon';
import { Button, IconButton, Pop, Raised, SoftButton, Txt } from '../components/ui';
import { radius, s, sv, useTheme, type Colors } from '../theme';

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
  const sec = Math.floor(ms / 1000);
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

// `primaryDeep` rather than `primary`, and the two are the same value in light. These three run at
// 11pt on a tinted tile, which is the size at which the brand indigo stops being readable on a dark
// card — the deep variants exist for exactly this, foreground rather than fill.
const PROMISES: { icon: IconName; label: string; tone: 'primaryDeep' | 'success' | 'warning' }[] = [
  { icon: 'shield', label: 'No upload', tone: 'primaryDeep' },
  { icon: 'lock', label: 'Encrypted', tone: 'success' },
  { icon: 'list', label: 'You delete', tone: 'warning' },
];

export default function RecordScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { isRecording, silenced, paused, startedAt, start, stop, togglePause, sync } =
    useRecordingStore();
  const [consented, setConsented] = useState<boolean | null>(null);
  // The gate below tells people the phone will announce the recording out loud. That is only true
  // while the setting is on, and it can be turned off in Settings before a first recording ever
  // happens — so the promise is read, not assumed. A consent screen that overstates what the app
  // does is the one kind of copy this feature cannot ship.
  const [announceOn, setAnnounceOn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const levelRef = useRef(0);

  // Acknowledged once, not before every recording — repeating the same notice trains people to
  // dismiss it unread, which defeats the point. The standing line under the button carries it.
  useEffect(() => {
    db.getSetting('consentAck')
      .then(v => setConsented(v === '1'))
      .catch(() => setConsented(false));
    db.getSetting('announceRecording')
      .then(v => setAnnounceOn(v !== '0'))
      .catch(() => setAnnounceOn(true));
  }, []);

  useEffect(() => {
    const emitter = new NativeEventEmitter(NativeModules.AudioPipeline);
    const sub = emitter.addListener('onCaptureLevel', (e: { level: number }) => {
      levelRef.current = e.level ?? 0;
    });
    return () => sub.remove();
  }, []);

  // Native owns capture state: a meeting can be started from the floating bubble and can outlive
  // the JS context, so re-read on mount and on every resume.
  //
  // `onCaptureState` covers the case resume cannot: this screen is already open and visible when
  // Stop is pressed on the notification or Pause on the bubble. Without it the screen kept
  // counting a meeting that had already ended.
  useEffect(() => {
    sync();
    const emitter = new NativeEventEmitter(NativeModules.AudioPipeline);
    const state = emitter.addListener('onCaptureState', () => sync());
    const sub = AppState.addEventListener('change', a => {
      if (a === 'active') sync();
    });
    return () => {
      state.remove();
      sub.remove();
    };
  }, [sync]);

  useEffect(() => {
    if (!isRecording) {
      setElapsed(0);
      return;
    }
    if (paused) return; // held; startedAt is re-anchored from native on resume
    const anchor = startedAt ?? Date.now();
    setElapsed(Date.now() - anchor);
    const id = setInterval(() => setElapsed(Date.now() - anchor), 500);
    return () => clearInterval(id);
  }, [isRecording, paused, startedAt]);

  const onToggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (isRecording) {
        const meetingId = await stop();
        if (meetingId) {
          PipelineController.process(meetingId, { model: 'base' }).catch(() => {});
          // Navigate on the NEXT frame, not inside this handler.
          //
          // Stopping flips `isRecording`, which re-renders this screen (the meter unmounts, the
          // button morphs, the halo goes away) in the same commit that would also tear the screen
          // down. Fabric could not reconcile both at once and threw "addViewAt: view already has
          // a parent" under react-native-screens' ScreenContentWrapper on every single finish.
          // Letting the state change paint first, then navigating, keeps the two commits apart.
          //
          // reset rather than replace so Back lands on the library instead of re-entering the
          // recorder — which is the behaviour you want after finishing anyway.
          requestAnimationFrame(() => {
            navigation.reset({
              index: 1,
              routes: [{ name: 'Library' }, { name: 'Meeting', params: { meetingId } }],
            });
          });
        }
      } else if (await ensurePermissions()) {
        await start(null);
      }
    } finally {
      setBusy(false);
    }
  };

  if (consented === null) return <View style={st.root} />;

  // ---------- Consent ----------
  if (!consented) {
    return (
      <View style={[st.root, { paddingTop: insets.top + s(8), paddingBottom: insets.bottom + s(20) }]}>
        <View style={st.consentPad}>
          <IconButton icon="chevronLeft" label="Back" onPress={() => navigation.goBack()} />

          {/* Scrolls. The hero used to take flex:1 of a fixed-height column, so every sentence
              added to the card below stole height from the mascot until the back button clipped
              it — which is exactly what adding the announcement paragraph did. Content shorter
              than the screen still centres; anything taller scrolls instead of being cut off,
              which is also what saves this screen on a short phone. */}
          <ScrollView
            style={st.flex}
            contentContainerStyle={st.consentScroll}
            showsVerticalScrollIndicator={false}>
          <View style={st.consentHero}>
            <Mascot mood="happy" size={sv(150)} />
            <View style={st.onDevice}>
              <Txt variant="metaBlack" color={colors.primaryDeep}>
                100% on this device
              </Txt>
            </View>
          </View>

          <Pop>
            <Raised edge={colors.line} fill={colors.card} rad={radius.sheet} depth={8}>
              <View style={st.consentCard}>
                <View style={st.promiseRow}>
                  {PROMISES.map(p => (
                    <View key={p.label} style={st.promise}>
                      <Icon name={p.icon} size={s(20)} color={colors[p.tone]} strokeWidth={2.4} />
                      <Txt variant="chipSm" color={colors[p.tone]} style={st.promiseLabel}>
                        {p.label}
                      </Txt>
                    </View>
                  ))}
                </View>
                <Txt variant="display">Before you record</Txt>
                <Txt variant="body" color={colors.inkSoft} style={st.consentBody}>
                  Audio and text never leave this phone.
                </Txt>
                {/* Stated here because it is what the ROOM experiences, and because somebody who
                    does not expect their phone to speak will be startled by it in a meeting.
                    Reads the real setting rather than assuming the default — see announceOn. */}
                <Txt variant="body" color={colors.inkSoft} style={st.consentBody}>
                  {announceOn
                    ? 'When you tap record, the phone says "this meeting is being recorded" out ' +
                      'loud, and the recording keeps a copy of it being said — so the file itself ' +
                      'shows the room was told. You can turn that off in Settings.'
                    : 'The spoken announcement is switched off, so nothing is said out loud. ' +
                      'Tell the room yourself, and make sure everyone is okay with being recorded.'}
                </Txt>
                {/* The background-use disclosure, stated before the first recording rather than
                    buried in Settings. Play's Permissions policy requires continuous background
                    microphone use to be disclosed prominently and in-app, and separately from the
                    OS permission dialog — and it is the honest thing to say anyway, because this
                    app is designed to be used with the screen off and another app in front. */}
                <Txt variant="body" color={colors.inkSoft} style={st.consentBody}>
                  Recording keeps going while the screen is off and while you use other apps, and
                  can show a small floating control on top of them. You can stop it at any time
                  from that control or from the notification.
                </Txt>
                {/* For a room where talking over people is not practical, or where somebody
                    would rather see it than hear it. */}
                {/* A bordered row rather than a line of blue text: it is a second way through
                    this screen, and as text it read as a footnote to the paragraph above it. */}
                <Pressable
                  onPress={() => navigation.navigate('ConsentCard')}
                  accessibilityRole="button"
                  accessibilityLabel="Show the room a card instead"
                  style={st.consentLink}>
                  <Icon name="users" size={s(18)} color={colors.primaryDeep} strokeWidth={2.4} />
                  <Txt variant="sub" color={colors.primaryDeep} style={st.flex}>
                    Show the room a card instead
                  </Txt>
                  <Icon
                    name="chevronRight"
                    size={s(16)}
                    color={colors.primaryDeep}
                    strokeWidth={2.4}
                  />
                </Pressable>
                <View style={st.consentCta}>
                  <Button
                    label="Everyone's in — let's go"
                    onPress={() => {
                      setConsented(true);
                      db.setSetting('consentAck', '1').catch(() => {});
                    }}
                    full
                  />
                </View>
              </View>
            </Raised>
          </Pop>
          </ScrollView>
        </View>
      </View>
    );
  }

  // ---------- Recorder ----------
  const pill = !isRecording
    ? { label: '● ON DEVICE', color: colors.success, soft: colors.successSoft }
    : paused
    ? { label: '❙❙ PAUSED', color: colors.warning, soft: colors.warningSoft }
    : { label: '● RECORDING', color: colors.danger, soft: colors.dangerSoft };

  return (
    <View style={st.root}>
      {/* The design's warm radial wash behind the recorder, centred on the button. */}
      {isRecording ? (
        <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
          <Defs>
            <RadialGradient id="warm" cx="50%" cy="62%" rx="112%" ry="39%">
              <Stop offset="0" stopColor={colors.warmWash} />
              <Stop offset="1" stopColor={colors.canvas} />
            </RadialGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height="100%" fill="url(#warm)" />
        </Svg>
      ) : null}

      <View
        style={[
          st.recPad,
          { paddingTop: insets.top + s(10), paddingBottom: insets.bottom + s(20) },
        ]}>
        {/* Red is reserved for "the mic is live". Idle, this pill is a privacy assurance, not a
            status light — leaving it red made a screen that is recording nothing look like it is. */}
        <View style={st.topBar}>
          <View style={[st.statusPill, { backgroundColor: pill.soft }]}>
            <Txt variant="chip" color={pill.color}>
              {pill.label}
            </Txt>
          </View>
          <Txt variant="meta" color={colors.inkDim}>
            Meeting ·{' '}
            {new Date().toLocaleDateString(undefined, {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
            })}
          </Txt>
        </View>

        <View style={st.stage}>
          <Mascot
            mood={isRecording && !paused ? 'listening' : isRecording ? 'thinking' : 'idle'}
            size={sv(104)}
          />

          <Txt variant="clock" style={st.clock}>
            {fmt(elapsed)}
          </Txt>
          <Txt variant="bodyStrong" color={colors.inkDim} style={st.hint}>
            {!isRecording
              ? 'Tap to start recording'
              : paused
              ? 'Paused — tap resume to continue'
              : 'Listening — tap to finish'}
          </Txt>

          {/* Reserved band, toggled by opacity rather than unmounted: removing it would shift the
              button upward the instant recording starts, right under the user's finger. */}
          <View style={[st.meter, { opacity: isRecording && !paused ? 1 : 0 }]}>
            <LiveWaveform levelRef={levelRef} active={isRecording && !paused} height={70} />
          </View>

          <MicVisualizer active={isRecording} paused={paused} onPress={onToggle} size={148} />
        </View>

        <View style={st.footer}>
          {isRecording ? (
            <>
              <SoftButton
                label={paused ? 'Resume' : 'Pause'}
                icon={paused ? 'mic' : 'pause'}
                onPress={togglePause}
              />
              <SoftButton
                label={silenced ? 'Mic unavailable' : 'Stays on device'}
                icon={silenced ? 'alert' : 'shield'}
                tone={silenced ? colors.warning : colors.inkFaint}
              />
            </>
          ) : (
            <Pressable
              onPress={() => navigation.navigate('ConsentCard')}
              accessibilityRole="button"
              accessibilityLabel="Show the room a card"
              style={st.privacy}>
              <Icon name="shield" size={s(15)} color={colors.inkFaint} strokeWidth={2.4} />
              <Txt variant="chip" color={colors.inkFaint}>
                Stays on this device.
              </Txt>
              {/* The consent gate above says this once, before the first recording ever. This is
                  the only way back to the card for every meeting after that. */}
              <Txt variant="chip" color={colors.primaryDeep}>
                Show the room
              </Txt>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas },
    recPad: { flex: 1, paddingHorizontal: s(22) },
    consentPad: { flex: 1, paddingHorizontal: s(22) },

    topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    statusPill: { paddingHorizontal: s(13), paddingVertical: s(8), borderRadius: radius.pill },

    stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    clock: { marginTop: sv(14) },
    hint: { marginTop: s(4) },
    meter: { marginTop: sv(22), marginBottom: sv(6) },

    footer: { flexDirection: 'row', gap: s(10), minHeight: s(52) },
    privacy: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: s(6) },

    consentScroll: { flexGrow: 1, justifyContent: 'center', paddingBottom: s(8) },
    consentHero: {
      alignItems: 'center',
      justifyContent: 'center',
      gap: s(8),
      paddingVertical: sv(18),
    },
    onDevice: {
      backgroundColor: c.primarySoft,
      paddingHorizontal: s(14),
      paddingVertical: s(8),
      borderRadius: radius.pill,
    },
    consentCard: { padding: s(24) },
    promiseRow: { flexDirection: 'row', gap: s(10), marginBottom: s(16) },
    promise: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: s(12),
      borderRadius: radius.lg,
      backgroundColor: c.cardAlt,
    },
    promiseLabel: { marginTop: s(5) },
    flex: { flex: 1 },
    consentBody: { marginTop: s(8) },
    consentLink: {
      marginTop: s(16),
      flexDirection: 'row',
      alignItems: 'center',
      gap: s(10),
      paddingVertical: s(12),
      paddingHorizontal: s(14),
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: c.primary,
      backgroundColor: c.primarySoft,
    },
    consentCta: { marginTop: s(12) },
  });
}
