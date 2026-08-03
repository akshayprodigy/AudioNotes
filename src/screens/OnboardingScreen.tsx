import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet, NativeEventEmitter, NativeModules } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import ModelManager from '../native/NativeModelManager';
import AudioPipeline from '../native/NativeAudioPipeline';
import Icon from '../components/Icon';
import { db } from '../db/queries';
import { useTheme, spacing, radius, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Onboarding'>;

const ESSENTIALS = ['silero-vad', 'whisper-base'];

export default function OnboardingScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [status, setStatus] = useState<'intro' | 'downloading' | 'done'>('intro');
  const [pct, setPct] = useState(0);
  const [current, setCurrent] = useState('');

  useEffect(() => {
    const emitter = new NativeEventEmitter(NativeModules.ModelManager);
    const sub = emitter.addListener('onModelProgress', (e: { total: number; downloaded: number }) => {
      if (e.total > 0) setPct(Math.round((e.downloaded / e.total) * 100));
    });
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
      for (const id of ESSENTIALS) {
        setCurrent(id === 'silero-vad' ? 'Speech detection' : 'Transcription model');
        setPct(0);
        await ModelManager.download(id);
      }
    } catch {}
    setStatus('done');
  };

  const bullets = [
    { icon: 'shield' as const, text: 'Everything runs on your phone. No account, no cloud.' },
    { icon: 'mic' as const, text: 'Records meetings and writes structured minutes.' },
    { icon: 'users' as const, text: 'Labels who spoke and tracks action items.' },
  ];

  return (
    <View style={s.root}>
      <View style={s.hero}>
        <View style={s.logo}><Icon name="mic" size={38} color={colors.onPrimary} /></View>
        <Text style={s.brand}>AudioNotes</Text>
        <Text style={s.tag}>On-device meeting notes</Text>
      </View>

      <View style={s.card}>
        {status === 'intro' && (
          <>
            {bullets.map((b, i) => (
              <View key={i} style={s.bullet}>
                <View style={s.bulletIcon}><Icon name={b.icon} size={18} color={colors.primary} /></View>
                <Text style={s.bulletText}>{b.text}</Text>
              </View>
            ))}
            <Text style={s.note}>
              To work offline it downloads two small models (~60 MB) once. Doing it now makes your
              first recording seamless.
            </Text>
            <Pressable style={s.primary} onPress={downloadAll}>
              <Icon name="download" size={18} color={colors.onPrimary} />
              <Text style={s.primaryText}>Download &amp; get started</Text>
            </Pressable>
            <Pressable style={s.ghost} onPress={finish}>
              <Text style={s.ghostText}>Skip for now</Text>
            </Pressable>
          </>
        )}

        {status === 'downloading' && (
          <>
            <Text style={s.dlTitle}>Downloading {current}</Text>
            <Text style={s.dlPct}>{pct}%</Text>
            <View style={s.barTrack}><View style={[s.barFill, { width: `${pct}%` }]} /></View>
            <Text style={s.note}>Keeping everything on your device…</Text>
          </>
        )}

        {status === 'done' && (
          <>
            <View style={s.doneIcon}><Icon name="check" size={30} color={colors.onPrimary} /></View>
            <Text style={s.dlTitle}>You're all set</Text>
            <Text style={s.note}>Everything is ready and runs offline.</Text>
            <Pressable style={s.primary} onPress={finish}>
              <Text style={s.primaryText}>Start</Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, justifyContent: 'center', padding: spacing.lg, backgroundColor: c.bg },
    hero: { alignItems: 'center', marginBottom: spacing.xl },
    logo: { width: 84, height: 84, borderRadius: 24, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md },
    brand: { color: c.text, fontSize: 28, fontWeight: '800' },
    tag: { color: c.textDim, fontSize: 14, marginTop: 4 },
    card: { backgroundColor: c.surface, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.md, borderWidth: 1, borderColor: c.border },
    bullet: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    bulletIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.primarySoft, alignItems: 'center', justifyContent: 'center' },
    bulletText: { flex: 1, color: c.text, fontSize: 14, lineHeight: 20 },
    note: { color: c.textDim, fontSize: 13, lineHeight: 19 },
    primary: { flexDirection: 'row', gap: spacing.sm, backgroundColor: c.primary, borderRadius: radius.md, padding: spacing.md, alignItems: 'center', justifyContent: 'center' },
    primaryText: { color: c.onPrimary, fontWeight: '800' },
    ghost: { padding: spacing.sm, alignItems: 'center' },
    ghostText: { color: c.textDim, fontWeight: '600' },
    dlTitle: { color: c.text, fontSize: 18, fontWeight: '800', textAlign: 'center' },
    dlPct: { color: c.primary, fontSize: 32, fontWeight: '800', textAlign: 'center' },
    barTrack: { height: 10, backgroundColor: c.surfaceAlt, borderRadius: 5, overflow: 'hidden' },
    barFill: { height: 10, backgroundColor: c.primary, borderRadius: 5 },
    doneIcon: { alignSelf: 'center', width: 60, height: 60, borderRadius: 30, backgroundColor: c.success, alignItems: 'center', justifyContent: 'center' },
  });
}
