import React, { useEffect, useMemo, useState } from 'react';
import { NativeEventEmitter, NativeModules, StyleSheet, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import ModelManager from '../native/NativeModelManager';
import AudioPipeline from '../native/NativeAudioPipeline';
import Icon, { type IconName } from '../components/Icon';
import Mascot from '../components/Mascot';
import { Button, Card, FadeIn, ProgressBar, Txt } from '../components/ui';
import { db } from '../db/queries';
import { radius, spacing, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Onboarding'>;

/**
 * Everything needed for a complete first meeting, including speaker labels.
 *
 * Diarization used to be excluded to keep first run at ~60 MB, which meant a new user recorded a
 * meeting, got a transcript with no speaker labels, and had no way to know that "who said what" —
 * a headline feature — was sitting behind a Settings screen they had never opened. The extra
 * 34 MB buys a product that actually works out of the box.
 */
const ESSENTIALS: { id: string; label: string }[] = [
  { id: 'silero-vad', label: 'Finding speech' },
  { id: 'whisper-base', label: 'Transcription' },
  { id: 'diar-seg', label: 'Speaker detection' },
  { id: 'diar-emb', label: 'Telling voices apart' },
];

const BULLETS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'shield',
    title: 'Private by design',
    body: 'Recording, transcription and notes all happen on your phone. No account, no cloud.',
  },
  {
    icon: 'mic',
    title: 'Record any meeting',
    body: 'Keeps listening with the screen off or while you use other apps.',
  },
  {
    icon: 'users',
    title: 'Knows who spoke',
    body: 'Separates voices and pulls out decisions and action items automatically.',
  },
];

export default function OnboardingScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [status, setStatus] = useState<'intro' | 'downloading' | 'done'>('intro');
  const [pct, setPct] = useState(0);
  const [step, setStep] = useState(0);
  const [current, setCurrent] = useState('');

  useEffect(() => {
    const emitter = new NativeEventEmitter(NativeModules.ModelManager);
    const sub = emitter.addListener(
      'onModelProgress',
      (e: { total: number; downloaded: number }) => {
        if (e.total > 0) setPct(Math.round((e.downloaded / e.total) * 100));
      },
    );
    return () => sub.remove();
  }, []);

  const finish = async () => {
    await db.setSetting('onboarded', '1');
    navigation.replace('Library');
  };

  const downloadAll = async () => {
    setStatus('downloading');
    try {
      AudioPipeline.requestBatteryExemption().catch(() => {});
      for (let i = 0; i < ESSENTIALS.length; i++) {
        setStep(i);
        setCurrent(ESSENTIALS[i].label);
        setPct(0);
        await ModelManager.download(ESSENTIALS[i].id);
      }
    } catch {}
    setStatus('done');
  };

  if (status === 'downloading') {
    return (
      <View style={[s.root, s.center]}>
        <Mascot mood="thinking" size={140} />
        <Txt variant="title" style={s.mt}>
          Getting things ready
        </Txt>
        <Txt variant="body" color={colors.inkSoft} style={s.sub}>
          Downloading once so everything works offline, forever.
        </Txt>

        <View style={s.progressWrap}>
          <View style={s.progressHead}>
            <Txt variant="label">{current}</Txt>
            <Txt variant="caption" color={colors.inkFaint}>
              {step + 1} of {ESSENTIALS.length}
            </Txt>
          </View>
          <ProgressBar pct={pct} />
        </View>
      </View>
    );
  }

  if (status === 'done') {
    return (
      <View style={[s.root, s.center]}>
        <FadeIn>
          <Mascot mood="happy" size={150} />
        </FadeIn>
        <FadeIn index={1} style={s.doneWrap}>
          <Txt variant="display" style={s.centerText}>
            All set
          </Txt>
          <Txt variant="body" color={colors.inkSoft} style={[s.centerText, s.sub]}>
            Pip is ready to sit in on your next meeting.
          </Txt>
          <View style={s.cta}>
            <Button label="Start recording" icon="mic" onPress={finish} full />
          </View>
        </FadeIn>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <View style={s.hero}>
        <FadeIn>
          <Mascot mood="idle" size={132} />
        </FadeIn>
        <FadeIn index={1}>
          <Txt variant="display" style={s.centerText}>
            AudioNotes
          </Txt>
          <Txt variant="body" color={colors.inkSoft} style={s.centerText}>
            Your private meeting note-taker
          </Txt>
        </FadeIn>
      </View>

      <View style={s.list}>
        {BULLETS.map((b, i) => (
          <FadeIn key={b.title} index={i + 2} style={s.bulletWrap}>
            <Card>
              <View style={s.bullet}>
                <View style={s.bulletIcon}>
                  <Icon name={b.icon} size={20} color={colors.primary} />
                </View>
                <View style={s.bulletText}>
                  <Txt variant="heading">{b.title}</Txt>
                  <Txt variant="caption" color={colors.inkSoft} style={s.bulletBody}>
                    {b.body}
                  </Txt>
                </View>
              </View>
            </Card>
          </FadeIn>
        ))}
      </View>

      <FadeIn index={5} style={s.footer}>
        <Button label="Download & get started" icon="download" onPress={downloadAll} full />
        <Txt variant="caption" color={colors.inkFaint} style={[s.centerText, s.footNote]}>
          One-time 96 MB download · works offline afterwards
        </Txt>
        <Button label="Skip for now" variant="ghost" onPress={finish} full />
      </FadeIn>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas, padding: spacing.xl },
    center: { alignItems: 'center', justifyContent: 'center' },
    centerText: { textAlign: 'center' },
    hero: { alignItems: 'center', paddingTop: spacing.xxl, gap: spacing.sm },
    list: { flex: 1, justifyContent: 'center', gap: spacing.md, marginTop: spacing.xl },
    bulletWrap: {},
    bullet: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.lg },
    bulletIcon: {
      width: 44,
      height: 44,
      borderRadius: radius.md,
      backgroundColor: c.primarySoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    bulletText: { flex: 1 },
    bulletBody: { marginTop: 2 },
    footer: { gap: spacing.sm },
    footNote: { marginTop: spacing.xs },
    mt: { marginTop: spacing.xl },
    sub: { marginTop: spacing.xs, textAlign: 'center' },
    progressWrap: { alignSelf: 'stretch', marginTop: spacing.xxl, gap: spacing.sm },
    progressHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    doneWrap: { alignSelf: 'stretch', marginTop: spacing.xl },
    cta: { marginTop: spacing.xl },
  });
}
