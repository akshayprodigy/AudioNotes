import React, { useEffect, useMemo, useState } from 'react';
import { NativeEventEmitter, NativeModules, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import ModelManager from '../native/NativeModelManager';
import AudioPipeline from '../native/NativeAudioPipeline';
import Icon, { type IconName } from '../components/Icon';
import Mascot from '../components/Mascot';
import { Button, Pop, ProgressBar, Raised, SoftButton, Txt } from '../components/ui';
import { db } from '../db/queries';
import { radius, s, sv, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Onboarding'>;

/**
 * What first run has to fetch, read from the catalog rather than listed here.
 *
 * The duplicate list this replaces had already drifted once — it named four models by id with
 * their own labels, so adding or renaming one in ModelCatalog silently left onboarding fetching
 * the wrong set. The catalog marks which models a meeting cannot be processed without; this asks
 * it, and shows the same wording Settings does.
 *
 * Diarization is in that required set deliberately. Excluding it kept first run at ~60 MB, but a
 * new user then recorded a meeting, got a transcript with no speaker labels, and had no way to
 * discover that "who said what" — a headline feature — sat behind a Settings screen they had
 * never opened.
 */
type Essential = { id: string; purpose: string; sizeBytes: number };

const BULLETS: { icon: IconName; title: string; body: string; tone: 'primary' | 'success' | 'warning' }[] = [
  {
    icon: 'shield',
    title: 'Private by design',
    body: 'Recording, transcription and notes all happen on your phone.',
    tone: 'primary',
  },
  {
    icon: 'mic',
    title: 'Record any meeting',
    body: 'Keeps listening with the screen off or while you use other apps.',
    tone: 'success',
  },
  {
    icon: 'users',
    title: 'Knows who spoke',
    body: 'Separates voices and pulls out decisions and action items.',
    tone: 'warning',
  },
];

export default function OnboardingScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<'intro' | 'downloading' | 'done' | 'failed'>('intro');
  const [pct, setPct] = useState(0);
  const [step, setStep] = useState(0);
  const [current, setCurrent] = useState('');
  const [essentials, setEssentials] = useState<Essential[]>([]);

  useEffect(() => {
    ModelManager.list()
      .then(r => setEssentials(JSON.parse(r).filter((m: any) => m.required)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const emitter = new NativeEventEmitter(NativeModules.ModelManager);
    const sub = emitter.addListener('onModelProgress', (e: { total: number; downloaded: number }) => {
      if (e.total > 0) setPct(Math.round((e.downloaded / e.total) * 100));
    });
    return () => sub.remove();
  }, []);

  const totalMb = Math.round(essentials.reduce((a, m) => a + m.sizeBytes, 0) / 1e6);

  const finish = async () => {
    await db.setSetting('onboarded', '1');
    navigation.replace('Library');
  };

  /**
   * A failure here has to be visible. The old version swallowed every error and went straight to
   * "All set", so a first run on a bad connection landed the user in an empty library with an app
   * that could record but never transcribe, and nothing anywhere saying why.
   */
  const downloadAll = async () => {
    setStatus('downloading');
    AudioPipeline.requestBatteryExemption().catch(() => {});
    for (let i = 0; i < essentials.length; i++) {
      setStep(i);
      setCurrent(essentials[i].purpose);
      setPct(0);
      try {
        await ModelManager.download(essentials[i].id);
      } catch {
        setStatus('failed');
        return;
      }
    }
    setStatus('done');
  };

  const pad = { paddingTop: insets.top + s(10), paddingBottom: insets.bottom + s(20) };

  if (status === 'downloading') {
    return (
      <View style={[st.root, st.center, pad]}>
        <Mascot mood="thinking" size={sv(140)} />
        <Txt variant="display" style={st.mt}>
          Getting things ready
        </Txt>
        <Txt variant="meta" color={colors.inkDim} style={st.sub}>
          Downloading once so everything works offline, forever.
        </Txt>
        <View style={st.progress}>
          <View style={st.progressHead}>
            <Txt variant="bodyStrong">{current}</Txt>
            <Txt variant="chip" color={colors.inkFaint}>
              {step + 1} of {essentials.length}
            </Txt>
          </View>
          <ProgressBar pct={pct} color={colors.primary} track={colors.cardAlt} />
        </View>
      </View>
    );
  }

  if (status === 'failed') {
    return (
      <View style={[st.root, st.center, pad]}>
        <Mascot mood="thinking" size={sv(140)} />
        <Txt variant="display" style={st.mt}>
          That download stopped
        </Txt>
        <Txt variant="body" color={colors.inkSoft} style={[st.sub, st.failBody]}>
          “{current}” could not be fetched. Check your connection and try again — anything already
          downloaded is kept, so it picks up where it left off.
        </Txt>
        <View style={st.failCta}>
          <Button label="Try again" icon="refresh" onPress={downloadAll} full />
          <View style={st.skipRow}>
            <SoftButton label="Continue without it" onPress={finish} />
          </View>
        </View>
      </View>
    );
  }

  if (status === 'done') {
    return (
      <View style={[st.root, st.center, pad]}>
        <Pop>
          <Mascot mood="happy" size={sv(150)} />
        </Pop>
        <Pop index={1} style={st.doneWrap}>
          <Txt variant="screenTitle" style={st.centerText}>
            All set
          </Txt>
          <Txt variant="body" color={colors.inkSoft} style={[st.centerText, st.sub]}>
            Pip is ready to sit in on your next meeting.
          </Txt>
          <View style={st.cta}>
            <Button label="Start recording" icon="mic" onPress={finish} full />
          </View>
        </Pop>
      </View>
    );
  }

  return (
    <View style={[st.root, pad]}>
      <View style={st.hero}>
        <Pop>
          <Mascot mood="idle" size={sv(132)} />
        </Pop>
        <Pop index={1}>
          <Txt variant="screenTitle" style={st.centerText}>
            AudioNotes
          </Txt>
          <Txt variant="label" color={colors.inkDim} style={st.centerText}>
            Your private meeting note-taker
          </Txt>
        </Pop>
      </View>

      <View style={st.list}>
        {BULLETS.map((b, i) => (
          <Pop key={b.title} index={i + 2}>
            <Raised edge={colors.line} fill={colors.card} rad={radius.card} depth={6}>
              <View style={st.bullet}>
                <View style={[st.bulletIcon, { backgroundColor: colors[`${b.tone}Soft`] }]}>
                  <Icon name={b.icon} size={s(20)} color={colors[b.tone]} strokeWidth={2.4} />
                </View>
                <View style={st.flex}>
                  <Txt variant="cardTitleSm">{b.title}</Txt>
                  <Txt variant="chip" color={colors.inkSoft} style={st.bulletBody}>
                    {b.body}
                  </Txt>
                </View>
              </View>
            </Raised>
          </Pop>
        ))}
      </View>

      <Pop index={5} style={st.footer}>
        <Button
          label={totalMb > 0 ? `Download the AI (${totalMb} MB)` : 'Download the AI'}
          icon="download"
          onPress={downloadAll}
          disabled={essentials.length === 0}
          full
        />
        {/* Said plainly, before the tap. The models are not in the app — shipping them would put
            it well past a gigabyte on the store — so this download is what makes AudioNotes work
            at all, and it is the only time the app touches the network. */}
        <Txt variant="chip" color={colors.inkFaint} style={[st.centerText, st.note]}>
          The speech models are not bundled in the app, so they download once — after that
          everything runs offline, and nothing you record is ever uploaded.
        </Txt>
        <View style={st.skipRow}>
          <SoftButton label="Later, from Settings" onPress={finish} />
        </View>
      </Pop>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas, paddingHorizontal: s(22) },
    flex: { flex: 1 },
    center: { alignItems: 'center', justifyContent: 'center' },
    centerText: { textAlign: 'center' },
    hero: { alignItems: 'center', paddingTop: s(10), gap: s(6) },
    list: { flex: 1, justifyContent: 'center', gap: s(12), marginTop: s(18) },
    bullet: { flexDirection: 'row', alignItems: 'flex-start', gap: s(14), padding: s(16) },
    bulletIcon: {
      width: s(44),
      height: s(44),
      borderRadius: radius.lg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    bulletBody: { marginTop: s(3) },
    footer: { gap: s(8) },
    note: { marginTop: s(4) },
    skipRow: { flexDirection: 'row' },
    mt: { marginTop: s(22) },
    sub: { marginTop: s(6), textAlign: 'center' },
    progress: { alignSelf: 'stretch', marginTop: s(30), gap: s(8) },
    progressHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    doneWrap: { alignSelf: 'stretch', marginTop: s(20) },
    cta: { marginTop: s(22) },
    failBody: { paddingHorizontal: s(10) },
    failCta: { alignSelf: 'stretch', marginTop: s(26), gap: s(10) },
  });
}
